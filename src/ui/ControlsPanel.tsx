import {
  DEMO_WIND_SPEED_MAX_MPS,
  DEMO_WIND_SPEED_MIN_MPS,
  type ControllerBandwidthEstimate,
  type SimulationUiSettings,
  type UiWindMode,
} from "../sim/workerMessages";
import { SliderRow } from "./SliderRow";

interface ControlsPanelProps {
  settings: SimulationUiSettings;
  controllerBandwidthEstimate: ControllerBandwidthEstimate | undefined;
  isRunning: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onSettingsChange: (settings: Partial<SimulationUiSettings>) => void;
}

interface ControlWarning {
  id: string;
  text: string;
}

export function ControlsPanel(props: ControlsPanelProps) {
  const {
    settings,
    controllerBandwidthEstimate,
    isRunning,
    onStart,
    onStop,
    onReset,
    onSettingsChange,
  } = props;
  const isRandomWind = settings.windMode === "random";
  const isGustWind = settings.windMode === "gust";
  const controllerWarnings = getControllerWarnings(settings);
  const floatingWarnings = getFloatingFeedbackWarnings(settings);

  return (
    <section className="panel controls-panel" aria-labelledby="controls-heading">
      <div className="panel-header">
        <div>
          <h2 id="controls-heading">Controls</h2>
          <p>Region-3 FOWT demo inputs</p>
        </div>
        <div className="button-row">
          <button type="button" onClick={onStart} disabled={isRunning}>
            Start
          </button>
          <button type="button" onClick={onStop} disabled={!isRunning}>
            Stop
          </button>
          <button type="button" onClick={onReset}>
            Reset
          </button>
        </div>
      </div>

      <fieldset>
        <legend>Wind disturbance</legend>
        <label className="select-row">
          <span>Mode</span>
          <select
            value={settings.windMode}
            onChange={(event) =>
              onSettingsChange({ windMode: event.currentTarget.value as UiWindMode })
            }
          >
            <option value="constant">Constant</option>
            <option value="gust">Gust</option>
            <option value="random">Random</option>
          </select>
        </label>
        <SliderRow
          label="Mean wind speed"
          value={settings.meanWindSpeedMps}
          min={DEMO_WIND_SPEED_MIN_MPS}
          max={DEMO_WIND_SPEED_MAX_MPS}
          step={0.1}
          unit="m/s"
          onChange={(meanWindSpeedMps) => onSettingsChange({ meanWindSpeedMps })}
        />
        <p className="control-hint">
          Wind speed is limited to 11–20 m/s for the above-rated demo.
        </p>
        <SliderRow
          label="Turbulence intensity"
          value={settings.turbulenceIntensity}
          min={0}
          max={0.25}
          step={0.005}
          unit="-"
          disabled={!isRandomWind}
          onChange={(turbulenceIntensity) => onSettingsChange({ turbulenceIntensity })}
        />
        {!isRandomWind ? (
          <p className="control-hint">Turbulence intensity is active only in Random mode.</p>
        ) : null}
        <div className={`nested-controls${isGustWind ? "" : " is-disabled"}`}>
          <SliderRow
            label="Gust amplitude"
            value={settings.gustAmplitudeMps}
            min={0}
            max={10}
            step={0.1}
            unit="m/s"
            disabled={!isGustWind}
            onChange={(gustAmplitudeMps) => onSettingsChange({ gustAmplitudeMps })}
          />
          <SliderRow
            label="Gust start"
            value={settings.gustStartTimeS}
            min={0}
            max={120}
            step={0.5}
            unit="s"
            disabled={!isGustWind}
            onChange={(gustStartTimeS) => onSettingsChange({ gustStartTimeS })}
          />
          <SliderRow
            label="Gust duration"
            value={settings.gustDurationS}
            min={0.5}
            max={120}
            step={0.5}
            unit="s"
            disabled={!isGustWind}
            onChange={(gustDurationS) => onSettingsChange({ gustDurationS })}
          />
          {!isGustWind ? <p className="control-hint">Gust controls are active only in Gust mode.</p> : null}
        </div>
      </fieldset>

      <fieldset>
        <legend>Pitch controller</legend>
        <SliderRow
          label="Kp"
          value={settings.pitchKp}
          min={0.1}
          max={2}
          step={0.05}
          onChange={(pitchKp) => onSettingsChange({ pitchKp })}
        />
        <SliderRow
          label="Ki"
          value={settings.pitchKi}
          min={0}
          max={0.1}
          step={0.001}
          onChange={(pitchKi) => onSettingsChange({ pitchKi })}
        />
        <ControllerBandwidthCard estimate={controllerBandwidthEstimate} />
        <WarningList warnings={controllerWarnings} />
      </fieldset>

      <fieldset>
        <legend>Pitch limits</legend>
        <SliderRow
          label="Initial collective pitch"
          value={settings.initialCollectivePitchDeg}
          min={settings.minPitchDeg}
          max={settings.maxPitchDeg}
          step={0.1}
          unit="deg"
          onChange={(initialCollectivePitchDeg) =>
            onSettingsChange({ initialCollectivePitchDeg })
          }
        />
        <p className="control-hint control-hint-inline">Applied when the simulation is reset.</p>
        <SliderRow
          label="Minimum pitch"
          value={settings.minPitchDeg}
          min={0}
          max={20}
          step={0.1}
          unit="deg"
          onChange={(minPitchDeg) => onSettingsChange({ minPitchDeg })}
        />
        <SliderRow
          label="Maximum pitch"
          value={settings.maxPitchDeg}
          min={5}
          max={35}
          step={0.1}
          unit="deg"
          onChange={(maxPitchDeg) => onSettingsChange({ maxPitchDeg })}
        />
        <SliderRow
          label="Pitch rate limit"
          value={settings.maxPitchRateDegPerSec}
          min={0.2}
          max={15}
          step={0.1}
          unit="deg/s"
          onChange={(maxPitchRateDegPerSec) => onSettingsChange({ maxPitchRateDegPerSec })}
        />
      </fieldset>

      <fieldset>
        <legend>Floating feedback</legend>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.floatingFeedbackEnabled}
            onChange={(event) =>
              onSettingsChange({ floatingFeedbackEnabled: event.currentTarget.checked })
            }
          />
          <span>Enable platform-pitch-rate feedback</span>
        </label>
        <SliderRow
          label="Pitch-rate gain"
          value={settings.platformPitchRateGainS}
          min={0}
          max={20}
          step={0.5}
          unit="s"
          disabled={!settings.floatingFeedbackEnabled}
          onChange={(platformPitchRateGainS) => onSettingsChange({ platformPitchRateGainS })}
        />
        {!settings.floatingFeedbackEnabled ? (
          <p className="control-hint">Pitch-rate feedback gain is active only when enabled.</p>
        ) : null}
        <WarningList warnings={floatingWarnings} />
      </fieldset>
    </section>
  );
}


function ControllerBandwidthCard(props: {
  estimate: ControllerBandwidthEstimate | undefined;
}) {
  const { estimate } = props;

  if (estimate === undefined) {
    return (
      <div className="bandwidth-card">
        <span>Estimated crossover</span>
        <strong>--</strong>
        <p>Waiting for the worker linearisation.</p>
      </div>
    );
  }

  const crossoverLabel =
    estimate.crossoverRadPerSec === undefined || estimate.crossoverHz === undefined
      ? "not found"
      : `${formatFrequency(estimate.crossoverRadPerSec)} rad/s · ${formatFrequency(
          estimate.crossoverHz,
        )} Hz`;

  return (
    <div className={`bandwidth-card${estimate.valid ? "" : " is-warning"}`}>
      <span>Estimated PI crossover</span>
      <strong>{crossoverLabel}</strong>
      <p>{estimate.message}</p>
      <small>
        Low-order estimate from |(Kp + Ki/s) GβΩ(s)| = 1; platform coupling is
        not included.
      </small>
    </div>
  );
}

function WarningList(props: { warnings: ControlWarning[] }) {
  const { warnings } = props;

  if (warnings.length === 0) {
    return null;
  }

  return (
    <ul className="control-warning-list" aria-label="Control warnings">
      {warnings.map((warning) => (
        <li key={warning.id}>{warning.text}</li>
      ))}
    </ul>
  );
}

function getControllerWarnings(settings: SimulationUiSettings): ControlWarning[] {
  const warnings: ControlWarning[] = [];

  if (settings.pitchKp > 1.6) {
    warnings.push({
      id: "high-kp",
      text: "Kp is near the upper demo range; expect aggressive pitch action.",
    });
  }

  if (settings.pitchKi > 0.05) {
    warnings.push({
      id: "high-ki",
      text: "Ki is high; integral action may drive pitch saturation or oscillatory response.",
    });
  }

  if (settings.pitchKp > 1.5 && settings.pitchKi > 0.03) {
    warnings.push({
      id: "high-pi-combination",
      text: "The Kp/Ki combination is aggressive for this low-order floating demo.",
    });
  }

  return warnings;
}

function getFloatingFeedbackWarnings(settings: SimulationUiSettings): ControlWarning[] {
  if (!settings.floatingFeedbackEnabled) {
    return [];
  }

  const warnings: ControlWarning[] = [];
  if (settings.platformPitchRateGainS > 10) {
    warnings.push({
      id: "large-floating-gain",
      text: "Large floating-feedback gain can destabilise the platform-pitch mode.",
    });
  }

  if (settings.platformPitchRateGainS > 0) {
    warnings.push({
      id: "floating-gain-magnitude",
      text: "Reduce the floating-feedback gain if platform motion grows.",
    });
  }

  return warnings;
}

function formatFrequency(value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }

  if (Math.abs(value) >= 1) {
    return value.toFixed(2);
  }

  if (Math.abs(value) >= 0.01) {
    return value.toFixed(3);
  }

  return value.toExponential(2);
}
