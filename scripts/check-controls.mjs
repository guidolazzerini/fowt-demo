// Render actual React components without a browser. This checks the delivered
// markup and input contract, not layout, focus behavior or click interactions.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { checkDiagnostics } from './check-diagnostics.mjs';

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { ControlsPanel } = await server.ssrLoadModule('/src/ui/ControlsPanel.tsx');
  const { SimulationToolbar } = await server.ssrLoadModule('/src/ui/SimulationToolbar.tsx');
  const { DEFAULT_SIMULATION_UI_SETTINGS: defaults } = await server.ssrLoadModule('/src/sim/workerMessages.ts');
  const { SETTING_RANGES } = await server.ssrLoadModule('/src/sim/settingRanges.ts');
  let updates = 0;
  const render = settings => renderToStaticMarkup(createElement(ControlsPanel, {
    settings, onSettingsChange: () => updates++, controllerBandwidthEstimate: undefined,
  }));
  for (const strategy of ['legacy-above-rated', 'coordinated-tsr-pi']) {
    for (const windMode of ['constant', 'gust', 'random']) {
      const markup = render({ ...defaults, strategy, windMode });
      assert.equal([...markup.matchAll(/role="tab"/g)].length, 5);
      assert.equal([...markup.matchAll(/role="tabpanel"/g)].length, 5);
      assert.equal([...markup.matchAll(/aria-selected="true"/g)].length, 1);
      assert.equal([...markup.matchAll(/role="tabpanel"[^>]*hidden=""/g)].length, 4);
      for (const [, target] of markup.matchAll(/aria-controls="([^"]+)"/g)) assert(markup.includes('id="' + target + '"'));
      const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
      assert.equal(new Set(ids).size, ids.length, 'Unique panel and form control IDs');
      assert.equal(markup.includes('Gust amplitude'), windMode === 'gust');
      assert.equal(markup.includes('Turbulence intensity'), windMode === 'random');
      assert.equal(markup.includes('Apply SUGGESTED gains'), strategy === 'coordinated-tsr-pi');
      const sourceSelect = markup.match(/<span>Controller wind input<\/span>(<select[^>]*>)/)?.[1];
      assert(sourceSelect);
      assert.equal(sourceSelect.includes('disabled'), strategy === 'legacy-above-rated');
      assert(markup.includes('COFLEX estimated rotor-effective wind'));
      assert(!/<details[^>]*\sopen[=> ]/.test(markup), 'Help starts collapsed');
      const windInput = markup.match(/<input[^>]*type="number"[^>]*aria-label="Mean wind speed \(m\/s\)"[^>]*>/)?.[0];
      assert(windInput);
      for (const key of ['min', 'max', 'step']) assert(windInput.includes(key + '="' + SETTING_RANGES.meanWindSpeedMps[key] + '"'));
      // All numeric inputs have their own accessible names; no label wraps two inputs.
      for (const [input] of markup.matchAll(/<input[^>]*type="number"[^>]*>/g)) assert(input.includes('aria-label='));
    }
  }
  assert.equal(updates, 0, 'Rendering settings must not write to the worker');
  assert.equal(defaults.strategy, 'coordinated-tsr-pi');
  assert.equal(defaults.gainSchedulingEnabled, false);
  const scheduled = render({ ...defaults, gainSchedulingEnabled: true, meanWindSpeedMps: 18 });
  assert(scheduled.includes('Advanced: legacy controller'));
  assert(scheduled.includes('Stable demo baseline'));
  assert(scheduled.includes('For current filtered wind'));
  assert.match(scheduled, /<option value="scheduled" selected="">/);
  assert.match(scheduled, /<button[^>]*disabled=""[^>]*>Apply SUGGESTED gains/);
  for (const label of ['Pitch Kp', 'Pitch Ki', 'Torque Kp', 'Torque Ki', 'Pitch-rate gain']) {
    const input = [...scheduled.matchAll(/<input[^>]*type="number"[^>]*>/g)]
      .map(match => match[0]).find(input => input.includes(`aria-label="${label} (`));
    assert(input?.includes('disabled=""'), `${label} shows an automatic read-only value`);
  }
  assert.match(scheduled, /aria-label="Pitch Kp \(s\)"[^>]*value="1.5"/);
  const operation = { activeStrategy: 'coordinated-tsr-pi', region: 'Unsupported operation',
    message: 'Set wind within 3.2–24.8 m/s and Reset.', canStart: false, requiresReset: true };
  const toolbar = renderToStaticMarkup(createElement(SimulationToolbar, { simulation: {
    operation, runState: 'stopped', isRunning: false, latestSample: { timeS: 10 },
    startSimulation() {}, stopSimulation() {}, resetSimulation() {},
  } }));
  assert.match(toolbar, /<button[^>]*disabled=""[^>]*>Start<\/button>/);
  assert.match(toolbar, /<p[^>]*role="alert"[^>]*>Set wind within/);
  assert(toolbar.indexOf('role="alert"') < toolbar.indexOf('<details'), 'Required action is outside collapsed help');
  assert(toolbar.includes('Coordinated TSR PI · 3–25 m/s'));
  const parkedToolbar = renderToStaticMarkup(createElement(SimulationToolbar, { simulation: {
    operation: { ...operation, region: 'Parked', canStart: true, requiresReset: false,
      turbinePhase: 'parked', canStartTurbine: true, canShutDown: false },
    runState: 'stopped', isRunning: false, latestSample: { timeS: 0 },
    startSimulation() {}, stopSimulation() {}, resetSimulation() {}, startTurbine() {}, shutdownTurbine() {},
  } }));
  assert.match(parkedToolbar, /<button[^>]*>Start turbine<\/button>/);
  assert.match(parkedToolbar, /<button[^>]*disabled=""[^>]*>Shut down turbine<\/button>/);
  const { FowtSchematic } = await server.ssrLoadModule('/src/ui/FowtSchematic.tsx');
  const parkedSchematic = renderToStaticMarkup(createElement(FowtSchematic, { history: [], sample: {
    timeS: 0, rotorSpeedRadPerSec: 0, rotorAzimuthRad: 0, collectivePitchRad: Math.PI / 2,
    platformPitchRad: 0, platformPitchRateRadPerSec: 0,
  } }));
  assert(parkedSchematic.includes('90.0°'), 'Schematic must not clamp feathered pitch to 30 degrees');
  console.log('PASS: five linked tabs, initial visibility, unique labeled inputs, contextual wind controls, shared bounds, collapsed help and visible boundary alert');
  console.log('NOTE: static rendering only; browser interaction and responsive visual inspection remain manual.');
  await checkDiagnostics(server);
} finally {
  await server.close();
}
