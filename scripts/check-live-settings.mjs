// Exercise the actual worker with a manual clock, using Vite's TypeScript loader.
// This avoids browser timing differences and adds no test dependency.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
const originalSelf = globalThis.self;
let tick;
let receive;
let latest;
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

function advance() {
  assert.equal(typeof tick, 'function', JSON.stringify(latest));
  // The worker posts every two ticks. Default: 8 steps/tick, dt = 0.02 s.
  tick();
  assert.equal(typeof tick, 'function', JSON.stringify(latest));
  tick();
  assert.equal(latest.type, 'sample', JSON.stringify(latest));
  assert.equal(latest.isRunning, true);
  for (const value of Object.values(latest.sample)) {
    if (typeof value === 'number') assert(Number.isFinite(value));
  }
  return latest.sample;
}

try {
  const { DEFAULT_SIMULATION_UI_SETTINGS: uiDefaults } = await server.ssrLoadModule('/src/sim/workerMessages.ts');
  // Preserve the historical legacy regression independently of the browser default.
  const defaults = { ...uiDefaults, strategy: 'legacy-above-rated', pitchKp: 1.5, pitchKi: .05 };
  await server.ssrLoadModule('/src/sim/simulationWorker.ts');
  await request({ type: 'initialise' }, 'ready');

  async function replay(editAtSample) {
    await request({ type: 'update-settings', settings: {
      // Keep this continuity regression inside the legacy envelope now that
      // boundary crossings pause instead of clipping wind. Trips are tested separately.
      ...defaults, windMode: 'random', meanWindSpeedMps: 14, turbulenceIntensity: 0.06,
    } });
    await request({ type: 'reset' }, 'ready');
    await request({ type: 'start' }, 'status');
    const samples = [];
    for (let i = 0; i < 120; i++) {
      if (editAtSample) await editAtSample(i);
      samples.push(advance());
    }
    await request({ type: 'stop' }, 'status');
    assert.equal(tick, undefined);
    return samples;
  }

  const baseline = await replay();
  const initialOnly = await replay(async (i) => {
    if (i === 30) await request({ type: 'update-settings', settings: { initialCollectivePitchDeg: 8 } });
  });
  assert.deepEqual(initialOnly, baseline, 'Initial pitch must not change any running sample');

  const tuned = await replay(async (i) => {
    const edits = {
      20: { pitchKp: 0.8, pitchKi: 0.02 },
      35: { pitchKi: 0 },
      45: { pitchKp: 1.8 },
      55: { pitchKi: 0.05 },
      65: { floatingFeedbackEnabled: true, platformPitchRateGainS: 5 },
      75: { initialCollectivePitchDeg: 8, minPitchDeg: 1, maxPitchDeg: 28, maxPitchRateDegPerSec: 4 },
      85: { gustAmplitudeMps: 7, gustStartTimeS: 4, gustDurationS: 8 }, // inactive in Random
      95: { pitchKi: 0.05, turbulenceIntensity: 0.06 }, // same values must be a no-op
    };
    if (!edits[i]) return;
    const before = latest.sample;
    const after = await request({ type: 'update-settings', settings: edits[i] });
    assert.equal(after.sample.timeS, before.timeS);
    assert.equal(after.sample.collectivePitchRad, before.collectivePitchRad);
    assert.equal(after.sample.windSpeedMps, before.windSpeedMps);
  });
  const windHistory = (samples) => samples.map(({ timeS, windSpeedMps, turbulentMps, gustMps }) =>
    ({ timeS, windSpeedMps, turbulentMps, gustMps }));
  assert.deepEqual(windHistory(tuned), windHistory(baseline), 'Live tuning must preserve every wind sample');
  assert(tuned.some((sample, i) => sample.collectivePitchRad !== baseline[i].collectivePitchRad));

  await request({ type: 'start' }, 'status');
  const resumed = advance();
  assert(resumed.timeS > tuned.at(-1).timeS);
  const changedWind = await request({ type: 'update-settings', settings: { turbulenceIntensity: 0.15 } });
  assert.equal(changedWind.sample.timeS, resumed.timeS);
  assert.equal(changedWind.sample.turbulentMps, 0, 'Active wind change restarts the random process');
  advance();
  await request({ type: 'update-settings', settings: { stepsPerWorkerTick: 1 } });
  const reset = await request({ type: 'reset' }, 'ready');
  assert.equal(reset.isRunning, false);
  assert.equal(reset.sample.timeS, 0);
  assert(Math.abs(reset.sample.collectivePitchRad * 180 / Math.PI - 8) < 1e-12);
  await request({ type: 'start' }, 'status');
  tick();
  const afterReset = await request({ type: 'update-settings', settings: {} });
  assert(Math.abs(afterReset.sample.collectivePitchRad - 8 * Math.PI / 180) < 1e-12,
    'At initial zero speed error, the first control step must retain the chosen pitch');
  tick(); // Restore the worker's two-tick reporting boundary for advance().
  await request({ type: 'update-settings', settings: { stepsPerWorkerTick: defaults.stepsPerWorkerTick } });
  await request({ type: 'stop' }, 'status');

  // Gust updates use absolute simulation time, including the immediate sample.
  await request({ type: 'update-settings', settings: {
    windMode: 'gust', meanWindSpeedMps: 14, gustStartTimeS: 0, gustDurationS: 10, gustAmplitudeMps: 2,
  } });
  await request({ type: 'start' }, 'status');
  for (let i = 0; i < 8; i++) advance();
  const gustBefore = latest.sample;
  const inactiveEdit = await request({ type: 'update-settings', settings: { turbulenceIntensity: 0.2 } });
  assert.deepEqual(inactiveEdit.sample, gustBefore);
  const gustEdit = await request({ type: 'update-settings', settings: { gustAmplitudeMps: 4 } });
  assert(Math.abs(gustEdit.sample.gustMps - 2 * gustBefore.gustMps) < 1e-12);
  const constant = await request({ type: 'update-settings', settings: { windMode: 'constant', meanWindSpeedMps: 16 } });
  assert.equal(constant.sample.windSpeedMps, 16);
  await request({ type: 'stop' }, 'status');
  console.log('PASS: running worker wind continuity, Reset-only pitch, active/inactive settings, Start/Stop/Reset');

  const { createPitchControllerConfig, createPitchControllerState, retunePitchControllerState, stepPitchController } =
    await server.ssrLoadModule('/src/sim/controller.ts');
  const { DEFAULT_TUNABLE_PARAMETERS } = await server.ssrLoadModule('/src/sim/defaults.ts');
  const base = createPitchControllerConfig(DEFAULT_TUNABLE_PARAMETERS);
  const measurements = { rotorSpeedRadPerSec: base.rotorSpeedRefRadPerSec + 0.03, platformPitchRateRadPerSec: 0.004 };
  const dt = 0.02;
  for (const pitch of [0, 0.2, base.maxPitchRad]) {
    const original = { ...createPitchControllerState(base, pitch), integralErrorRad: 3, filteredPlatformPitchRateRadPerSec: 0.004 };
    for (const ki of [0.02, 0.1, 1e-12]) {
      const config = { ...base, pitchKp: 0.8, pitchKi: ki, floatingFeedbackEnabled: true, platformPitchRateGainS: 5 };
      const adjusted = retunePitchControllerState(original, measurements.rotorSpeedRadPerSec, config);
      const result = stepPitchController(adjusted, measurements, config, dt);
      // Only ordinary integration may move the output on the first retuned step.
      assert(Math.abs(result.control.collectivePitchRad - pitch) <= ki * 0.03 * dt + 1e-12);
      assert.equal(adjusted.filteredPlatformPitchRateRadPerSec, original.filteredPlatformPitchRateRadPerSec);
    }
  }
  const pOnly = { ...base, pitchKi: 0 };
  let pState = retunePitchControllerState(createPitchControllerState(base, 0.2), measurements.rotorSpeedRadPerSec, pOnly);
  for (let i = 0; i < 300; i++) {
    const result = stepPitchController(pState, measurements, pOnly, dt);
    assert.equal(result.state.integralErrorRad, 0);
    assert(Math.abs(result.control.collectivePitchRad - pState.previousPitchRad) <= base.maxPitchRateRadPerSec * dt + 1e-12);
    pState = result.state;
  }
  const restored = retunePitchControllerState(pState, measurements.rotorSpeedRadPerSec, base);
  const restoredStep = stepPitchController(restored, measurements, base, dt);
  assert(Math.abs(restoredStep.control.collectivePitchRad - pState.previousPitchRad) <= base.pitchKi * 0.03 * dt + 1e-12);
  console.log('PASS: gain transfer at pitch limits, filtered floating feedback, tiny Ki, Ki = 0, and integral re-enable');

  // The browser and offline paths must agree at every worker sample when their
  // wind, initial conditions, and pitch integral preload are identical.
  const { loadAeroTable } = await server.ssrLoadModule('/src/sim/aero.ts');
  const { createClosedLoopScenario, runSimulationScenario } = await server.ssrLoadModule('/src/sim/simulation.ts');
  const { createWindEstimatorConfig } = await server.ssrLoadModule('/src/sim/windEstimator.ts');
  const aeroTable = await loadAeroTable(DEFAULT_TUNABLE_PARAMETERS.aero.filePath);
  for (const mode of ['constant', 'gust', 'random']) {
    const initialPitchDeg = mode === 'constant' ? defaults.initialCollectivePitchDeg : 8;
    const enabled = mode !== 'constant';
    await request({ type: 'update-settings', settings: {
      ...defaults, windMode: mode, meanWindSpeedMps: 14, initialCollectivePitchDeg: initialPitchDeg,
      floatingFeedbackEnabled: enabled, platformPitchRateGainS: 5,
    } });
    await request({ type: 'reset' }, 'ready');
    const pitch = { ...base, floatingFeedbackEnabled: enabled, platformPitchRateGainS: 5 };
    const wind = { mode, meanWindSpeedMps: 14 };
    if (mode === 'random') Object.assign(wind, {
      mode: 'turbulent', turbulenceIntensity: defaults.turbulenceIntensity, seed: 12345, lowPassTimeConstantSec: 2.5,
    });
    if (mode === 'gust') Object.assign(wind, {
      gustAmplitudeMps: defaults.gustAmplitudeMps, gustStartTimeSec: defaults.gustStartTimeS, gustDurationSec: defaults.gustDurationS,
    });
    const scenario = createClosedLoopScenario({
      name: `worker parity ${mode}`, totalTimeS: 48, dtS: defaults.dtS, wind,
      params: DEFAULT_TUNABLE_PARAMETERS, controllerConfig: pitch, initialPitchRad: initialPitchDeg * (Math.PI / 180),
    });
    scenario.controller.initialControllerState = retunePitchControllerState(
      createPitchControllerState(pitch, scenario.controller.initialPitchRad), base.rotorSpeedRefRadPerSec, pitch,
    );
    scenario.windEstimator = createWindEstimatorConfig(DEFAULT_TUNABLE_PARAMETERS);
    const offline = runSimulationScenario({ scenario, params: DEFAULT_TUNABLE_PARAMETERS, aeroTable });
    assert.deepEqual(latest.sample, offline.samples[0]);
    await request({ type: 'start' }, 'status');
    for (let i = 1; i <= 150; i++) assert.deepEqual(advance(), offline.samples[i * 16], `${mode} worker sample ${i}`);
    await request({ type: 'stop' }, 'status');
  }
  console.log('PASS: exact worker/offline parity across 450 samples (constant, gust, random; custom Reset pitch and floating feedback)');

  const { runTurbineControllerChecks } = await server.ssrLoadModule('/src/dev/runTurbineControllerChecks.ts');
  await runTurbineControllerChecks();

  for (const name of ['runWindChecks', 'runWindResponseChecks', 'runControllerChecks', 'runClosedLoopWindChecks', 'runSimulationScenarioChecks', 'runFloatingFeedbackChecks']) {
    const suite = await server.ssrLoadModule(`/src/dev/${name}.ts`);
    await suite[name]();
  }
  console.log('PASS: all six existing simulation suites');
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf === undefined) delete globalThis.self;
  else globalThis.self = originalSelf;
  await server.close();
}
