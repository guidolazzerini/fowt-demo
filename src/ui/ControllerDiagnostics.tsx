import { useState } from "react";
import type { BrowserOperation } from "../sim/generatingEnvelope";
import type { SimulationScenarioSample } from "../sim/simulation";
import type { SimulationUiSettings } from "../sim/workerMessages";
import { DEFAULT_TUNABLE_PARAMETERS as parameters } from "../sim/defaults";
import { diagnosticSignals } from "./diagnosticSignals";
import { MiniPlot, type PlotSeries } from "./PlotPanel";
import { InfoDisclosure } from "./InfoDisclosure";

interface DiagnosticProps {
  history: SimulationScenarioSample[];
  operation: BrowserOperation | undefined;
  settings: SimulationUiSettings;
}

export function ControllerDiagnostics(props: DiagnosticProps) {
  const [expanded, setExpanded] = useState(false);
  return <section className="panel diagnostics-panel" aria-labelledby="diagnostics-heading">
    <div className="panel-header">
      <h2 id="diagnostics-heading">Controller diagnostics</h2>
      <button type="button" className="secondary-button" aria-expanded={expanded} aria-controls="controller-diagnostic-content"
        onClick={() => setExpanded(previous => !previous)}>{expanded ? "Hide diagnostics" : "Show diagnostics"}</button>
    </div>
    <div id="controller-diagnostic-content" hidden={!expanded}>
      {/* Avoid preparing/drawing the extra histories while the panel is closed.
          Opening changes only view state, never worker settings or history. */}
      {expanded && <DiagnosticContent {...props} />}
    </div>
  </section>;
}

export function DiagnosticContent({ history, operation, settings }: DiagnosticProps) {
  const rows = history.map(sample => ({ timeS: sample.timeS, signals: diagnosticSignals(sample) }));
  const latest = rows.at(-1)?.signals;
  const lastSample = history.at(-1);
  if (!latest || !lastSample) return <p className="empty-state">Waiting for a simulation sample.</p>;

  type NumericSignal = { [Key in keyof typeof latest]: typeof latest[Key] extends number ? Key : never }[keyof typeof latest];
  const values = (key: NumericSignal) => rows.map(row => ({ timeS: row.timeS, value: row.signals[key] }));
  const constant = (value: number) => rows.map(row => ({ timeS: row.timeS, value }));
  const plots: PlotSeries[] = [
    { title: "Wind estimate and control input", unit: "m/s", label: "COFLEX rotor-effective estimate",
      values: history.map(sample => ({ timeS: sample.timeS,
        value: sample.windEstimator && sample.windEstimator.status !== "held" ? sample.windEstimator.estimatedWindMps : NaN })),
      overlays: [{ label: "Actual rotor-effective wind", values: history.map(sample => ({ timeS: sample.timeS, value: sample.effectiveWindSpeedMps })) },
        { label: "Simulated free-stream wind", values: history.map(sample => ({ timeS: sample.timeS, value: sample.windSpeedMps })) },
        { label: "Filtered controller wind", values: history.map(sample => ({ timeS: sample.timeS,
          value: sample.controllerDiagnostics?.strategy === "coordinated-tsr-pi" ? sample.controllerDiagnostics.torque.filteredWindMps : NaN })) }] },
    { title: "Speed and controller references", unit: "rpm", label: "Rotor", values: values("rotorRpm"),
      overlays: [{ label: "Torque reference", values: values("torqueRefRpm") }, { label: "Pitch reference", values: values("pitchRefRpm") }] },
    { title: "Tip-speed ratio", unit: "–", label: "Using filtered controller wind", values: values("controlTsr"),
      overlays: [{ label: "TSR target", values: values("targetTsr") }, { label: "Using rotor-effective wind", values: values("aerodynamicTsr") }] },
    { title: "Generator torque", unit: "MN m", label: "Applied (rotor side)", values: values("torqueMNm"),
      overlays: [{ label: "Normal operating cap", values: constant(Math.min(parameters.ratedGeneratorTorqueNm, parameters.maxGeneratorTorqueNm) / 1e6) },
        { label: "Absolute actuator ceiling", values: constant(parameters.maxGeneratorTorqueNm / 1e6) }] },
    { title: "Pitch command and demand", unit: "deg", label: "Applied command", values: values("pitchCommandDeg"),
      overlays: [{ label: "Unlimited demand", values: values("pitchDemandDeg") }, { label: "Coordinated pitch floor", values: values("pitchFloorDeg") }] },
    { title: "Pitch demand contributions", unit: "deg", label: "Proportional", values: values("pitchPDeg"),
      overlays: [{ label: "Integral", values: values("pitchIDeg") }, { label: "Floating feedback", values: values("pitchFloatingDeg") },
        { label: "Bias", values: values("pitchBiasDeg") }] },
    { title: "Set-point smoothing offset", unit: "rpm", label: "Applied offset", values: values("smoothingOffsetRpm"),
      overlays: [{ label: "Raw offset (before enable switch)", values: values("rawSmoothingOffsetRpm") }] },
  ];
  const indicators = [
    ["Pitch saturation", latest.pitchSaturated], ["Pitch rate limit", latest.pitchRateLimited],
    ["Pitch integral held", latest.pitchIntegralHeld], ["Pitch at floor", latest.pitchAtFloor],
    ["Torque saturation", latest.torqueSaturated], ["Torque rate limit", latest.torqueRateLimited],
    ["Torque integral held", latest.torqueIntegralHeld], ["Torque at operating cap", latest.torqueAtCap],
  ] as const;
  const strategyName = (strategy: string | undefined) => strategy === "coordinated-tsr-pi" ? "Coordinated TSR PI" :
    strategy === "legacy-above-rated" ? "Legacy above-rated" : "Awaiting initialization";

  return <>
    <dl className="diagnostic-context">
      <div><dt>Active strategy</dt><dd>{strategyName(operation?.activeStrategy)}</dd></div>
      <div><dt>Selected strategy</dt><dd>{strategyName(settings.strategy)}</dd></div>
      <div><dt>Operating region</dt><dd>{operation?.region ?? "—"}</dd></div>
      <div><dt>Latest controller wind input</dt><dd>{lastSample.controllerDiagnostics?.strategy === "coordinated-tsr-pi" ?
        (lastSample.controllerDiagnostics.torque.windInputSource === "coflex-estimate" ? "COFLEX estimated rotor-effective wind" : "Simulated free-stream wind") : "Inactive / awaiting generating control"}</dd></div>
    </dl>
    <p className="setting-timing">Latest applied control step · displayed at {lastSample.timeS.toFixed(2)} s
      {operation?.requiresReset ? " · frozen / Reset required" : ""}
      {!lastSample.controllerDiagnostics ? (lastSample.operatingSequence ? " · PI diagnostics available in generating phase" : " · controller diagnostics available after Start") : ""}</p>
    {lastSample.operatingSequence && <p className="setting-timing">Sequence: {lastSample.operatingSequence.phase} ·
      aerodynamic model: {lastSample.operatingSequence.approximateAerodynamics || lastSample.operatingSequence.phase !== "generating" ? "transient approximation" : "generating table"} ·
      parking brake {(lastSample.operatingSequence.mechanicalBrakeTorqueNm / 1e6).toFixed(3)} MN m</p>}
    {lastSample.operatingSequence?.supervisor && <dl className="diagnostic-context">
      <div><dt>Available torque · 20 s mean</dt><dd>{(lastSample.operatingSequence.supervisor.availableTorqueMeanNm / 1e6).toFixed(3)} MN m
        · start ≥0.080 · {lastSample.operatingSequence.supervisor.availableObservedS.toFixed(0)}/20 s observed</dd></div>
      <div><dt>Actual aerodynamic torque · 20 s mean</dt><dd>{(lastSample.operatingSequence.supervisor.aerodynamicTorqueMeanNm / 1e6).toFixed(3)} MN m
        · stop &lt;0.040 · {lastSample.operatingSequence.supervisor.generatingObservedS.toFixed(0)}/20 s generating</dd></div>
      <div><dt>Storm wind · 100 s exponential filter</dt><dd>{lastSample.operatingSequence.supervisor.stormWindMps.toFixed(2)} m/s
        · {lastSample.operatingSequence.supervisor.stormBlocked ? "Restart blocked until ≤23 m/s" : "Clear"}</dd></div>
    </dl>}
    <p className="setting-timing">COFLEX estimator: {lastSample.windEstimator ?
      `${lastSample.windEstimator.status} · ${lastSample.windEstimator.estimatedWindMps.toFixed(2)} m/s · ${lastSample.windEstimator.reason}` :
      "awaiting a simulation step"}.</p>
    <dl className="diagnostic-indicators">
      {indicators.map(([label, active]) => <div key={label} className={active ? "limit-active" : ""}>
        <dt>{label}</dt><dd>{active === undefined ? "N/A" : active ? "Active" : "Inactive"}</dd>
      </div>)}
    </dl>
    <InfoDisclosure label="How to read these diagnostics">
      <p>The COFLEX estimate is rotor-effective wind from a 3D Cp torque-balance model (Lazzerini et al., 2025, Eq. 10).
        Held estimates leave gaps in the plot. Tracking means the observer is running, not that accuracy is guaranteed.</p>
      <p>Control TSR uses the selected wind filtered over 5 s; aerodynamic TSR uses actual rotor-effective wind.
        Speed limits can prevent target TSR tracking.</p>
      <p>Estimated-wind control uses the previous completed step's estimate. Held or limited estimates remain selected;
        startup and protection retain their existing signals. Reset starts the controller filter at the simulated equilibrium wind.</p>
      <p>Pitch demand = bias + proportional + integral + floating feedback. Applied pitch also obeys the floor, limits and rate limit.</p>
      <p>Positive smoothing offset lowers the torque reference; negative offset raises the pitch reference.
        Disabled smoothing applies zero offset; the raw offset remains visible.</p>
      <p>Saturation: demand was limited. At cap/floor: command reached its bound. Integral held: anti-windup is active.
        Indicators show the latest sampled step, so brief events may be missed.</p>
      <p>N/A means the signal is inactive or unavailable. PI details appear after startup handover.
        Controller references precede the displayed physical state by one integration step.</p>
    </InfoDisclosure>
    <div className="plot-grid diagnostic-plots">{plots.map(series => <MiniPlot key={series.title} series={series} />)}</div>
  </>;
}
