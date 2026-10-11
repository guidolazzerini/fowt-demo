// Actual browser-worker integration with a deterministic manual clock. No DOM
// or browser is mocked: this checks messages/model behavior, not UI interaction.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
const originalSelf = globalThis.self;
let tick, receive, latest;
globalThis.fetch = async (input) => {
  assert.equal(input, '/iea15mw-aero-v1.json');
  return new Response(await readFile(new URL('../public/iea15mw-aero-v1.json', import.meta.url)));
};
globalThis.self = {
  postMessage(message) { latest = message; receive?.(message); },
  setInterval(callback) { tick = callback; return 1; },
  clearInterval() { tick = undefined; },
};
function request(message, responseType = 'sample') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker timeout: ${message.type}`)), 5000);
    receive = (response) => {
      if (response.type !== responseType && response.type !== 'error') return;
      clearTimeout(timeout);
      receive = undefined;
      if (response.type === 'error') reject(new Error(response.message));
      else resolve(response);
    };
    self.onmessage({ data: message });
  });
}
const update = settings => request({ type: 'update-settings', settings });
const reset = () => request({ type: 'reset' }, 'ready');
const start = () => request({ type: 'start' }, 'status');
const stop = () => request({ type: 'stop' }, 'status');
function advance() {
  assert.equal(typeof tick, 'function', JSON.stringify(latest));
  tick();
  if (tick) tick(); // A boundary trip posts immediately, without the second tick.
  assert.equal(latest.type, 'sample', JSON.stringify(latest));
  for (const value of Object.values(latest.sample)) {
    if (typeof value === 'number') assert(Number.isFinite(value));
  }
  return latest.sample;
}
function runningSample() {
  const sample = advance();
  assert(latest.isRunning, JSON.stringify(latest.operation));
  assert(sample.generatorTorqueNm >= 0 && sample.generatorTorqueNm <= 20e6);
  assert(sample.collectivePitchRad >= 0 && sample.collectivePitchRad <= Math.PI / 6 + 1e-12);
  return sample;
}

try {
  const { DEFAULT_SIMULATION_UI_SETTINGS: defaults } = await server.ssrLoadModule('/src/sim/workerMessages.ts');
  const { DEFAULT_TUNABLE_PARAMETERS: params } = await server.ssrLoadModule('/src/sim/defaults.ts');
  const { SUGGESTED_REFERENCE_GAINS: gains } = await server.ssrLoadModule('/src/sim/suggestedGains.ts');
  const suggested = { ...gains, pitchKp: gains.pitchKpS };
  delete suggested.pitchKpS;
  const full = { ...defaults, ...suggested, strategy: 'coordinated-tsr-pi' };
  const { loadAeroTable } = await server.ssrLoadModule('/src/sim/aero.ts');
  const table = await loadAeroTable(params.aero.filePath);
  const { createCoordinatedScenario, createCoordinatedControllerConfig } = await server.ssrLoadModule('/src/sim/coordinated.ts');
  const { runSimulationScenario } = await server.ssrLoadModule('/src/sim/simulation.ts');
  const { createWindEstimatorConfig, createWindEstimatorState, stepWindEstimator } = await server.ssrLoadModule('/src/sim/windEstimator.ts');
  await server.ssrLoadModule('/src/sim/simulationWorker.ts');
  await request({ type: 'initialise' }, 'ready');
  await start();
  runningSample();
  const selected = await update({ strategy: full.strategy });
  assert(!selected.isRunning && selected.operation.requiresReset);
  assert.equal(selected.settings.pitchKp, defaults.pitchKp, 'Strategy selection must retain student gains');
  assert(!(await start()).isRunning, 'Pending strategy needs Reset');

  // Every requested equilibrium includes platform static deflection and uses
  // aerodynamic rotor torque, not power/Cp interpolation, for torque balance.
  for (const speed of [3, 5, 8, 10.5, 12, 18, 25]) {
    await update({ ...full, meanWindSpeedMps: speed });
    const initial = await reset();
    assert(initial.operation.canStart, initial.operation.message);
    const wind = { mode: 'constant', meanWindSpeedMps: speed };
    const { operatingPoint } = createCoordinatedScenario({ name: 'equilibrium', totalTimeS: 0, dtS: .02, wind, params, aeroTable: table });
    assert.equal(initial.sample.rotorSpeedRadPerSec, operatingPoint.rotorSpeedRadPerSec);
    assert(Math.abs(initial.sample.aerodynamicTorqueNm - initial.sample.generatorTorqueNm) < 1e-5);
    assert(Math.abs(initial.sample.collectivePitchRad - operatingPoint.pitchRad) < 1e-12);
    await start();
    for (let i = 0; i < 100; i++) runningSample();
    assert(Math.abs(latest.sample.rotorSpeedRadPerSec - initial.sample.rotorSpeedRadPerSec) < 1e-6);
    await stop();
  }
  console.log('PASS: generating initialization and 32 s steady operation at 3, 5, 8, 10.5, 12, 18, 25 m/s');

  // Exact comparison includes nested controller references, saturation, and PI diagnostics.
  for (const source of ['simulated-free-stream', 'coflex-estimate']) {
  for (const [mode, speed] of [['constant', 5], ['gust', 10.5], ['random', 18]]) {
    await update({ ...full, controllerWindSource: source, windMode: mode, meanWindSpeedMps: speed, gustStartTimeS: 5, gustDurationS: 35, gustAmplitudeMps: 2 });
    await reset();
    const wind = { mode, meanWindSpeedMps: speed };
    if (mode === 'gust') Object.assign(wind, { gustStartTimeSec: 5, gustDurationSec: 35, gustAmplitudeMps: 2 });
    if (mode === 'random') Object.assign(wind, { mode: 'turbulent', turbulenceIntensity: .06, seed: 12345, lowPassTimeConstantSec: 2.5 });
    const { scenario } = createCoordinatedScenario({ name: 'browser parity', totalTimeS: 48, dtS: .02, wind, params, aeroTable: table });
    scenario.windEstimator = createWindEstimatorConfig(params);
    scenario.controllerWindSource = source;
    const offline = runSimulationScenario({ scenario, params, aeroTable: table });
    assert.deepEqual(latest.sample, offline.samples[0]);
    await start();
    for (let i = 1; i <= 150; i++) assert.deepEqual(runningSample(), offline.samples[i * 16]);
    const time = latest.sample.timeS;
    await stop();
    assert.equal(tick, undefined);
    await start();
    assert(runningSample().timeS > time);
    await stop();
  }
  }
  console.log('PASS: exact full-range worker/offline parity (900 samples, both wind sources), Start/Stop resume');

  for (const [speed, amplitude] of [[9, 4], [13, -4]]) {
    await update({ ...full, meanWindSpeedMps: speed, windMode: 'gust', gustAmplitudeMps: amplitude,
      gustStartTimeS: 100, gustDurationS: 800, stepsPerWorkerTick: 20 });
    await reset();
    await start();
    const regions = new Set();
    let tailErrorRpm = 0;
    for (let i = 0; i < 2000; i++) {
      const sample = runningSample(); // 1600 simulated seconds, dt unchanged.
      regions.add(latest.operation.region);
      assert.equal(latest.settings.pitchKp, .6);
      assert.equal(latest.settings.pitchKi, .015);
      if (sample.timeS > 1500) tailErrorRpm = Math.max(tailErrorRpm,
        Math.abs(sample.rotorSpeedRadPerSec - sample.controllerDiagnostics.smoother.baseTorqueSpeedRefRadPerSec) * 30 / Math.PI);
    }
    assert(regions.has('Below rated') && regions.has('Above rated'));
    assert(tailErrorRpm < .005, `Worker crossing tail error: ${tailErrorRpm} rpm`);
    await stop();
  }
  console.log('PASS: 1600 s worker crossings in both directions, fixed gains, region changes, recovery below 0.005 rpm');

  // Long near-rated turbulence through the actual worker, with identical
  // disturbances for smoothing on/off. Retain only posted samples, not every
  // integration step. This tests control integration, NOT browser memory.
  const turbulentRuns = [];
  for (const smoothingEnabled of [true, false]) {
    await update({ ...full, meanWindSpeedMps: 10.5, windMode: 'random', turbulenceIntensity: .08,
      smoothingEnabled, stepsPerWorkerTick: 20 });
    assert((await reset()).operation.canStart);
    await start();
    const samples = [];
    let crossings = 0;
    let previousRegion;
    const visitedRegions = new Set();
    for (let i = 0; i < 1500; i++) {
      const sample = runningSample(); // 1200 simulated seconds per run.
      const region = latest.operation.region;
      visitedRegions.add(region);
      if (previousRegion && region !== previousRegion) crossings++;
      previousRegion = region;
      const diagnostics = sample.controllerDiagnostics;
      assert.equal(diagnostics.strategy, 'coordinated-tsr-pi');
      if (!smoothingEnabled) assert.equal(diagnostics.smoother.offsetRadPerSec, 0);
      assert.equal(latest.settings.pitchKp, full.pitchKp, 'Wind must not select gains');
      assert.equal(latest.settings.pitchKi, full.pitchKi);
      if (samples.length) {
        const previous = samples.at(-1);
        const elapsedS = sample.timeS - previous.timeS;
        // Commands may change direction between posts; their net change must
        // still respect the actuator slew bounds [N m/s] and [rad/s].
        assert(Math.abs(sample.generatorTorqueNm - previous.generatorTorqueNm) <= 2e6 * elapsedS + 1e-5);
        assert(Math.abs(sample.collectivePitchRad - previous.collectivePitchRad) <= 5 * Math.PI / 180 * elapsedS + 1e-10);
      }
      samples.push(sample);
    }
    assert(crossings >= 4, `Expected repeated region crossings, got ${crossings}`);
    assert(visitedRegions.has('Below rated') && visitedRegions.has('Above rated'),
      'Turbulence must exercise both sides of rated operation');
    turbulentRuns.push(samples);
    await stop();
  }
  assert.deepEqual(turbulentRuns[0].map(s => [s.timeS, s.windSpeedMps, s.turbulentMps]),
    turbulentRuns[1].map(s => [s.timeS, s.windSpeedMps, s.turbulentMps]), 'Compare identical turbulent wind');
  assert(turbulentRuns[0].some((s, i) => s.controllerDiagnostics.smoother.torqueSpeedRefRadPerSec !==
    turbulentRuns[1][i].controllerDiagnostics.smoother.torqueSpeedRefRadPerSec), 'Smoothing must affect the reference');
  console.log('PASS: 1200 s near-rated turbulent worker runs, identical wind with smoothing on/off, repeated region crossings and actuator slew bounds');

  async function replay(edits, overrides = {}) {
    await update({ ...full, windMode: 'random', meanWindSpeedMps: 12, ...overrides });
    await reset();
    await start();
    const samples = [];
    for (let i = 0; i < 120; i++) {
      if (edits?.[i]) {
        const before = latest.sample;
        const after = await update(edits[i]);
        assert.equal(after.sample.timeS, before.timeS);
        assert.equal(after.sample.collectivePitchRad, before.collectivePitchRad);
        assert.equal(after.sample.generatorTorqueNm, before.generatorTorqueNm);
        if (edits[i].controllerWindSource) {
          assert.deepEqual(after.sample, before, 'Selecting a wind source preserves the current sample and states');
          assert(after.isRunning && !after.operation.requiresReset);
        }
      }
      samples.push(runningSample());
    }
    await stop();
    return samples;
  }
  const baseline = await replay();
  for (const speed of [8, 18]) {
    const reference = await replay(undefined, { meanWindSpeedMps: speed });
    const switched = await replay({ 10: { controllerWindSource: 'coflex-estimate' },
      30: { windEstimatorKp: 150, windEstimatorKi: 8 },
      45: { windEstimatorKi: 0 }, 55: { windEstimatorKp: 80 }, 65: { windEstimatorKi: 5 },
      70: { controllerWindSource: 'simulated-free-stream' } }, { meanWindSpeedMps: speed });
    assert.deepEqual(switched.map(s => s.windSpeedMps), reference.map(s => s.windSpeedMps));
    assert.equal(switched[11].controllerDiagnostics.torque.windInputSource, 'coflex-estimate');
    assert.equal(switched[71].controllerDiagnostics.torque.windInputSource, 'simulated-free-stream');
  }
  assert.equal((await update({ controllerWindSource: 'invalid-source' })).settings.controllerWindSource, 'simulated-free-stream');
  const boundedEstimator = await update({ windEstimatorKp: 0, windEstimatorKi: 0 });
  assert(boundedEstimator.settings.windEstimatorKp > 0);
  assert.equal(boundedEstimator.settings.windEstimatorKi, 0);
  const initialOnly = await replay({ 10: { initialCollectivePitchDeg: 20 } });
  assert.deepEqual(initialOnly, baseline);
  const estimatorInitialOnly = await replay({ 10: { windEstimatorInitialMps: 15 } });
  assert.deepEqual(estimatorInitialOnly, baseline, 'Estimator initial guess applies only on Reset');
  const estimatorTuned = await replay({ 10: { windEstimatorKp: 150, windEstimatorKi: 8 } });
  const withoutEstimator = samples => samples.map(({ windEstimator: _estimate, ...rest }) => rest);
  assert.deepEqual(withoutEstimator(estimatorTuned), withoutEstimator(baseline));
  assert(estimatorTuned.some((s, i) => s.windEstimator.estimatedWindMps !== baseline[i].windEstimator.estimatedWindMps));
  const tuned = await replay({
    10: { torqueKpNmsPerRad: 40e6, torqueKiNmPerRad: 1e6, pitchKp: .8, pitchKi: .02 },
    25: { torqueKiNmPerRad: 0, pitchKi: 0 },
    35: { torqueKiNmPerRad: 2.24e6, pitchKi: .015 },
    50: { smoothingEnabled: false }, 60: { smoothingEnabled: true },
    70: { floatingFeedbackEnabled: true, platformPitchRateGainS: 5 },
    80: { gustAmplitudeMps: 7 }, // inactive wind setting
  });
  assert.deepEqual(tuned.map(s => [s.timeS, s.windSpeedMps, s.turbulentMps]), baseline.map(s => [s.timeS, s.windSpeedMps, s.turbulentMps]));
  assert(tuned.some((s, i) => s.collectivePitchRad !== baseline[i].collectivePitchRad));
  assert.equal(tuned[30].controllerDiagnostics.torque.integralTorqueNm, 0);
  assert.equal(tuned[30].controllerDiagnostics.pitch.integralTermRad, 0);
  const firstReset = await reset();
  await update({ initialCollectivePitchDeg: 25 });
  assert.deepEqual((await reset()).sample, firstReset.sample, 'Full mode ignores legacy initial pitch on Reset too');
  console.log('PASS: repeatable wind through live gains, zero Ki, feedback and smoothing toggles; legacy initial pitch inactive');

  // Direct transfer test: continuity must be stronger than simply respecting
  // slew limits. With frozen measurements, only ordinary integration may move
  // the command after positive-Ki retuning. Zero Ki explicitly clears memory.
  const { retuneCoordinatedControllerState, stepCoordinatedController } = await server.ssrLoadModule('/src/sim/coordinatedController.ts');
  const config = createCoordinatedControllerConfig(params, table);
  const { scenario: trimScenario } = createCoordinatedScenario({ name: 'retune', totalTimeS: 0, dtS: .02,
    wind: { mode: 'constant', meanWindSpeedMps: 18 }, params, aeroTable: table });
  const original = trimScenario.controller.initialControllerState;
  const omega = params.ratedRotorSpeedRadPerSec + .03;
  for (const ki of [.02, 0]) {
    const next = { ...config, pitch: { ...config.pitch, pitchKp: .8, pitchKi: ki },
      torque: { ...config.torque, kpNmsPerRad: 40e6, kiNmPerRad: ki === 0 ? 0 : 1e6 } };
    const adjusted = retuneCoordinatedControllerState(original, omega, next);
    assert.equal(adjusted.torque.filteredWindMps, original.torque.filteredWindMps);
    assert.equal(adjusted.pitch.filteredPlatformPitchRateRadPerSec, original.pitch.filteredPlatformPitchRateRadPerSec);
    const result = stepCoordinatedController(adjusted, { rotorSpeedRadPerSec: omega,
      platformPitchRateRadPerSec: 0, controlWindMps: 18 }, next, .02);
    if (ki > 0) {
      assert(Math.abs(result.control.collectivePitchRad - original.pitch.previousPitchRad) <= ki * .03 * .02 + 1e-12);
      assert(Math.abs(result.control.generatorTorqueNm - original.torque.previousTorqueNm) < 1e-6, 'Torque stays at normal cap');
    } else {
      assert.equal(adjusted.pitch.integralErrorRad, 0);
      assert.equal(adjusted.torque.integralTorqueNm, 0);
      assert(Math.abs(result.control.collectivePitchRad - original.pitch.previousPitchRad) <= next.pitch.maxPitchRateRadPerSec * .02 + 1e-12);
      assert(Math.abs(result.control.generatorTorqueNm - original.torque.previousTorqueNm) <= next.torque.maxTorqueRateNmPerSec * .02 + 1e-6);
    }
  }
  console.log('PASS: coordinated positive-Ki output transfer and zero-Ki slew-limited transfer');

  for (const [mean, amplitude, endpoint, reentry] of [[24, 2, 25, 24.8], [4, -2, 3, 3.2]]) {
    await update({ ...full, windMode: 'gust', meanWindSpeedMps: mean, gustAmplitudeMps: amplitude, gustStartTimeS: 0, gustDurationS: 10 });
    assert((await reset()).operation.canStart);
    await start();
    for (let i = 0; i < 100 && tick; i++) advance();
    assert.equal(tick, undefined, 'Out-of-envelope gust must stop the worker');
    assert.equal(latest.operation.region, 'Unsupported operation');
    assert(amplitude > 0 ? latest.sample.windSpeedMps > 25 : latest.sample.windSpeedMps < 3, 'Wind is not clipped at operating thresholds');
    const frozen = latest.sample;
    assert(!(await start()).isRunning);
    await update({ windMode: 'constant', meanWindSpeedMps: endpoint });
    const blocked = await reset();
    assert(!blocked.operation.canStart, 'Trip remains latched at the boundary');
    assert.equal(blocked.sample.timeS, frozen.timeS);
    assert.equal(blocked.sample.rotorSpeedRadPerSec, frozen.rotorSpeedRadPerSec);
    await update({ meanWindSpeedMps: reentry });
    assert((await reset()).operation.canStart, 'Inward margin permits explicit Reset');
    await update({ meanWindSpeedMps: endpoint });
    assert((await reset()).operation.canStart, 'Fresh endpoint initialization is allowed');
  }
  console.log('PASS: unclipped upper/lower gust crossings, frozen state, blocked Start, Reset hysteresis and endpoint recovery');

  await update({ ...full, meanWindSpeedMps: 25 });
  await reset();
  await start();
  const limited = await update({ maxPitchDeg: 5 });
  assert(!limited.isRunning && limited.operation.requiresReset);
  const infeasible = await reset();
  assert(!infeasible.operation.canStart);
  assert.match(infeasible.operation.message, /Cannot initialize/);
  await update({ maxPitchDeg: 30 });
  assert((await reset()).operation.canStart);
  await update({ pitchKp: .75, pitchKi: .012, meanWindSpeedMps: 14, strategy: 'legacy-above-rated' });
  const legacy = await reset();
  assert.equal(legacy.operation.activeStrategy, 'legacy-above-rated');
  assert.equal(legacy.settings.pitchKp, .75);
  await update({ strategy: 'coordinated-tsr-pi', meanWindSpeedMps: 5 });
  const restored = await reset();
  assert(restored.operation.canStart);
  assert.equal(restored.settings.pitchKp, .75);
  assert.equal(restored.settings.pitchKi, .012);
  await start();
  const beforeTrip = runningSample();
  const trip = await update({ meanWindSpeedMps: 30 });
  assert(!trip.isRunning && !trip.operation.canStart);
  assert.equal(trip.sample.windSpeedMps, 30);
  assert.equal(trip.sample.timeS, beforeTrip.timeS, 'Live out-of-envelope edit freezes the current sample');
  assert.equal(trip.sample.rotorSpeedRadPerSec, beforeTrip.rotorSpeedRadPerSec);
  console.log('PASS: infeasible limits, Reset recovery, manual gains retained across strategies, unclipped live boundary edit');

  await update({ ...full, meanWindSpeedMps: 24, pitchKp: 0, pitchKi: 0,
    torqueKpNmsPerRad: 0, torqueKiNmPerRad: 0, stepsPerWorkerTick: 20 });
  assert((await reset()).operation.canStart);
  await start();
  for (let i = 0; i < 1500 && tick; i++) advance();
  assert(!latest.isRunning, 'Unregulated rotor must stop when leaving aerodynamic data');
  assert.match(latest.operation.message, /aerodynamic table/);
  assert.equal(latest.sample.windSpeedMps, 24, 'This trip is caused by model validity, not free-stream wind');
  assert(latest.sample.rotorSpeedRadPerSec >= table.rotorSpeedRadPerSec[0]);
  assert(latest.sample.rotorSpeedRadPerSec <= table.rotorSpeedRadPerSec[table.nOmega - 1]);
  console.log('PASS: deliberately unregulated model freezes within aerodynamic data instead of silently extrapolating');

  // Exercise the worker boundary itself, not just the shared clamp helper.
  // No physical steps are taken with these intentionally invalid input values.
  const { SETTING_RANGES } = await server.ssrLoadModule('/src/sim/settingRanges.ts');
  for (const [key, range] of Object.entries(SETTING_RANGES)) {
    for (const value of [range.min - 1, range.max + 1, NaN, Infinity]) {
      const response = await update({ ...full, meanWindSpeedMps: 14, [key]: value });
      let expected = Number.isFinite(value) ? Math.max(range.min, Math.min(range.max, value)) : range.min;
      if (key === 'stepsPerWorkerTick') expected = Math.round(expected);
      assert.equal(response.settings[key], expected, key + ' worker bounds');
    }
  }
  const pitchBounds = await update({ ...full, minPitchDeg: 7, maxPitchDeg: 8, initialCollectivePitchDeg: 30 });
  assert.equal(pitchBounds.settings.initialCollectivePitchDeg, 8);
  console.log('PASS: all shared numeric ranges enforced by actual worker; initial pitch obeys actuator bounds');

  const { createOperatingSequence, requestStartup, stepOperatingSequence } = await server.ssrLoadModule('/src/sim/operatingSequence.ts');
  const { createCoordinatedControllerState } = await server.ssrLoadModule('/src/sim/coordinatedController.ts');
  const { OperatingSupervisor } = await server.ssrLoadModule('/src/sim/operatingSupervisor.ts');
  const pendingStartup = await update({ ...full, controllerWindSource: 'coflex-estimate', windMode: 'constant', meanWindSpeedMps: 8, startupShutdownEnabled: true });
  assert(pendingStartup.operation.requiresReset && !pendingStartup.isRunning);
  const parked = await reset();
  assert.equal(parked.operation.turbinePhase, 'parked');
  assert.equal(parked.sample.rotorSpeedRadPerSec, 0);
  assert.equal(parked.sample.collectivePitchRad, Math.PI / 2);
  assert(parked.operation.canStartTurbine);
  const sequenceConfig = createCoordinatedControllerConfig(params, table);
  let sequenceRun = {
    supervisor: new OperatingSupervisor(), sequence: requestStartup(createOperatingSequence()),
    state: { timeS: 0, rotorSpeedRadPerSec: 0, rotorAzimuthRad: 0, platformPitchRad: 0, platformPitchRateRadPerSec: 0 },
    control: { collectivePitchRad: Math.PI / 2, generatorTorqueNm: 0 },
    controllerState: createCoordinatedControllerState(sequenceConfig, { windMps: 8, rotorSpeedRadPerSec: 0, pitchRad: 0, torqueNm: 0 }),
    config: sequenceConfig, params, table, environment: { windSpeedMps: 8, wavePitchMomentNm: 0 }, dtS: .02,
  };
  const estimatorConfig = createWindEstimatorConfig(params);
  let estimatorState = createWindEstimatorState(0, estimatorConfig, table), estimatorDiagnostics;
  const estimatorStatuses = new Set();
  await request({ type: 'start-turbine' });
  for (let i = 0; i < 1000; i++) {
    const sample = advance();
    for (let j = 0; j < 16; j++) {
      const wasGenerating = sequenceRun.sequence.phase === 'generating';
      sequenceRun = { ...sequenceRun, ...stepOperatingSequence({ ...sequenceRun,
        generatingWindMps: estimatorState.estimatedWindMps, windInputSource: 'coflex-estimate' }) };
      const estimate = stepWindEstimator(estimatorState, { rotorSpeedRadPerSec: sequenceRun.state.rotorSpeedRadPerSec,
        pitchRad: sequenceRun.control.collectivePitchRad, generatorTorqueNm: sequenceRun.control.generatorTorqueNm,
        generating: wasGenerating && sequenceRun.sequence.phase === 'generating' }, estimatorConfig, table, .02);
      estimatorState = estimate.state;
      estimatorDiagnostics = estimate.diagnostics;
    }
    assert.deepEqual(sample.windEstimator, estimatorDiagnostics);
    estimatorStatuses.add(sample.windEstimator.status);
    assert.deepEqual(sample.operatingSequence, sequenceRun.sequence);
    assert.equal(sample.rotorSpeedRadPerSec, sequenceRun.state.rotorSpeedRadPerSec);
    assert.equal(sample.platformPitchRad, sequenceRun.state.platformPitchRad);
    assert.equal(sample.collectivePitchRad, sequenceRun.control.collectivePitchRad);
    assert.equal(sample.generatorTorqueNm, sequenceRun.control.generatorTorqueNm);
  }
  assert.equal(latest.operation.turbinePhase, 'generating');
  assert(estimatorStatuses.has('held') && estimatorStatuses.has('tracking'));
  await stop();
  assert.equal(tick, undefined);
  const shutdown = await request({ type: 'shutdown-turbine' });
  assert(shutdown.isRunning && shutdown.operation.turbinePhase === 'shutting-down', 'Physical shutdown resumes the clock');
  for (let i = 0; i < 1200 && latest.operation.turbinePhase !== 'parked'; i++) advance();
  assert.equal(latest.operation.turbinePhase, 'parked');
  assert.equal(latest.sample.rotorSpeedRadPerSec, 0);
  assert.equal(latest.sample.generatorTorqueNm, 0);
  assert.equal(latest.sample.windEstimator.status, 'held');
  const afterStopTime = latest.sample.timeS;
  await request({ type: 'start-turbine' });
  advance();
  assert(latest.sample.timeS > afterStopTime, 'Restart preserves simulation/wind time');
  assert.equal(latest.operation.turbinePhase, 'starting');
  const priorCoverage = latest.sample.operatingSequence.supervisor.availableObservedS;
  await update({ meanWindSpeedMps: 2.9 });
  assert.equal(latest.operation.turbinePhase, 'starting', 'Live wind edit must not cause instantaneous shutdown');
  advance();
  assert.equal(latest.sample.operatingSequence.supervisor.availableObservedS, priorCoverage, 'Wind edits preserve averaging history');
  await request({ type: 'shutdown-turbine' });
  for (let i = 0; i < 1200 && latest.operation.turbinePhase !== 'parked'; i++) advance();
  await update({ meanWindSpeedMps: 0 });
  for (let i = 0; i < 200; i++) advance();
  await stop();
  await request({ type: 'start-turbine' });
  advance();
  assert(latest.isRunning && latest.operation.turbinePhase === 'waiting', 'Start request arms and resumes the clock in calm wind');
  await request({ type: 'shutdown-turbine' });
  assert.equal(latest.operation.turbinePhase, 'parked', 'Shutdown cancels waiting startup');
  const paused = await update({ startupShutdownEnabled: false, meanWindSpeedMps: 8 });
  assert(!paused.isRunning && paused.operation.requiresReset);
  const equilibriumAgain = await reset();
  assert.equal(equilibriumAgain.sample.operatingSequence, undefined);
  assert(equilibriumAgain.sample.rotorSpeedRadPerSec > 0);
  console.log('PASS: optional startup Reset, 1000 exact worker/shared-sequence samples, physical shutdown/resume, parked restart, averaged torque supervision and waiting/cancellation and generating-only restoration');
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf === undefined) delete globalThis.self;
  else globalThis.self = originalSelf;
  await server.close();
}
