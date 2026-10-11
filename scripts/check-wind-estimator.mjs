import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { checkEstimatedWindControl } from './check-estimated-wind-control.mjs';

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(await readFile(new URL('../public/iea15mw-aero-v1.json', import.meta.url)));
try {
  const { DEFAULT_TUNABLE_PARAMETERS: params } = await server.ssrLoadModule('/src/sim/defaults.ts');
  const { loadAeroTable, getAeroCoefficients } = await server.ssrLoadModule('/src/sim/aero.ts');
  const { createCoordinatedScenario } = await server.ssrLoadModule('/src/sim/coordinated.ts');
  const { runSimulationScenario } = await server.ssrLoadModule('/src/sim/simulation.ts');
  const { createWindEstimatorConfig, createWindEstimatorState, stepWindEstimator, retuneWindEstimator } =
    await server.ssrLoadModule('/src/sim/windEstimator.ts');
  const table = await loadAeroTable(params.aero.filePath);
  const config = createWindEstimatorConfig(params);
  const rms = values => Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
  for (const wind of [3, 5, 8, 10.5, 12, 18, 25]) {
    const { scenario } = createCoordinatedScenario({ name: 'WSE constant', totalTimeS: 300, dtS: .02,
      wind: { mode: 'constant', meanWindSpeedMps: wind }, params, aeroTable: table });
    const result = runSimulationScenario({ scenario: { ...scenario, windEstimator: config }, params, aeroTable: table });
    const tail = result.samples.filter(s => s.timeS > 200);
    const error = rms(tail.map(s => s.windEstimator.estimatedWindMps - s.effectiveWindSpeedMps));
    assert(error < .03, `${wind} m/s: steady error ${error}`);
    assert(result.samples.slice(1).every(s => Number.isFinite(s.windEstimator.estimatedWindMps)));
    console.log(`PASS: ${wind} m/s from independent 8 m/s guess, final-100-s RMSE ${error.toFixed(4)} m/s`);
  }
  for (const mean of [8, 18]) {
    for (const mode of ['gust', 'turbulent']) {
      const wind = { mode, meanWindSpeedMps: mean, gustStartTimeSec: 100, gustDurationSec: 100,
        gustAmplitudeMps: 2, turbulenceIntensity: .06, seed: 12345, lowPassTimeConstantSec: 2.5 };
      const { scenario } = createCoordinatedScenario({ name: 'WSE dynamic', totalTimeS: 300, dtS: .02,
        wind, params, aeroTable: table });
      const observed = runSimulationScenario({ scenario: { ...scenario, windEstimator: config }, params, aeroTable: table });
      const baseline = runSimulationScenario({ scenario, params, aeroTable: table });
      assert.deepEqual(observed.samples.map(({ windEstimator: _estimate, ...physical }) => physical), baseline.samples,
        'Observer must not change any physical, controller or disturbance sample');
      const tail = observed.samples.filter(s => s.timeS > 100);
      const error = rms(tail.map(s => s.windEstimator.estimatedWindMps - s.effectiveWindSpeedMps));
      assert(error < .6, `${mode} ${mean}: dynamic RMSE ${error}`);
      assert(tail.every(s => s.windEstimator.status === 'tracking'));
      console.log(`PASS: ${mode} ${mean} m/s, RMSE ${error.toFixed(4)} m/s; controller/plant exactly unchanged`);
    }
  }
  // Large initial errors and two time steps exercise convergence without truth-based initialization.
  for (const [wind, guess] of [[3, 12], [25, 3]]) {
    for (const dtS of [.01, .02]) {
      const { scenario } = createCoordinatedScenario({ name: 'WSE initialization', totalTimeS: 300, dtS,
        wind: { mode: 'constant', meanWindSpeedMps: wind }, params, aeroTable: table });
      const result = runSimulationScenario({ scenario: { ...scenario, windEstimator: { ...config, initialWindMps: guess } }, params, aeroTable: table });
      assert(Math.abs(result.samples.at(-1).windEstimator.estimatedWindMps - wind) < .03,
        JSON.stringify({ wind, guess, dtS, final: result.samples.at(-1).windEstimator }));
    }
  }
  console.log('PASS: convergence from 12 to 3 and 3 to 25 m/s at dt = 0.01 and 0.02 s');
  // This nonlinear observer has no guaranteed global basin of convergence.
  // Preserve and expose a known poor-initialization case instead of masking it
  // with the simulator's true wind or an undocumented observer reset.
  const poorStart = createCoordinatedScenario({ name: 'WSE poor guess', totalTimeS: 300, dtS: .02,
    wind: { mode: 'constant', meanWindSpeedMps: 3 }, params, aeroTable: table }).scenario;
  const poorResult = runSimulationScenario({ scenario: { ...poorStart, windEstimator: { ...config, initialWindMps: 20 } }, params, aeroTable: table });
  assert.equal(poorResult.samples.at(-1).windEstimator.status, 'limited');
  assert(poorResult.samples.every(s => !s.windEstimator || (Number.isFinite(s.windEstimator.estimatedWindMps) &&
    s.windEstimator.estimatedWindMps >= 2 && s.windEstimator.estimatedWindMps <= 27)));
  console.log('PASS: poor 20 m/s guess at 3 m/s stays bounded and reports limited (known convergence limitation)');
  // Equation sign/units: a perfectly matched Cp torque at constant speed holds
  // the initial estimate exactly; use a plant independent of Cq interpolation.
  const omega = .7, pitch = .1, wind = 9;
  const cp = getAeroCoefficients(table, { rotorSpeedRadPerSec: omega, pitchRad: pitch, windSpeedMps: wind }).cp;
  const torque = .5 * params.airDensityKgPerM3 * Math.PI * params.rotorRadiusM ** 2 * wind ** 3 * cp / omega;
  const exactConfig = { ...config, initialWindMps: wind };
  const initial = createWindEstimatorState(omega, exactConfig, table);
  const measured = { rotorSpeedRadPerSec: omega, pitchRad: pitch, generatorTorqueNm: torque, generating: true };
  const exact = stepWindEstimator(initial, measured, exactConfig, table, .02);
  assert.equal(exact.state.estimatedWindMps, wind);
  const faster = stepWindEstimator(initial, { ...measured, rotorSpeedRadPerSec: omega + .001 }, exactConfig, table, .02);
  assert(faster.state.estimatedWindMps > wind, 'Positive speed prediction error increases estimated wind');
  const retuned = retuneWindEstimator(faster.state, { ...config, kpMPerRad: 150 });
  assert(Math.abs(150 * (retuned.previousMeasuredSpeedRadPerSec - retuned.estimatedRotorSpeedRadPerSec) +
    retuned.integralWindMps - faster.state.estimatedWindMps) < 1e-12);
  const pOnlyConfig = { ...exactConfig, kiMPerRadSec: 0 };
  const pOnly = createWindEstimatorState(omega, pOnlyConfig, table);
  assert.equal(pOnly.integralWindMps, 0);
  const pOnlyStep = stepWindEstimator(pOnly, measured, pOnlyConfig, table, .02);
  assert(Math.abs(pOnlyStep.state.estimatedWindMps - wind) < 1e-12);
  assert.equal(pOnlyStep.state.integralWindMps, 0);
  assert(pOnlyStep.diagnostics.integralHeld);
  let transfer = faster.state;
  for (const tuning of [{ ...pOnlyConfig, kpMPerRad: 150 }, { ...pOnlyConfig, kpMPerRad: 80 }, exactConfig]) {
    transfer = retuneWindEstimator(transfer, tuning);
    const output = tuning.kpMPerRad * (transfer.previousMeasuredSpeedRadPerSec - transfer.estimatedRotorSpeedRadPerSec) + transfer.integralWindMps;
    assert(Math.abs(output - faster.state.estimatedWindMps) < 1e-12, 'No output jump across PI/P-only/Kp changes');
    if (tuning.kiMPerRadSec === 0) assert.equal(transfer.integralWindMps, 0);
  }
  const parkedP = stepWindEstimator(pOnly, { ...measured, rotorSpeedRadPerSec: 0, generating: false }, pOnlyConfig, table, .02);
  assert.equal(parkedP.state.integralWindMps, 0);
  assert.equal(parkedP.state.estimatedWindMps, wind);
  // First supported measurement recenters after the unsupported zero-speed interval.
  const resumeP = stepWindEstimator(parkedP.state, measured, pOnlyConfig, table, .02);
  assert(Math.abs(stepWindEstimator(resumeP.state, measured, pOnlyConfig, table, .02).state.estimatedWindMps - wind) < 1e-12);
  for (const invalid of [{ ...config, kpMPerRad: 0 }, { ...config, kpMPerRad: -1 }, { ...config, kiMPerRadSec: -1 }]) {
    assert.throws(() => createWindEstimatorConfig(params, invalid), /Kp > 0 and Ki >= 0/);
    assert.throws(() => createWindEstimatorState(omega, invalid, table), /Kp > 0 and Ki >= 0/);
    assert.throws(() => retuneWindEstimator(initial, invalid), /Kp > 0 and Ki >= 0/);
    assert.throws(() => stepWindEstimator(initial, measured, invalid, table, .02), /Kp > 0 and Ki >= 0/);
  }
  console.log('PASS: Ki=0 clears integral, preserves output through gain transfers/hold/resume, and Kp=0 is rejected');
  for (const measurements of [{ ...measured, rotorSpeedRadPerSec: 0 }, { ...measured, pitchRad: Math.PI / 2 },
    { ...measured, generating: false }]) {
    const held = stepWindEstimator(initial, measurements, config, table, .02);
    assert.equal(held.diagnostics.status, 'held');
    assert.equal(held.state.estimatedWindMps, initial.estimatedWindMps);
  }
  assert.throws(() => stepWindEstimator(initial, { ...measured, rotorSpeedRadPerSec: NaN }, config, table, .02));
  for (const delta of [-.2, .2]) {
    const limited = stepWindEstimator(initial, { ...measured, rotorSpeedRadPerSec: omega + delta }, exactConfig, table, .02);
    assert.equal(limited.diagnostics.status, 'limited');
    assert(limited.diagnostics.integralHeld);
    assert.equal(limited.state.integralWindMps, initial.integralWindMps);
    assert.equal(limited.state.estimatedWindMps, delta < 0 ? 2 : 27);
    const recovered = stepWindEstimator(limited.state, measured, exactConfig, table, .02);
    assert.equal(recovered.diagnostics.status, 'tracking');
  }
  console.log('PASS: Eq. (10) torque/sign, bumpless manual retuning, standstill/feather hold and invalid-input rejection');
  await checkEstimatedWindControl(server, params, table, config);
  console.log('Repeat closed-loop matrix with estimator Ki = 0 and Kp = 100:');
  await checkEstimatedWindControl(server, params, table, { ...config, kiMPerRadSec: 0 });
} finally { globalThis.fetch = originalFetch; await server.close(); }
