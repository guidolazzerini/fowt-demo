import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(await readFile(new URL('../public/iea15mw-aero-v1.json', import.meta.url)));
try {
  const { DEFAULT_TUNABLE_PARAMETERS: params } = await server.ssrLoadModule('/src/sim/defaults.ts');
  const { loadAeroTable } = await server.ssrLoadModule('/src/sim/aero.ts');
  const { createCoordinatedScenario, createCoordinatedControllerConfig } = await server.ssrLoadModule('/src/sim/coordinated.ts');
  const { runSimulationScenario } = await server.ssrLoadModule('/src/sim/simulation.ts');
  const { createWindEstimatorConfig } = await server.ssrLoadModule('/src/sim/windEstimator.ts');
  const { suggestedGainsAtWind, DEMO_GAIN_SCHEDULE } = await server.ssrLoadModule('/src/sim/gainSchedule.ts');
  const table = await loadAeroTable(params.aero.filePath), RPM = 30 / Math.PI;
  assert.deepEqual(suggestedGainsAtWind(-1), suggestedGainsAtWind(3));
  assert.deepEqual(suggestedGainsAtWind(30), suggestedGainsAtWind(25));
  assert.throws(() => suggestedGainsAtWind(NaN));
  assert.equal(suggestedGainsAtWind(13).platformPitchRateGainS, 16);
  for (const row of DEMO_GAIN_SCHEDULE) {
    assert(Math.abs(suggestedGainsAtWind(row.windMps).pitchKi - row.pitchKi) < 1e-14);
    const left = suggestedGainsAtWind(row.windMps - 1e-8), right = suggestedGainsAtWind(row.windMps + 1e-8);
    assert(Math.abs(left.platformPitchRateGainS - right.platformPitchRateGainS) < 1e-6);
  }
  const cases = [
    ...[3, 5, 8, 10, 12, 14, 16, 18, 22, 25].map(speed => ({ name: `recovery ${speed}`, duration: 900,
      perturb: true, wind: { mode: 'constant', meanWindSpeedMps: speed } })),
    ...[[9, 4], [13, -4]].map(([speed, amplitude]) => ({ name: `crossing ${speed}`, duration: 1600,
      wind: { mode: 'gust', meanWindSpeedMps: speed, gustAmplitudeMps: amplitude, gustStartTimeSec: 100, gustDurationSec: 800 } })),
    ...[8, 10.5, 12, 18, 22].flatMap(speed => [12345, 67890].map(seed => ({ name: `TI6 ${speed} seed${seed}`, duration: 600,
      wind: { mode: 'turbulent', meanWindSpeedMps: speed, turbulenceIntensity: .06, seed, lowPassTimeConstantSec: 2.5 } }))),
  ];
  const rows = [];
  for (const source of ['simulated-free-stream', 'coflex-estimate']) {
    for (const test of cases) {
      const config = createCoordinatedControllerConfig(params, table);
      config.gainScheduling = true;
      const { scenario, operatingPoint } = createCoordinatedScenario({ name: test.name, totalTimeS: test.duration,
        dtS: .02, wind: test.wind, params, aeroTable: table, config });
      if (test.perturb) {
        scenario.initialState.rotorSpeedRadPerSec *= 1.05;
        scenario.initialState.platformPitchRad += Math.PI / 180;
      }
      scenario.controllerWindSource = source;
      scenario.windEstimator = createWindEstimatorConfig(params);
      const before = JSON.stringify(config);
      const { samples } = runSimulationScenario({ scenario, params, aeroTable: table });
      assert.equal(JSON.stringify(config), before, 'Scheduling never rewrites saved manual configuration');
      let peakRpm = 0, tailError = 0, tailPlatformRate = 0, pitchTravel = 0, platformSquare = 0;
      for (let i = 1; i < samples.length; i++) {
        const s = samples[i], previous = samples[i - 1], d = s.controllerDiagnostics;
        assert(Object.values(s).filter(v => typeof v === 'number').every(Number.isFinite));
        assert(d.gains.scheduled);
        const expected = suggestedGainsAtWind(d.torque.filteredWindMps);
        assert.equal(d.gains.pitchKpS, expected.pitchKpS);
        assert.equal(d.gains.floatingGainS, expected.platformPitchRateGainS);
        assert(Math.abs(d.pitch.proportionalTermRad - expected.pitchKpS * d.pitch.rotorSpeedErrorRadPerSec) < 1e-12);
        assert(Math.abs(d.pitch.floatingPitchTermRad - expected.platformPitchRateGainS * d.pitch.filteredPlatformPitchRateRadPerSec) < 1e-12);
        if (previous.controllerDiagnostics) {
          const priorI = previous.controllerDiagnostics.pitch.integralTermRad;
          const nextI = priorI + (d.pitch.integralWasHeld ? 0 : d.gains.pitchKi * d.pitch.rotorSpeedErrorRadPerSec * .02);
          assert(Math.abs(d.pitch.integralTermRad - nextI) < 1e-11, 'Scheduled Ki preserves integral output, then integrates once');
        }
        assert(s.generatorTorqueNm >= 0 && s.generatorTorqueNm <= config.torque.maxTorqueNm + 1e-7);
        assert(Math.abs(s.generatorTorqueNm - previous.generatorTorqueNm) <= config.torque.maxTorqueRateNmPerSec * .02 + 1e-7);
        assert(s.collectivePitchRad >= 0 && s.collectivePitchRad <= config.pitch.maxPitchRad);
        assert(Math.abs(s.collectivePitchRad - previous.collectivePitchRad) <= config.pitch.maxPitchRateRadPerSec * .02 + 1e-12);
        peakRpm = Math.max(peakRpm, s.rotorSpeedRadPerSec * RPM);
        pitchTravel += Math.abs(s.collectivePitchRad - previous.collectivePitchRad) * 180 / Math.PI;
        platformSquare += ((s.platformPitchRad - operatingPoint.platformPitchRad) * 180 / Math.PI) ** 2;
        if (s.timeS > test.duration - 100) {
          tailError = Math.max(tailError, Math.abs(s.rotorSpeedRadPerSec - d.smoother.baseTorqueSpeedRefRadPerSec) * RPM);
          tailPlatformRate = Math.max(tailPlatformRate, Math.abs(s.platformPitchRateRadPerSec) * 180 / Math.PI);
        }
      }
      assert(peakRpm < 1.2 * params.ratedRotorSpeedRadPerSec * RPM, `${source} ${test.name}: overspeed ${peakRpm}`);
      if (test.wind.mode !== 'turbulent') {
        assert(tailError < .005, `${source} ${test.name}: recovery ${tailError}`);
        assert(tailPlatformRate < .002, `${source} ${test.name}: residual platform rate ${tailPlatformRate}`);
      }
      rows.push({ source, case: test.name, peakRpm, tailError, platformRmsDeg: Math.sqrt(platformSquare / (samples.length - 1)), pitchTravelDeg: pitchTravel });
    }
  }
  console.table(rows);
  console.log(`PASS: ${rows.length} scheduled-gain scenarios, both wind sources, integral continuity, interpolation and actuator limits`);
  // Compare the same disturbances, not two different random realizations.
  const comparisons = [];
  for (const source of ['simulated-free-stream', 'coflex-estimate']) {
    for (const speed of [10.5, 12, 18]) {
      let referenceWind;
      for (const scheduled of [false, true]) {
        const config = createCoordinatedControllerConfig(params, table);
        config.gainScheduling = scheduled;
        const { scenario, operatingPoint } = createCoordinatedScenario({ name: 'gain comparison', totalTimeS: 600, dtS: .02,
          wind: { mode: 'turbulent', meanWindSpeedMps: speed, turbulenceIntensity: .06, seed: 12345, lowPassTimeConstantSec: 2.5 },
          params, aeroTable: table, config });
        scenario.controllerWindSource = source;
        scenario.windEstimator = createWindEstimatorConfig(params);
        const { samples } = runSimulationScenario({ scenario, params, aeroTable: table });
        const wind = samples.map(s => s.windSpeedMps);
        if (referenceWind) assert.deepEqual(wind, referenceWind);
        referenceWind = wind;
        const tail = samples.filter(s => s.timeS > 100);
        const rms = values => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
        comparisons.push({ source, speed, scheduled,
          speedRmsRpm: rms(tail.map(s => (s.rotorSpeedRadPerSec - s.controllerDiagnostics.smoother.baseTorqueSpeedRefRadPerSec) * RPM)),
          platformRmsDeg: rms(tail.map(s => (s.platformPitchRad - operatingPoint.platformPitchRad) * 180 / Math.PI)),
          pitchTravelDeg: tail.slice(1).reduce((sum, s, i) => sum + Math.abs(s.collectivePitchRad - tail[i].collectivePitchRad) * 180 / Math.PI, 0) });
      }
    }
  }
  console.table(comparisons);
  console.log('PASS: 12 manual/scheduled comparisons use identical turbulence; metrics are trade-offs, not an optimality claim');
  const crossing = cases.find(test => test.name === 'crossing 9');
  const fineConfig = createCoordinatedControllerConfig(params, table);
  fineConfig.gainScheduling = true;
  const fine = createCoordinatedScenario({ name: 'half-dt scheduled crossing', totalTimeS: crossing.duration, dtS: .01,
    wind: crossing.wind, params, aeroTable: table, config: fineConfig }).scenario;
  fine.controllerWindSource = 'coflex-estimate';
  fine.windEstimator = createWindEstimatorConfig(params);
  const fineSamples = runSimulationScenario({ scenario: fine, params, aeroTable: table }).samples;
  const peak = fineSamples.reduce((p, s) => Math.max(p, s.rotorSpeedRadPerSec * RPM), 0);
  assert(Math.abs(peak - rows.find(row => row.source === 'coflex-estimate' && row.case === crossing.name).peakRpm) < .01);
  console.log(`PASS: scheduled COFLEX crossing at half dt, peak ${peak.toFixed(4)} rpm, difference below 0.01 rpm`);

  const { createCoordinatedControllerState } = await server.ssrLoadModule('/src/sim/coordinatedController.ts');
  const { OperatingSupervisor } = await server.ssrLoadModule('/src/sim/operatingSupervisor.ts');
  const { createOperatingSequence, requestStartup, requestShutdown, stepOperatingSequence } = await server.ssrLoadModule('/src/sim/operatingSequence.ts');
  const { createWindEstimatorState, stepWindEstimator } = await server.ssrLoadModule('/src/sim/windEstimator.ts');
  const estimator = createWindEstimatorConfig(params);
  for (const windMps of [3, 18]) {
    const config = createCoordinatedControllerConfig(params, table);
    config.gainScheduling = true;
    let run = { supervisor: new OperatingSupervisor(), sequence: requestStartup(createOperatingSequence()),
      state: { timeS: 0, rotorSpeedRadPerSec: 0, rotorAzimuthRad: 0, platformPitchRad: 0, platformPitchRateRadPerSec: 0 },
      control: { collectivePitchRad: Math.PI / 2, generatorTorqueNm: 0 },
      controllerState: createCoordinatedControllerState(config, { windMps, rotorSpeedRadPerSec: 0, pitchRad: 0, torqueNm: 0 }),
      environment: { windSpeedMps: windMps, wavePitchMomentNm: 0 }, params, config, table, dtS: .02 };
    let estimate = createWindEstimatorState(0, estimator, table), generatingS = 0;
    while (run.state.timeS < 1500 && generatingS < 300) {
      const wasGenerating = run.sequence.phase === 'generating';
      run = { ...run, ...stepOperatingSequence({ ...run, generatingWindMps: estimate.estimatedWindMps, windInputSource: 'coflex-estimate' }) };
      estimate = stepWindEstimator(estimate, { rotorSpeedRadPerSec: run.state.rotorSpeedRadPerSec,
        pitchRad: run.control.collectivePitchRad, generatorTorqueNm: run.control.generatorTorqueNm,
        generating: wasGenerating && run.sequence.phase === 'generating' }, estimator, table, .02).state;
      assert(!['shutting-down', 'parked'].includes(run.sequence.phase), 'No unintended scheduled-mode shutdown');
      assert(run.state.rotorSpeedRadPerSec < params.ratedRotorSpeedRadPerSec * 1.2);
      if (run.sequence.phase === 'generating') generatingS += .02;
    }
    assert(generatingS >= 300);
    run.sequence = requestShutdown(run.sequence, 'manual');
    const stopAt = run.state.timeS + 600;
    while (run.sequence.phase !== 'parked' && run.state.timeS < stopAt) run = { ...run, ...stepOperatingSequence(run) };
    assert.equal(run.sequence.phase, 'parked');
    assert.equal(run.state.rotorSpeedRadPerSec, 0);
    console.log(`PASS: scheduled COFLEX startup, 300 s generation and requested shutdown at ${windMps} m/s`);
  }
} finally { globalThis.fetch = originalFetch; await server.close(); }
