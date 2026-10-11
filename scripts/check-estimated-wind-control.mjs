import assert from 'node:assert/strict';

// Runs inside check:wind-estimator's Vite loader; no additional dependency.
export async function checkEstimatedWindControl(server, params, table, estimatorConfig) {
  const { createCoordinatedScenario } = await server.ssrLoadModule('/src/sim/coordinated.ts');
  const { runSimulationScenario } = await server.ssrLoadModule('/src/sim/simulation.ts');
  const { selectControllerWind } = await server.ssrLoadModule('/src/sim/windEstimator.ts');
  const rpm = 30 / Math.PI;
  const rms = values => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
  const cases = [
    ...[3, 5, 8, 10.5, 12, 18, 25].map(speed => ({ name: `steady ${speed}`, duration: 600,
      wind: { mode: 'constant', meanWindSpeedMps: speed } })),
    ...[[9, 4], [13, -4]].map(([speed, amplitude]) => ({ name: `${speed} crossing`, duration: 1600,
      wind: { mode: 'gust', meanWindSpeedMps: speed, gustStartTimeSec: 100, gustDurationSec: 800, gustAmplitudeMps: amplitude } })),
    ...[8, 10.5, 18].map(speed => ({ name: `turbulence ${speed}`, duration: 600,
      wind: { mode: 'turbulent', meanWindSpeedMps: speed, turbulenceIntensity: .06, seed: 12345, lowPassTimeConstantSec: 2.5 } })),
  ];
  const metrics = [];
  for (const test of cases) {
    const { scenario } = createCoordinatedScenario({ name: test.name, totalTimeS: test.duration, dtS: .02,
      wind: test.wind, params, aeroTable: table });
    scenario.windEstimator = estimatorConfig;
    const reference = runSimulationScenario({ scenario, params, aeroTable: table });
    scenario.controllerWindSource = 'coflex-estimate';
    const result = runSimulationScenario({ scenario, params, aeroTable: table });
    const samples = result.samples;
    let maxRpm = 0, minRpm = Infinity;
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i], previous = samples[i - 1], d = s.controllerDiagnostics;
      assert.equal(s.windSpeedMps, reference.samples[i].windSpeedMps, 'Both sources use identical disturbances');
      assert.equal(d.torque.windInputSource, 'coflex-estimate');
      assert.equal(d.torque.controlWindMps, previous.windEstimator?.estimatedWindMps ?? estimatorConfig.initialWindMps,
        'Feedback must use the preceding estimate, never true wind');
      assert(Object.values(s).filter(v => typeof v === 'number').every(Number.isFinite));
      assert(Object.values(s.windEstimator).filter(v => typeof v === 'number').every(Number.isFinite));
      assert(s.generatorTorqueNm >= 0 && s.generatorTorqueNm <= params.maxGeneratorTorqueNm);
      assert(Math.abs(s.generatorTorqueNm - previous.generatorTorqueNm) <= 2e6 * .02 + 1e-6);
      assert(s.collectivePitchRad >= 0 && s.collectivePitchRad <= Math.PI / 6 + 1e-12);
      assert(Math.abs(s.collectivePitchRad - previous.collectivePitchRad) <= 5 * Math.PI / 180 * .02 + 1e-10);
      minRpm = Math.min(minRpm, s.rotorSpeedRadPerSec * rpm);
      maxRpm = Math.max(maxRpm, s.rotorSpeedRadPerSec * rpm);
    }
    const tail = samples.filter(s => s.timeS > test.duration - 100);
    const speedRms = rms(tail.map(s => (s.rotorSpeedRadPerSec - s.controllerDiagnostics.smoother.baseTorqueSpeedRefRadPerSec) * rpm));
    const windRms = rms(samples.filter(s => s.timeS > 100).map(s => s.windEstimator.estimatedWindMps - s.effectiveWindSpeedMps));
    const tailWindRms = rms(tail.map(s => s.windEstimator.estimatedWindMps - s.effectiveWindSpeedMps));
    metrics.push({ case: test.name, minRpm, maxRpm, tailSpeedRmsRpm: speedRms, windRmsMps: windRms, tailWindRms });
    assert(minRpm > 2 && maxRpm < 1.2 * params.ratedRotorSpeedRadPerSec * rpm, `${test.name}: speed envelope ${minRpm}–${maxRpm}`);
    assert(speedRms < (test.wind.mode === 'turbulent' ? .6 : .03), `${test.name}: speed tracking RMS ${speedRms}`);
    assert(windRms < .7, `${test.name}: wind RMSE ${windRms}`);
    if (test.wind.mode === 'constant') assert(tailWindRms < .03, `${test.name}: final wind error ${tailWindRms}`);
    if (test.name.includes('crossing')) {
      const middle = samples[Math.round(500 / .02)]; // Peak/dip of the 800 s gust.
      assert((middle.collectivePitchRad > .02) === (test.wind.gustAmplitudeMps > 0),
        `${test.name}: opposite-region pitch ${middle.collectivePitchRad}`);
      assert(samples.some((s, i) => s.generatorTorqueNm !== reference.samples[i].generatorTorqueNm), 'Selection affects controller outputs');
    }
  }
  console.table(metrics);
  // Check the most demanding slow crossing with half the integration interval.
  const crossing = cases.find(test => test.name === '9 crossing');
  const finer = createCoordinatedScenario({ name: 'half-dt crossing', totalTimeS: crossing.duration, dtS: .01,
    wind: crossing.wind, params, aeroTable: table }).scenario;
  const finerResult = runSimulationScenario({ scenario: { ...finer, windEstimator: estimatorConfig,
    controllerWindSource: 'coflex-estimate' }, params, aeroTable: table });
  const finerPeak = finerResult.samples.reduce((peak, s) => Math.max(peak, s.rotorSpeedRadPerSec * rpm), 0);
  assert(Math.abs(finerPeak - metrics.find(m => m.case === '9 crossing').maxRpm) < .01);
  console.log(`PASS: half-dt crossing peak ${finerPeak.toFixed(4)} rpm (within 0.01 rpm)`);

  const { createCoordinatedControllerConfig } = await server.ssrLoadModule('/src/sim/coordinated.ts');
  const { createCoordinatedControllerState } = await server.ssrLoadModule('/src/sim/coordinatedController.ts');
  const { OperatingSupervisor } = await server.ssrLoadModule('/src/sim/operatingSupervisor.ts');
  const { createOperatingSequence, requestStartup, stepOperatingSequence } = await server.ssrLoadModule('/src/sim/operatingSequence.ts');
  const { createWindEstimatorState, stepWindEstimator } = await server.ssrLoadModule('/src/sim/windEstimator.ts');
  for (const windMps of [3, 18]) {
    const config = createCoordinatedControllerConfig(params, table);
    let run = { supervisor: new OperatingSupervisor(), sequence: requestStartup(createOperatingSequence()),
      state: { timeS: 0, rotorSpeedRadPerSec: 0, rotorAzimuthRad: 0, platformPitchRad: 0, platformPitchRateRadPerSec: 0 },
      control: { collectivePitchRad: Math.PI / 2, generatorTorqueNm: 0 },
      controllerState: createCoordinatedControllerState(config, { windMps, rotorSpeedRadPerSec: 0, pitchRad: 0, torqueNm: 0 }),
      environment: { windSpeedMps: windMps, wavePitchMomentNm: 0 }, params, config, table, dtS: .02 };
    let estimate = createWindEstimatorState(0, estimatorConfig, table), generatingS = 0, peakRpm = 0;
    while (run.state.timeS < 1500 && generatingS < 300) {
      const wasGenerating = run.sequence.phase === 'generating';
      const priorWind = estimate.estimatedWindMps;
      run = { ...run, ...stepOperatingSequence({ ...run, generatingWindMps: priorWind, windInputSource: 'coflex-estimate' }) };
      const observation = stepWindEstimator(estimate, { rotorSpeedRadPerSec: run.state.rotorSpeedRadPerSec,
        pitchRad: run.control.collectivePitchRad, generatorTorqueNm: run.control.generatorTorqueNm,
        generating: wasGenerating && run.sequence.phase === 'generating' }, estimatorConfig, table, .02);
      estimate = observation.state;
      assert(!['shutting-down', 'parked'].includes(run.sequence.phase), 'No unintended shutdown after startup request');
      if (run.sequence.phase === 'generating') {
        generatingS += .02;
        peakRpm = Math.max(peakRpm, run.state.rotorSpeedRadPerSec * rpm);
        if (wasGenerating) assert.equal(run.diagnostics.torque.controlWindMps, priorWind);
      } else assert.equal(observation.diagnostics.status, 'held');
    }
    assert(generatingS >= 300 && peakRpm < 1.2 * params.ratedRotorSpeedRadPerSec * rpm);
    console.log(`PASS: estimated-wind startup at ${windMps} m/s and 300 s generating; peak ${peakRpm.toFixed(3)} rpm`);
  }
  assert.throws(() => selectControllerWind('coflex-estimate', 18, undefined), /unavailable/);
  assert.equal(selectControllerWind('coflex-estimate', 18, { estimatedWindMps: 7 }), 7);
  assert.throws(() => selectControllerWind('coflex-estimate', 18, { estimatedWindMps: NaN }), /invalid/);
  console.log('PASS: estimated-wind closed loop, 12 operating/disturbance cases, causal feedback, actuator limits and no truth fallback');
}
