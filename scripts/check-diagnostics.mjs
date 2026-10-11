import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Called by check:controls using its existing Vite loader. Exercise display
// conversions against real controller/scenario output, then render React SVG.
export async function checkDiagnostics(server) {
  const { diagnosticSignals, generatorMechanicalPowerW, finitePlotSegments } =
    await server.ssrLoadModule('/src/ui/diagnosticSignals.ts');
  const { ControllerDiagnostics, DiagnosticContent } = await server.ssrLoadModule('/src/ui/ControllerDiagnostics.tsx');
  const { PlotPanel, MiniPlot } = await server.ssrLoadModule('/src/ui/PlotPanel.tsx');
  const { StatusPanel } = await server.ssrLoadModule('/src/ui/StatusPanel.tsx');
  const { DEFAULT_SIMULATION_UI_SETTINGS: defaults } = await server.ssrLoadModule('/src/sim/workerMessages.ts');
  const { DEFAULT_TUNABLE_PARAMETERS: params } = await server.ssrLoadModule('/src/sim/defaults.ts');
  const { createCoordinatedScenario, createCoordinatedControllerConfig } = await server.ssrLoadModule('/src/sim/coordinated.ts');
  const { createClosedLoopScenario, runSimulationScenario } = await server.ssrLoadModule('/src/sim/simulation.ts');
  const { loadAeroTable } = await server.ssrLoadModule('/src/sim/aero.ts');
  const originalFetch = globalThis.fetch;
  let table;
  try {
    globalThis.fetch = async path => {
      assert.equal(path, params.aero.filePath);
      return new Response(await readFile(new URL('../public/iea15mw-aero-v1.json', import.meta.url)));
    };
    table = await loadAeroTable(params.aero.filePath);
  } finally { globalThis.fetch = originalFetch; }
  const render = (component, props) => renderToStaticMarkup(createElement(component, props));
  const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, actual + ' vs ' + expected);
  const cases = [
    { speed: 3, coordinated: true, smoothing: true },
    { speed: 10.5, coordinated: true, smoothing: true },
    { speed: 18, coordinated: true, smoothing: false },
    { speed: 14, coordinated: false, smoothing: false },
  ];
  let sampleCount = 0;
  for (const test of cases) {
    const wind = { mode: 'gust', meanWindSpeedMps: test.speed, gustAmplitudeMps: 1, gustStartTimeSec: 5, gustDurationSec: 25 };
    const args = { name: 'diagnostic display', wind, params, aeroTable: table, totalTimeS: 48, dtS: .02 };
    const config = createCoordinatedControllerConfig(params, table);
    config.smoother.enabled = test.smoothing;
    const scenario = test.coordinated ? createCoordinatedScenario({ ...args, config }).scenario : createClosedLoopScenario(args);
    const result = runSimulationScenario({ scenario, params, aeroTable: table });
    // Match the browser's usual 16 steps/post, retaining Reset's missing diagnostics.
    const history = result.samples.filter((_, index) => index % 16 === 0);
    for (const sample of history) {
      const s = diagnosticSignals(sample);
      near(s.rotorRpm, sample.rotorSpeedRadPerSec * 30 / Math.PI);
      near(s.torqueMNm, sample.generatorTorqueNm / 1e6);
      near(s.pitchCommandDeg, sample.collectivePitchRad * 180 / Math.PI);
      near(generatorMechanicalPowerW(sample), sample.generatorTorqueNm * sample.rotorSpeedRadPerSec);
      const d = sample.controllerDiagnostics;
      if (!d) {
        assert(Number.isNaN(s.pitchRefRpm) && Number.isNaN(s.torqueRefRpm));
        assert.equal(s.pitchSaturated, undefined);
        continue;
      }
      const pitch = test.coordinated ? d.pitch : d;
      near(s.pitchBiasDeg + s.pitchPDeg + s.pitchIDeg + s.pitchFloatingDeg, pitch.unsaturatedPitchDemandRad * 180 / Math.PI);
      assert.equal(s.pitchSaturated, pitch.wasSaturated);
      assert.equal(s.pitchRateLimited, pitch.wasRateLimited);
      assert.equal(s.pitchIntegralHeld, pitch.integralWasHeld);
      if (test.coordinated) {
        near(s.pitchRefRpm, d.smoother.pitchSpeedRefRadPerSec * 30 / Math.PI);
        near(s.torqueRefRpm, d.smoother.torqueSpeedRefRadPerSec * 30 / Math.PI);
        near(s.controlTsr, sample.rotorSpeedRadPerSec * params.rotorRadiusM / d.torque.filteredWindMps);
        near(s.aerodynamicTsr, sample.rotorSpeedRadPerSec * params.rotorRadiusM / sample.effectiveWindSpeedMps);
        assert.equal(s.targetTsr, 9.5);
        assert.equal(s.torqueSaturated, d.torque.wasSaturated);
        assert.equal(s.torqueRateLimited, d.torque.wasRateLimited);
        near(s.smoothingOffsetRpm, d.smoother.offsetRadPerSec * 30 / Math.PI);
        if (!test.smoothing) assert.equal(s.smoothingOffsetRpm, 0);
      } else {
        assert(Number.isNaN(s.torqueRefRpm) && Number.isNaN(s.targetTsr) && Number.isNaN(s.smoothingOffsetRpm));
        assert.equal(s.torqueSaturated, undefined);
        near(s.pitchRefRpm, d.pitchSpeedRefRadPerSec * 30 / Math.PI);
      }
      sampleCount++;
    }
    const settings = { ...defaults, strategy: test.coordinated ? 'coordinated-tsr-pi' : 'legacy-above-rated' };
    const operation = { activeStrategy: settings.strategy, region: 'Test region', canStart: true, requiresReset: false, message: '' };
    const props = { history, settings, operation };
    const closed = render(ControllerDiagnostics, props);
    assert(closed.includes('aria-expanded="false"') && closed.includes('hidden=""'));
    assert(!closed.includes('<svg'), 'Closed diagnostics should not render charts');
    const opened = render(DiagnosticContent, props);
    for (const label of ['Torque reference', 'Pitch reference', 'TSR target', 'Applied (rotor side)',
      'Unlimited demand', 'Floating feedback', 'Raw offset', 'Torque rate limit', 'Test region']) assert(opened.includes(label));
    assert(!opened.includes('NaN') && !opened.includes('Infinity'), 'No invalid SVG/readout values');
    const plot = render(PlotPanel, { history, runState: 'stopped' });
    assert(plot.includes('Generator mechanical') && plot.includes('Aerodynamic'));
    assert(plot.includes('stroke-dasharray="8 4"'), 'Overlay has a distinct line style');
    const status = render(StatusPanel, { sample: history.at(-1), history, status: 'ready', runState: 'stopped', isRunning: false });
    assert(status.includes('Generator mechanical power') && status.includes('Generator torque'));
    const reset = render(DiagnosticContent, { ...props, history: [history[0]] });
    assert(reset.includes('available after Start') && reset.includes('N/A'));
    assert(!reset.includes('NaN'));
  }
  assert.equal(generatorMechanicalPowerW({ generatorTorqueNm: 2e6, rotorSpeedRadPerSec: .5, aerodynamicPowerW: 99e6 }), 1e6);
  assert.equal(generatorMechanicalPowerW({ generatorTorqueNm: 0, rotorSpeedRadPerSec: .5 }), 0);
  assert.equal(generatorMechanicalPowerW({ generatorTorqueNm: -2e6, rotorSpeedRadPerSec: .5 }), -1e6, 'Do not discard torque sign');
  const noWind = diagnosticSignals({ rotorSpeedRadPerSec: .5, generatorTorqueNm: 0, collectivePitchRad: 0, effectiveWindSpeedMps: 0 });
  assert(Number.isNaN(noWind.aerodynamicTsr), 'Zero wind has undefined TSR, not infinity');
  const points = [1, 2, NaN, 3, 4, NaN].map((value, timeS) => ({ value, timeS }));
  assert.deepEqual(finitePlotSegments(points).map(segment => segment.map(p => p.value)), [[1, 2], [3, 4]]);
  const gapPlot = render(MiniPlot, { series: { title: 'Missing values', unit: 'rpm', values: points } });
  assert.equal([...gapPlot.matchAll(/<path/g)].length, 2, 'No line across missing diagnostics');
  const lonePoint = render(MiniPlot, { series: { title: 'One sample', unit: 'rpm', values: [points[0]] } });
  assert(lonePoint.includes('<circle') && !lonePoint.includes('<path'), 'One sample remains a point');
  // Maximum retained history: every point survives, including a one-sample
  // peak. Check subpixel drawing precision separately from physical values.
  const fullHistory = Array.from({ length: 600 }, (_, index) => ({
    timeS: 1500 + index * .1, value: index === 301 ? 2 : Math.sin(index * .17),
  }));
  const compactPlot = render(MiniPlot, { series: { title: 'Full history', unit: 'rpm', values: fullHistory } });
  const path = compactPlot.match(/<path[^>]* d="([^"]+)"/)?.[1];
  assert(path && path.length < 9000, 'Bound SVG trace string size for 600 samples');
  const coordinates = [...path.matchAll(/[ML]([\d.]+) ([\d.]+)/g)];
  assert.equal(coordinates.length, fullHistory.length, 'No downsampling loses short peaks');
  const minimum = Math.min(...fullHistory.map(point => point.value));
  const maximum = 2;
  const padding = .08 * (maximum - minimum);
  coordinates.forEach((match, index) => {
    const expectedX = 58 + (fullHistory[index].timeS - fullHistory[0].timeS) /
      (fullHistory.at(-1).timeS - fullHistory[0].timeS) * 444;
    const expectedY = 146 - (fullHistory[index].value - minimum + padding) /
      (maximum - minimum + 2 * padding) * 128;
    assert(Math.abs(Number(match[1]) - expectedX) <= .005001);
    assert(Math.abs(Number(match[2]) - expectedY) <= .005001);
  });
  const stalePlot = render(MiniPlot, { series: { title: 'Unavailable latest', unit: 'rpm', values: points.slice(-3) } });
  assert(stalePlot.includes('<strong>--</strong>'), 'Do not substitute the last finite value for a missing current signal');
  const expiredStatistics = render(MiniPlot, { showStatistics: true,
    series: { title: 'Old data', unit: 'rpm', values: [{ timeS: 0, value: 1 }, { timeS: 100, value: NaN }] } });
  assert(expiredStatistics.includes('avg --'), 'Rolling statistics are anchored to display time, not an old finite sample');
  console.log('PASS: diagnostic conversions across ' + sampleCount + ' actual controller samples; power/sign/units, both TSR definitions, contributions, legacy N/A, smoothing off, SVG gaps, compact 600-point paths and collapsed default');
}
