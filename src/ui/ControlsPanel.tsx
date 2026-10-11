import { useRef, useState, type KeyboardEvent } from "react";
import type { ControllerBandwidthEstimate, SimulationUiSettings, UiWindMode } from "../sim/workerMessages";
import { SETTING_RANGES, type NumericSetting } from "../sim/settingRanges";
import type { BrowserStrategy } from "../sim/generatingEnvelope";
import { DEFAULT_TUNABLE_PARAMETERS as parameters } from "../sim/defaults";
import { createBelowRatedControllerConfig } from "../sim/belowRated";
import { SUGGESTED_REFERENCE_GAINS, SUGGESTED_OPERATING_POINT_GAINS } from "../sim/suggestedGains";
import { InfoDisclosure } from "./InfoDisclosure";
import { SliderRow } from "./SliderRow";

interface ControlsPanelProps {
  settings: SimulationUiSettings;
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

export function ControlsPanel({ settings, controllerBandwidthEstimate, onSettingsChange }: ControlsPanelProps) {
  // Presentation state only: selecting a tab never posts to the worker.
  const [activeTab, setActiveTab] = useState<ControlTab>("environment");
  const [suggestionId, setSuggestionId] = useState("reference");
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const coordinated = settings.strategy === "coordinated-tsr-pi";

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
    const gains = suggestionId === "reference" ? SUGGESTED_REFERENCE_GAINS :
      SUGGESTED_OPERATING_POINT_GAINS.find(row => row.id === suggestionId)!.gains;
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
    return <SliderRow label={label} value={settings[key] / scale} min={min / scale} max={max / scale}
      step={range.step / scale} unit={unit} disabled={disabled}
      onChange={value => onSettingsChange({ [key]: value * scale })} />;
  }

  return <section className="panel controls-panel" aria-labelledby="controls-heading">
    <div className="panel-header"><h2 id="controls-heading">Experiment settings</h2><span className="small-label">Manual gains</span></div>
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
      <p className="setting-timing">Strategy changes pause and require Reset</p>
      <label className="select-row"><span>Selected strategy</span><select value={settings.strategy}
        onChange={event => onSettingsChange({ strategy: event.currentTarget.value as BrowserStrategy })}>
        <option value="legacy-above-rated">Legacy above-rated · 10–20 m/s</option>
        <option value="coordinated-tsr-pi">Coordinated TSR PI · 3–25 m/s</option>
      </select></label>
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
        <p>Gains change only when you edit them or apply a SUGGESTED set. There is no automatic gain scheduling.</p>
      </InfoDisclosure>
    </div>

    <div id="panel-gains" role="tabpanel" aria-labelledby="tab-gains" tabIndex={0} hidden={activeTab !== "gains"}>
      <p className="setting-timing">Gains apply live · no automatic scheduling</p>
      {settings.startupShutdownEnabled && <p className="setting-timing">PI gains take control after startup handover</p>}
      {coordinated && <div className="suggestion-box">
        <label className="select-row"><span>SUGGESTED gains</span><select value={suggestionId} onChange={event => setSuggestionId(event.currentTarget.value)}>
          <option value="reference">Fixed reference · pitch 0.60 / 0.015</option>
          {SUGGESTED_OPERATING_POINT_GAINS.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
        </select></label>
        <button type="button" onClick={applySuggestion}>Apply SUGGESTED gains</button>
        <InfoDisclosure label="What Apply changes"><p>Apply sets all gains and the floating-feedback switch. Wind, strategy and the smoothing switch stay unchanged.
          Selecting a suggestion alone does not apply it.</p></InfoDisclosure>
      </div>}
      <fieldset><legend>Pitch PI</legend>
        {slider("pitchKp", "Pitch Kp", "s")}{slider("pitchKi", "Pitch Ki", "–")}
      </fieldset>
      <fieldset disabled={!coordinated}><legend>Torque PI{!coordinated && " · inactive"}</legend>
        {slider("torqueKpNmsPerRad", "Torque Kp", "MN m s/rad", !coordinated, 1e6)}
        {slider("torqueKiNmPerRad", "Torque Ki", "MN m/rad", !coordinated, 1e6)}
      </fieldset>
      <fieldset disabled={!coordinated || !settings.smoothingEnabled}><legend>Smoothing{(!coordinated || !settings.smoothingEnabled) && " · inactive"}</legend>
        {slider("torqueReferenceShiftGain", "Torque-reference gain", "–", !coordinated || !settings.smoothingEnabled)}
        {slider("pitchReferenceShiftGain", "Pitch-reference gain", "–", !coordinated || !settings.smoothingEnabled)}
      </fieldset>
      {(settings.pitchKp > 1.6 || settings.pitchKi > .05 || (settings.pitchKp > 1.5 && settings.pitchKi > .03)) &&
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
      <p className="setting-timing">Feedback changes apply live</p>
      <label className="checkbox-row"><input type="checkbox" checked={settings.floatingFeedbackEnabled}
        onChange={event => onSettingsChange({ floatingFeedbackEnabled: event.currentTarget.checked })} /><span>Enable platform-pitch-rate feedback</span></label>
      {slider("platformPitchRateGainS", "Pitch-rate gain", "s", !settings.floatingFeedbackEnabled)}
      <dl className="model-values"><div><dt>Low-pass cutoff · fixed</dt><dd>{parameters.floatingFeedbackPitchRateLowPassCutoffHz} Hz</dd></div></dl>
      {settings.floatingFeedbackEnabled && settings.platformPitchRateGainS > 10 &&
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
        <p>Torque control uses simulated free-stream wind filtered over {fixedTorque.windFilterTimeConstantS} s; target TSR is {fixedTorque.targetTsr}.
          Aerodynamics use rotor-effective wind including platform motion.</p>
        <p>With startup/shutdown on, short excursions outside the aero table use a flagged approximation, limited to 30 m/s
          free-stream and rotor-effective wind and the table maximum speed. Off, leaving the table pauses the model.</p>
      </InfoDisclosure>
    </div>
  </section>;
}
