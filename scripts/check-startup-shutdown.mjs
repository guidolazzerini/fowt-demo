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
  const { createCoordinatedControllerConfig } = await server.ssrLoadModule('/src/sim/coordinated.ts');
  const { createCoordinatedControllerState } = await server.ssrLoadModule('/src/sim/coordinatedController.ts');
  const { createOperatingSequence, requestStartup, requestShutdown, stepOperatingSequence, PARKING_SPEED_RAD_S } =
    await server.ssrLoadModule('/src/sim/operatingSequence.ts');
  const { transientAerodynamics } = await server.ssrLoadModule('/src/sim/transientAerodynamics.ts');
  const { OperatingSupervisor, TorqueWindow } = await server.ssrLoadModule('/src/sim/operatingSupervisor.ts');
  const table = await loadAeroTable(params.aero.filePath);
  const config = createCoordinatedControllerConfig(params, table);
  function parked(wind, dtS = .02) {
    return { supervisor: new OperatingSupervisor(), sequence: createOperatingSequence(), state: { timeS: 0, rotorSpeedRadPerSec: 0,
      rotorAzimuthRad: 0, platformPitchRad: 0, platformPitchRateRadPerSec: 0 },
    control: { collectivePitchRad: Math.PI / 2, generatorTorqueNm: 0 },
    controllerState: createCoordinatedControllerState(config, { windMps: wind, rotorSpeedRadPerSec: 0, pitchRad: 0, torqueNm: 0 }),
    config, params, table, dtS, environment: { windSpeedMps: wind, wavePitchMomentNm: 0 } };
  }
  function step(run) {
    const next = { ...run, ...stepOperatingSequence(run) };
    assert(Object.values(next.state).every(Number.isFinite));
    assert(next.state.rotorSpeedRadPerSec >= 0);
    assert(next.control.collectivePitchRad >= 0 && next.control.collectivePitchRad <= Math.PI / 2 + 1e-12);
    assert(next.control.generatorTorqueNm >= 0 && next.control.generatorTorqueNm <= config.torque.maxTorqueNm + 1e-6);
    assert(Math.abs(next.control.collectivePitchRad - run.control.collectivePitchRad) <= config.pitch.maxPitchRateRadPerSec * run.dtS + 1e-10);
    assert(Math.abs(next.control.generatorTorqueNm - run.control.generatorTorqueNm) <= config.torque.maxTorqueRateNmPerSec * run.dtS + 1e-5);
    if (next.sequence.mechanicalBrakeTorqueNm > 0) {
      assert(run.state.rotorSpeedRadPerSec <= PARKING_SPEED_RAD_S);
      assert(next.control.collectivePitchRad >= 85 * Math.PI / 180);
    }
    return next;
  }
  for (const wind of [3, 3.2, 5, 8, 12, 18, 24.8]) {
    let run = parked(wind);
    run.sequence = requestStartup(run.sequence);
    for (let i = 0; i < 61000 && run.sequence.phase !== 'generating'; i++) {
      run = step(run);
      assert(!['shutting-down', 'parked'].includes(run.sequence.phase), `Startup ${wind}: ${run.sequence.reason} at ${run.state.timeS}`);
    }
    assert.equal(run.sequence.phase, 'generating', 'Startup must finish at ' + wind);
    const startupTime = run.state.timeS;
    for (let i = 0; i < 15000; i++) run = step(run);
    assert.equal(run.sequence.phase, 'generating', 'Generating must remain supported at ' + wind + ': ' + run.sequence.reason);
    run.sequence = requestShutdown(run.sequence);
    const stopTime = run.state.timeS;
    let peakStopSpeed = run.state.rotorSpeedRadPerSec;
    for (let i = 0; i < 20000 && run.sequence.phase !== 'parked'; i++) {
      run = step(run);
      peakStopSpeed = Math.max(peakStopSpeed, run.state.rotorSpeedRadPerSec);
    }
    assert.equal(run.sequence.phase, 'parked');
    assert.equal(run.state.rotorSpeedRadPerSec, 0);
    assert.equal(run.control.generatorTorqueNm, 0);
    const atRest = transientAerodynamics(table, params, 0, Math.PI / 2, wind);
    assert.equal(atRest.powerW, 0);
    assert.equal(atRest.torqueNm, 0);
    console.log(`PASS: ${wind} m/s startup ${startupTime.toFixed(1)} s, 300 s generating, shutdown ${(run.state.timeS - stopTime).toFixed(1)} s, shutdown peak ${(peakStopSpeed * 30 / Math.PI).toFixed(2)} rpm`);
  }
  const window = new TorqueWindow();
  assert.deepEqual(window.push(10, 10), { meanNm: 10, observedS: 10 });
  assert.deepEqual(window.push(30, 15), { meanNm: 25, observedS: 20 });
  assert(Math.abs(window.push(-10, 10).meanNm - 10) < 1e-10, 'Partial oldest interval and signed torque');
  for (let i = 0; i < 100000; i++) window.push(7, .005);
  assert(window.samples.length < 8200, 'Bounded history at minimum browser timestep');
  assert(Math.abs(window.push(7, .1).meanNm - 7) < 1e-8, 'Changing dt preserves time weighting');
  let waiting = parked(0);
  waiting.sequence = requestStartup(waiting.sequence);
  for (let i = 0; i < 4000; i++) waiting = step(waiting);
  assert.equal(waiting.sequence.phase, 'waiting');
  assert.equal(waiting.state.rotorSpeedRadPerSec, 0);
  assert.equal(requestShutdown(waiting.sequence).phase, 'parked', 'Cancel an armed request');
  waiting.environment.windSpeedMps = 8;
  for (let i = 0; i < 15000 && waiting.sequence.phase !== 'generating'; i++) waiting = step(waiting);
  assert.equal(waiting.sequence.phase, 'generating', 'Armed request starts when resource returns');
  // Full-history running case: a short calm does not cause an immediate trip.
  for (let i = 0; i < 3000; i++) waiting = step(waiting);
  waiting.environment.windSpeedMps = 0;
  for (let i = 0; i < 500; i++) waiting = step(waiting);
  assert.equal(waiting.sequence.phase, 'generating', '10 s lull rides through');
  waiting.environment.windSpeedMps = 8;
  for (let i = 0; i < 6000; i++) waiting = step(waiting);
  assert.equal(waiting.sequence.phase, 'generating', 'Recovers from short lull');
  waiting.environment.windSpeedMps = 0;
  let elapsedCalm = 0;
  while (waiting.sequence.phase === 'generating' && elapsedCalm < 25) { waiting = step(waiting); elapsedCalm += .02; }
  assert.equal(waiting.sequence.phase, 'shutting-down');
  assert.match(waiting.sequence.reason, /Low aerodynamic torque/);
  assert(elapsedCalm > 10 && elapsedCalm <= 21, 'Sustained calm, not instantaneous wind, triggers shutdown');
  for (let i = 0; i < 20000 && waiting.sequence.phase !== 'parked'; i++) waiting = step(waiting);
  assert.equal(waiting.sequence.phase, 'parked');
  waiting.environment.windSpeedMps = 8;
  assert.equal(step(waiting).sequence.phase, 'parked', 'Restart requires an explicit armed request');
  const storm = new OperatingSupervisor();
  storm.step(1e6, 1e6, true, 24, 25, .02);
  let observed;
  for (let i = 0; i < 500; i++) observed = storm.step(1e6, 1e6, true, 26, 25, .02);
  assert(!observed.stormBlocked, '10 s gust across cut-out rides through');
  for (let i = 0; i < 10000; i++) observed = storm.step(1e6, 1e6, true, 26, 25, .02);
  assert(observed.stormBlocked, 'Sustained high wind trips independent storm protection');
  for (let i = 0; i < 10000; i++) observed = storm.step(1e6, 1e6, true, 24, 25, .02);
  assert(observed.stormBlocked, 'Storm restart hysteresis');
  for (let i = 0; i < 20000; i++) observed = storm.step(1e6, 1e6, true, 22, 25, .02);
  assert(!observed.stormBlocked);
  console.log('PASS: exact bounded 20 s averages, startup waiting/cancellation, 10 s calm recovery, sustained calm shutdown, storm averaging/hysteresis');
  let highWind = parked(24);
  highWind.sequence = requestStartup(highWind.sequence);
  for (let i = 0; i < 15000 && highWind.sequence.phase !== 'generating'; i++) highWind = step(highWind);
  assert.equal(highWind.sequence.phase, 'generating');
  for (let i = 0; i < 3000; i++) highWind = step(highWind);
  highWind.environment.windSpeedMps = 26;
  for (let i = 0; i < 500; i++) highWind = step(highWind);
  assert.equal(highWind.sequence.phase, 'generating', 'Physical sequence rides through short high-wind crossing');
  for (let i = 0; i < 10000 && highWind.sequence.phase === 'generating'; i++) highWind = step(highWind);
  assert.equal(highWind.sequence.phase, 'shutting-down');
  assert.match(highWind.sequence.reason, /Storm protection/);
  for (let i = 0; i < 20000 && highWind.sequence.phase !== 'parked'; i++) highWind = step(highWind);
  assert.equal(highWind.sequence.phase, 'parked');
  highWind.sequence = requestStartup(highWind.sequence);
  assert.equal(step(highWind).sequence.phase, 'waiting', 'Storm restart request stays armed and blocked');
  console.log('PASS: physical 24 to 26 m/s short crossing, sustained storm shutdown to parked, blocked restart');
  let halfStep = parked(12, .01);
  halfStep.sequence = requestStartup(halfStep.sequence);
  for (let i = 0; i < 15000 && halfStep.sequence.phase !== 'generating'; i++) halfStep = step(halfStep);
  assert.equal(halfStep.sequence.phase, 'generating');
  assert(Math.abs(halfStep.state.timeS - 76.7) < 2, 'Startup insensitive to halved integration step');
  const stoppedAero = transientAerodynamics(table, params, 0, .3, 8);
  assert(stoppedAero.torqueNm > 0 && stoppedAero.powerW === 0, 'Standstill torque without fictitious power');
  const feathered = transientAerodynamics(table, params, .5, Math.PI / 2, 8);
  assert(feathered.torqueNm < 0 && feathered.powerW < 0, 'Feathered aero dissipates rotor energy');
  let overspeed = parked(8);
  overspeed.sequence.phase = 'generating';
  overspeed.state.rotorSpeedRadPerSec = 1.21 * params.ratedRotorSpeedRadPerSec;
  overspeed.control.collectivePitchRad = .1;
  assert.equal(step(overspeed).sequence.reason, 'Overspeed above 120% rated');
  console.log('PASS: latched parking, overspeed trigger, power signs and half-timestep startup');
  const { createWindDisturbance, stepWindDisturbance } = await server.ssrLoadModule('/src/sim/wind.ts');
  for (const meanWindSpeedMps of [3.2, 8, 18, 24]) {
    const disturbance = createWindDisturbance({ mode: 'turbulent', meanWindSpeedMps,
      turbulenceIntensity: meanWindSpeedMps === 24 ? .04 : .12, lowPassTimeConstantSec: 2.5, seed: 12345 });
    let run = parked(meanWindSpeedMps);
    run.sequence = requestStartup(run.sequence);
    for (let i = 0; i < 60000 && run.sequence.phase !== 'generating'; i++) {
      run.environment = stepWindDisturbance(disturbance, .02).environment;
      run = step(run);
      assert(!['shutting-down', 'parked'].includes(run.sequence.phase), run.sequence.reason);
    }
    assert.equal(run.sequence.phase, 'generating', 'Turbulent startup must complete');
    const startedAt = run.state.timeS;
    for (let i = 0; i < 15000; i++) {
      run.environment = stepWindDisturbance(disturbance, .02).environment;
      run = step(run);
      assert.equal(run.sequence.phase, 'generating', `Turbulent ${meanWindSpeedMps}: ${run.sequence.reason}`);
    }
    console.log(`PASS: 300 s generation after seeded turbulent startup at ${meanWindSpeedMps} m/s in ${startedAt.toFixed(1)} s`);
  }
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
