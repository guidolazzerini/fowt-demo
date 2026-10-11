import { useRef, useState, type KeyboardEvent } from "react";
import type { ControllerBandwidthEstimate, SimulationUiSettings, UiWindMode } from "../sim/workerMessages";
import { SETTING_RANGES, type NumericSetting } from "../sim/settingRanges";
import type { BrowserStrategy } from "../sim/generatingEnvelope";
import { DEFAULT_TUNABLE_PARAMETERS as parameters } from "../sim/defaults";
import { createBelowRatedControllerConfig } from "../sim/belowRated";
import { SUGGESTED_REFERENCE_GAINS } from "../sim/suggestedGains";
import { InfoDisclosure } from "./InfoDisclosure";
import { DEMO_GAIN_SCHEDULE, suggestedGainsAtWind } from "../sim/gainSchedule";
import type { SimulationScenarioSample } from "../sim/simulation";
import { SliderRow } from "./SliderRow";

interface ControlsPanelProps {
  settings: SimulationUiSettings;
  latestSample?: SimulationScenarioSample;
  controllerBandwidthEstimate: ControllerBandwidthEstimate | undefined;
  onSettingsChange: (settings: Partial<SimulationUiSettings>) => void;
}

const tabs = [
  ["environment", "Environment"], ["strategy", "Control strategy"],
  ["gains", "Gains"], ["floating", "Floating feedback"],
  ["limits", "Limits and initialization"],
] as const;
type ControlTab = typeof tabs[number][0];
// Read-only model values come from the same configuration used by the controller.
const fixedTorque = createBelowRatedControllerConfig(parameters).torque;

export function ControlsPanel({ settings, latestSample, controllerBandwidthEstimate, onSettingsChange }: ControlsPanelProps) {
  // Presentation state only: selecting a tab never posts to the worker.
  const [activeTab, setActiveTab] = useState<ControlTab>("environment");
  const [suggestionId, setSuggestionId] = useState("reference");
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const coordinated = settings.strategy === "coordinated-tsr-pi";
  const scheduled = coordinated && settings.gainSchedulingEnabled;
  const sampled = latestSample?.controllerDiagnostics;
  const currentWind = sampled?.strategy === "coordinated-tsr-pi" ? sampled.torque.filteredWindMps : settings.meanWindSpeedMps;
  const currentSuggestion = suggestedGainsAtWind(currentWind);
  const selectedSuggestion = suggestionId === "reference" ? SUGGESTED_REFERENCE_GAINS : currentSuggestion;
  const activeGains = sampled?.strategy === "coordinated-tsr-pi" && sampled.gains.scheduled ? sampled.gains : undefined;
  const display = scheduled ? { ...settings,
    pitchKp: activeGains?.pitchKpS ?? currentSuggestion.pitchKpS, pitchKi: activeGains?.pitchKi ?? currentSuggestion.pitchKi,
    torqueKpNmsPerRad: activeGains?.torqueKpNmsPerRad ?? currentSuggestion.torqueKpNmsPerRad,
    torqueKiNmPerRad: activeGains?.torqueKiNmPerRad ?? currentSuggestion.torqueKiNmPerRad,
    platformPitchRateGainS: activeGains?.floatingGainS ?? currentSuggestion.platformPitchRateGainS } : settings;

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length :
      event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length :
      event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActiveTab(tabs[next][0]);
    tabButtons.current[next]?.focus();
  }

  function applySuggestion() {
    const gains = selectedSuggestion;
    onSettingsChange({ pitchKp: gains.pitchKpS, pitchKi: gains.pitchKi,
      torqueKpNmsPerRad: gains.torqueKpNmsPerRad, torqueKiNmPerRad: gains.torqueKiNmPerRad,
      floatingFeedbackEnabled: gains.floatingFeedbackEnabled, platformPitchRateGainS: gains.platformPitchRateGainS,
      torqueReferenceShiftGain: gains.torqueReferenceShiftGain, pitchReferenceShiftGain: gains.pitchReferenceShiftGain });
  }

  function slider(key: NumericSetting, label: string, unit?: string, disabled = false, scale = 1) {
    const range = SETTING_RANGES[key];
    // Torque is stored in N m, displayed in MN m. Initial pitch follows the
    // selected actuator bounds, exactly as in worker validation.
    const min = key === "initialCollectivePitchDeg" ? settings.minPitchDeg :
      key === "maxPitchDeg" ? Math.max(range.min, settings.minPitchDeg) : range.min;
    const max = key === "initialCollectivePitchDeg" ? settings.maxPitchDeg : range.max;
    return <SliderRow label={label} value={display[key] / scale} min={min / scale} max={max / scale}
      step={range.step / scale} unit={unit} disabled={disabled}
      onChange={value => onSettingsChange({ [key]: value * scale })} />;
  }

  return <section className="panel controls-panel" aria-labelledby="controls-heading">
    <div className="panel-header"><h2 id="controls-heading">Experiment settings</h2><span className="small-label">{scheduled ? "Scheduled gains" : "Manual gains"}</span></div>
    <div className="control-tabs" role="tablist" aria-label="Experiment settings">
      {tabs.map(([id, label], index) => <button key={id} type="button" role="tab"
        id={"tab-" + id} aria-controls={"panel-" + id} aria-selected={activeTab === id}
        tabIndex={activeTab === id ? 0 : -1} ref={node => { tabButtons.current[index] = node; }}
        onClick={() => setActiveTab(id)} onKeyDown={event => navigateTabs(event, index)}>{label}</button>)}
    </div>

    {/* Panels stay mounted so disclosure/input state survives tab changes. */}
    <div id="panel-environment" role="tabpanel" aria-labelledby="tab-environment" tabIndex={0} hidden={activeTab !== "environment"}>
      <p className="setting-timing">Wind changes apply immediately</p>
      <label className="select-row"><span>Wind mode</span><select value={settings.windMode}
        onChange={event => onSettingsChange({ windMode: event.currentTarget.value as UiWindMode })}>
        <option value="constant">Constant</option><option value="gust">Gust</option><option value="random">Random</option>
      </select></label>
      {slider("meanWindSpeedMps", "Mean wind speed", "m/s")}
      {settings.windMode === "random" && slider("turbulenceIntensity", "Turbulence intensity", "–")}
      {settings.windMode === "gust" && <fieldset><legend>Gust</legend>
        {slider("gustAmplitudeMps", "Gust amplitude", "m/s")}
        {slider("gustStartTimeS", "Gust start", "s")}
        {slider("gustDurationS", "Gust duration", "s")}
      </fieldset>}
      <InfoDisclosure label="Wind and operating boundaries">
        <p>Generating ranges: legacy 10–20 m/s; coordinated 3–25 m/s. Wind fluctuations are not clipped to these limits.</p>
        <p>Startup/shutdown on: 20 s torque averages govern low-wind starts and stops; filtered storm wind provides separate protection.
          Off: an out-of-range wind pauses the run; move at least 0.2 m/s inside the range and Reset.</p>
        <p>Wind edits restart the wind process; gains and tabs preserve it. Reset repeats the realization.
          Gust start uses simulation time; negative amplitude creates a dip.</p>
      </InfoDisclosure>
    </div>

    <div id="panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" tabIndex={0} hidden={activeTab !== "strategy"}>
      <p className="setting-timing">{coordinated ? "Coordinated TSR PI · 3–25 m/s" : "Legacy above-rated is active · 10–20 m/s"}</p>
      <InfoDisclosure label="Advanced: legacy controller">
      <p>Kept for regression comparisons. Strategy changes pause and require Reset; gains are retained.</p>
      <label className="select-row"><span>Selected strategy</span><select value={settings.strategy}
        onChange={event => onSettingsChange({ strategy: event.currentTarget.value as BrowserStrategy })}>
        <option value="legacy-above-rated">Legacy above-rated · 10–20 m/s</option>
        <option value="coordinated-tsr-pi">Coordinated TSR PI · 3–25 m/s</option>
      </select></label>
      <button type="button" onClick={() => onSettingsChange({ strategy: "legacy-above-rated", gainSchedulingEnabled: false,
        pitchKp: 1.5, pitchKi: .05, floatingFeedbackEnabled: false, platformPitchRateGainS: 0 })}>Load legacy reference</button>
      </InfoDisclosure>
      {!coordinated && <button type="button" onClick={() => onSettingsChange({ strategy: "coordinated-tsr-pi" })}>Return to coordinated control</button>}
      <label className="select-row"><span>Controller wind input</span><select value={settings.controllerWindSource} disabled={!coordinated}
        onChange={event => onSettingsChange({ controllerWindSource: event.currentTarget.value === "coflex-estimate" ? "coflex-estimate" : "simulated-free-stream" })}>
        <option value="simulated-free-stream">Simulated free-stream wind</option>
        <option value="coflex-estimate">COFLEX estimated rotor-effective wind</option>
      </select></label>
      <p className="setting-timing">{coordinated ? "Wind source applies live · existing 5 s filter retained" : "Wind selection is inactive in legacy mode"}</p>
      <InfoDisclosure label="Which wind drives control?">
        <p>The selected wind drives the torque speed reference and low-wind pitch floor during generation.
          Switching preserves wind, filter and PI states. Startup/loading and protection keep their existing simulated signals.</p>
        <p>The estimator starts from your independent guess. A held or limited estimate remains selected;
          there is no automatic fallback to simulated wind. Check diagnostics when tuning gains.</p>
      </InfoDisclosure>
      <label className="checkbox-row"><input type="checkbox" checked={settings.smoothingEnabled} disabled={!coordinated}
        onChange={event => onSettingsChange({ smoothingEnabled: event.currentTarget.checked })} /><span>Enable set-point smoothing</span></label>
      <p className="setting-timing">{coordinated ? "Smoothing changes apply live · gains are retained" : "Smoothing is inactive in legacy mode"}</p>
      <label className="checkbox-row"><input type="checkbox" checked={settings.startupShutdownEnabled} disabled={!coordinated}
        onChange={event => onSettingsChange({ startupShutdownEnabled: event.currentTarget.checked })} />
        <span>Simple startup / shutdown · Reset to parked</span></label>
      <p className="setting-timing">Startup/shutdown selection requires Reset</p>
      <InfoDisclosure label="Startup and shutdown assumptions">
        <p>Start turbine waits for sufficient torque, free-wheels unloaded, then ramps load before handing over to your PI gains.
          Shut down turbine cancels waiting or feathers to 90°; the parking brake engages only below 0.2 rpm.</p>
        <p>20 s means: start at available torque ≥0.080 MN m; stop below actual aerodynamic torque 0.040 MN m.
          Available torque is a model prediction at generating pitch, since parked torque is zero. Restart is manual.</p>
        <p>Storm protection: 100 s filtered wind above 25 m/s; clears at 23 m/s. Overspeed stop: 120% rated.
          Startup and feather loads are approximations; wind above 30 m/s stops the model.</p>
      </InfoDisclosure>
      <InfoDisclosure label="How the strategies work">
        <p>Legacy: pitch PI with constant torque. Coordinated: TSR torque PI, pitch PI and an IEA low-wind pitch floor.
          Smoothing coordinates the speed references near rated operation.</p>
        <p>Manual gains stay fixed. Optional gain scheduling follows the filtered selected wind; choose it in Gains.</p>
      </InfoDisclosure>
    </div>

    <div id="panel-gains" role="tabpanel" aria-labelledby="tab-gains" tabIndex={0} hidden={activeTab !== "gains"}>
      <label className="select-row"><span>Gain mode</span><select disabled={!coordinated} value={scheduled ? "scheduled" : "manual"}
        onChange={event => onSettingsChange({ gainSchedulingEnabled: event.currentTarget.value === "scheduled" })}>
        <option value="manual">Manual · user-selected gains</option>
        <option value="scheduled">Automatic · demo wind schedule</option>
      </select></label>
      <p className="setting-timing">{scheduled ? `Schedule at ${currentWind.toFixed(2)} m/s · manual values saved` : "Gains apply live · manual values stay fixed"}</p>
      {settings.startupShutdownEnabled && <p className="setting-timing">PI gains take control after startup handover</p>}
      {coordinated && <div className="suggestion-box">
        <label className="select-row"><span>SUGGESTED gains</span><select value={suggestionId} onChange={event => setSuggestionId(event.currentTarget.value)}>
          <option value="reference">Stable demo baseline · all winds</option>
          <option value="current">For current filtered wind · {currentWind.toFixed(1)} m/s</option>
        </select></label>
        <p className="setting-timing">Preview: pitch {selectedSuggestion.pitchKpS.toFixed(2)} / {selectedSuggestion.pitchKi.toFixed(3)} ·
          floating {selectedSuggestion.platformPitchRateGainS.toFixed(1)} s</p>
        <button type="button" disabled={scheduled} onClick={applySuggestion}>Apply SUGGESTED gains</button>
        <InfoDisclosure label="What Apply changes"><p>Apply sets all gains and the floating-feedback switch. Wind, strategy and the smoothing switch stay unchanged.
          Selecting a suggestion alone does not apply it. The current-wind suggestion is a one-time copy, not automatic scheduling.</p>
          <p>Demo baseline is our tested conservative set, not the published ROSCO controller.</p></InfoDisclosure>
      </div>}
      <InfoDisclosure label="Schedule and literature basis">
        <p>Pitch PI and floating feedback interpolate on the same 5 s filtered wind used by torque control.
          With COFLEX selected this is estimated rotor-effective wind. Endpoints are held outside 3–25 m/s.
          Torque gains stay at 50.4 / 2.24; smoothing and estimator gains remain manual.</p>
        <p>Floating feedback adapts <a href="https://wes.copernicus.org/articles/8/1299/2023/" target="_blank" rel="noreferrer">Guo &amp; Schlipf (2023)</a>, Table 4 (MVFB), capped at 20 s.
          Pitch gains are demo suggestions. This is not the published ROSCO gain schedule.</p>
        <table><thead><tr><th>Wind m/s</th><th>Pitch Kp / Ki</th><th>Floating s</th></tr></thead><tbody>
          {DEMO_GAIN_SCHEDULE.map(row => <tr key={row.windMps}><td>{row.windMps}</td>
            <td>{row.pitchKpS.toFixed(2)} / {row.pitchKi.toFixed(3)}</td><td>{row.floatingGainS}</td></tr>)}
        </tbody></table>
        <p>Switching off scheduling restores your saved manual values. Displayed gains are active generating gains;
          before generating they are previews. Scheduling preserves the PI integral contribution.</p>
        <p>Tested turbulence showed less speed error and platform motion, with more blade-pitch activity.</p>
      </InfoDisclosure>
      <fieldset disabled={scheduled}><legend>Pitch PI{scheduled && " · automatic"}</legend>
        {slider("pitchKp", "Pitch Kp", "s", scheduled)}{slider("pitchKi", "Pitch Ki", "–", scheduled)}
      </fieldset>
      <fieldset disabled={!coordinated || scheduled}><legend>Torque PI{!coordinated && " · inactive"}{scheduled && " · schedule constant"}</legend>
        {slider("torqueKpNmsPerRad", "Torque Kp", "MN m s/rad", !coordinated || scheduled, 1e6)}
        {slider("torqueKiNmPerRad", "Torque Ki", "MN m/rad", !coordinated || scheduled, 1e6)}
      </fieldset>
      <fieldset disabled={!coordinated || !settings.smoothingEnabled}><legend>Smoothing{(!coordinated || !settings.smoothingEnabled) && " · inactive"}</legend>
        {slider("torqueReferenceShiftGain", "Torque-reference gain", "–", !coordinated || !settings.smoothingEnabled)}
        {slider("pitchReferenceShiftGain", "Pitch-reference gain", "–", !coordinated || !settings.smoothingEnabled)}
      </fieldset>
      <fieldset><legend>COFLEX wind estimator</legend>
        {slider("windEstimatorKp", "Estimator Kp", "m/rad")}
        {slider("windEstimatorKi", "Estimator Ki", "m/(rad s)")}
        {slider("windEstimatorInitialMps", "Initial wind estimate", "m/s")}
        <p className="setting-timing">Estimator gains apply live · initial estimate applies on Reset</p>
        <InfoDisclosure label="About the wind estimate">
          <p>Rotor speed, applied pitch and generator torque drive the COFLEX torque-balance observer.
            It estimates rotor-effective wind. Select its use for control in the Control strategy tab.</p>
          <p>The estimate is held during startup, shutdown and unsupported speed/pitch conditions.
            Initial wind is your independent guess. These fixed gains are demonstrator suggestions, not paper values.</p>
          <p>Kp must stay positive. Ki = 0 disables the integral contribution; the speed-observer state adjusts to preserve
            the current wind estimate when switching. Poor guesses or gains can prevent convergence.</p>
        </InfoDisclosure>
      </fieldset>
      {(display.pitchKp > 1.6 || display.pitchKi > .05 || (display.pitchKp > 1.5 && display.pitchKi > .03)) &&
        <p className="setting-warning">High pitch gains can cause aggressive action or oscillation.</p>}
      <InfoDisclosure label="PI tuning and crossover">
        <p>Positive speed error increases braking torque or feathering pitch. With Ki &gt; 0, gain edits adjust integral state
          to preserve output where possible. Ki = 0 clears the integral; rate limits still apply.</p>
        <p>{coordinated ? "The scheduled pitch floor supports low-wind operation; the integral supplies above-rated trim." :
          "Legacy uses a fixed 4.10° pitch bias within the pitch limits."}</p>
        <p>{controllerBandwidthEstimate?.message ?? "Waiting for a crossover estimate."}</p>
        {controllerBandwidthEstimate?.valid && <p>Estimated crossover: {controllerBandwidthEstimate.crossoverHz?.toPrecision(3)} Hz.
          Rotor-only estimate; platform coupling is excluded.</p>}
      </InfoDisclosure>
    </div>

    <div id="panel-floating" role="tabpanel" aria-labelledby="tab-floating" tabIndex={0} hidden={activeTab !== "floating"}>
      <p className="setting-timing">{scheduled ? "Floating gain follows the wind schedule · change Gain mode to edit manually" : "Feedback changes apply live"}</p>
      <label className="checkbox-row"><input type="checkbox" disabled={scheduled} checked={scheduled ? display.platformPitchRateGainS > 0 : settings.floatingFeedbackEnabled}
        onChange={event => onSettingsChange({ floatingFeedbackEnabled: event.currentTarget.checked })} /><span>Enable platform-pitch-rate feedback</span></label>
      {slider("platformPitchRateGainS", "Pitch-rate gain", "s", scheduled || !settings.floatingFeedbackEnabled)}
      <dl className="model-values"><div><dt>Low-pass cutoff · fixed</dt><dd>{parameters.floatingFeedbackPitchRateLowPassCutoffHz} Hz</dd></div></dl>
      {!scheduled && settings.floatingFeedbackEnabled && settings.platformPitchRateGainS > 10 &&
        <p className="setting-warning">Large feedback gain can destabilize platform motion.</p>}
      <InfoDisclosure label="Feedback sign and filtering">
        <p>Filtered platform pitch rate adds to collective pitch. Gain units: seconds. Reduce the gain if platform motion grows.
          Live edits preserve filter state.</p>
      </InfoDisclosure>
    </div>

    <div id="panel-limits" role="tabpanel" aria-labelledby="tab-limits" tabIndex={0} hidden={activeTab !== "limits"}>
      <p className="setting-timing">{coordinated ? "Pitch limit changes pause and require Reset" : "Pitch limits apply live · initial pitch requires Reset"}</p>
      <fieldset><legend>Pitch actuator</legend>
        {slider("minPitchDeg", "Minimum pitch", "deg")}{slider("maxPitchDeg", "Maximum pitch", "deg")}
        {slider("maxPitchRateDegPerSec", "Pitch rate limit", "deg/s")}
      </fieldset>
      <fieldset><legend>Initialization</legend>
        {coordinated ? <p className="setting-timing">{settings.startupShutdownEnabled ? "Reset parks the rotor at rest with 90° feather; use Start turbine." :
          "Speed, pitch and torque are solved at the selected wind on Reset."}</p> :
          slider("initialCollectivePitchDeg", "Initial collective pitch", "deg")}
      </fieldset>
      <InfoDisclosure label="Speed and torque limits · fixed">
        <dl className="model-values">
          <div><dt>{coordinated ? "Speed reference range" : "Speed reference"}</dt><dd>{coordinated && <>{(fixedTorque.minimumRotorSpeedRadPerSec * 30 / Math.PI).toFixed(0)}–</>}{(parameters.ratedRotorSpeedRadPerSec * 30 / Math.PI).toFixed(2)} rpm</dd></div>
          <div><dt>{coordinated ? "Normal torque cap" : "Constant torque"}</dt><dd>{(fixedTorque.maxTorqueNm / 1e6).toFixed(3)} MN m</dd></div>
          <div><dt>Absolute torque ceiling</dt><dd>{parameters.maxGeneratorTorqueNm / 1e6} MN m</dd></div>
          {coordinated && <div><dt>Torque rate limit</dt><dd>{fixedTorque.maxTorqueRateNmPerSec / 1e6} MN m/s</dd></div>}
        </dl>
        <p>These limits are fixed. Actual speed can temporarily fall below the minimum reference.</p>
      </InfoDisclosure>
      <InfoDisclosure label="Initialization and model limits">
        <p>Startup/shutdown on: Reset parks at 90°; use Start turbine. Generating pitch limits apply after handover.
          Shutdown pitch rate is at most 2°/s or your lower limit.</p>
        <p>Off: coordinated Reset solves a generating equilibrium; infeasible limits block Start.
          Legacy initial pitch applies only on Reset.</p>
        <p>Torque control uses the selected wind signal filtered over {fixedTorque.windFilterTimeConstantS} s; target TSR is {fixedTorque.targetTsr}.
          Aerodynamics use rotor-effective wind including platform motion.</p>
        <p>With startup/shutdown on, short excursions outside the aero table use a flagged approximation, limited to 30 m/s
          free-stream and rotor-effective wind and the table maximum speed. Off, leaving the table pauses the model.</p>
      </InfoDisclosure>
    </div>
  </section>;
}
