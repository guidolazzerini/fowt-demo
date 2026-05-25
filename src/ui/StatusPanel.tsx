import type { SimulationRunState } from "../app/useSimulation";
import type { SimulationScenarioSample } from "../sim/simulation";
import type { SimulationWorkerStatus } from "../sim/workerMessages";

interface StatusPanelProps {
  sample: SimulationScenarioSample | undefined;
  history: SimulationScenarioSample[];
  status: SimulationWorkerStatus;
  statusMessage: string | undefined;
  runState: SimulationRunState;
  isRunning: boolean;
}

interface StatusItem {
  label: string;
  value: string;
  averageValue: string | undefined;
  standardDeviationValue: string | undefined;
}

interface MovingStats {
  average: number;
  standardDeviation: number;
}

const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);
const RAD_TO_DEG = 180 / Math.PI;
const STATUS_MOVING_WINDOW_S = 10;

export function StatusPanel(props: StatusPanelProps) {
  const { sample, history, status, statusMessage, runState, isRunning } = props;
  const items = sample === undefined ? [] : createStatusItems(sample, history);

  return (
    <section className="panel status-panel" aria-labelledby="status-heading">
      <div className="panel-header">
        <div>
          <h2 id="status-heading">Live status</h2>
          <p>{statusMessage ?? getStatusLabel(status, runState, isRunning)}</p>
        </div>
        <div className="status-badges" aria-label="Simulation state">
          <span className={`run-state-pill run-state-${runState}`}>{formatRunState(runState)}</span>
          <span className={`status-pill status-${status}`}>{status}</span>
        </div>
      </div>

      {sample === undefined ? (
        <p className="empty-state">Waiting for the simulation worker.</p>
      ) : (
        <dl className="status-grid">
          {items.map((item) => (
            <div className="status-card" key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                <strong>{item.value}</strong>
                {item.averageValue === undefined ? null : (
                  <small className="moving-average-value">10 s avg {item.averageValue}</small>
                )}
                {item.standardDeviationValue === undefined ? null : (
                  <small className="moving-std-value">10 s std {item.standardDeviationValue}</small>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function createStatusItems(
  sample: SimulationScenarioSample,
  history: SimulationScenarioSample[],
): StatusItem[] {
  return [
    {
      label: "Time",
      value: `${formatNumber(sample.timeS, 1)} s`,
      averageValue: undefined,
      standardDeviationValue: undefined,
    },
    createStatusItem(
      "Rotor speed",
      sample.rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM,
      history,
      (entry) => entry.rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM,
      "rpm",
      2,
    ),
    createStatusItem(
      "Power",
      sample.aerodynamicPowerW / 1e6,
      history,
      (entry) => entry.aerodynamicPowerW / 1e6,
      "MW",
      2,
    ),
    createStatusItem(
      "Collective pitch",
      sample.collectivePitchRad * RAD_TO_DEG,
      history,
      (entry) => entry.collectivePitchRad * RAD_TO_DEG,
      "deg",
      2,
    ),
    createStatusItem(
      "Platform pitch",
      sample.platformPitchRad * RAD_TO_DEG,
      history,
      (entry) => entry.platformPitchRad * RAD_TO_DEG,
      "deg",
      2,
    ),
    createStatusItem(
      "Platform pitch rate",
      sample.platformPitchRateRadPerSec * RAD_TO_DEG,
      history,
      (entry) => entry.platformPitchRateRadPerSec * RAD_TO_DEG,
      "deg/s",
      3,
    ),
    createStatusItem(
      "Wind speed",
      sample.windSpeedMps,
      history,
      (entry) => entry.windSpeedMps,
      "m/s",
      2,
    ),
    createStatusItem(
      "Effective wind",
      sample.effectiveWindSpeedMps,
      history,
      (entry) => entry.effectiveWindSpeedMps,
      "m/s",
      2,
    ),
    createStatusItem(
      "Thrust",
      sample.thrustN / 1e6,
      history,
      (entry) => entry.thrustN / 1e6,
      "MN",
      3,
    ),
    createCoefficientStatusItem(sample, history),
  ];
}

function createStatusItem(
  label: string,
  instantaneousValue: number,
  history: SimulationScenarioSample[],
  pickValue: (sample: SimulationScenarioSample) => number,
  unit: string,
  digits: number,
): StatusItem {
  const stats = getMovingStats(history, pickValue);

  return {
    label,
    value: `${formatNumber(instantaneousValue, digits)} ${unit}`,
    averageValue: `${formatNumber(stats.average, digits)} ${unit}`,
    standardDeviationValue: `${formatNumber(stats.standardDeviation, digits)} ${unit}`,
  };
}

function createCoefficientStatusItem(
  sample: SimulationScenarioSample,
  history: SimulationScenarioSample[],
): StatusItem {
  const cpStats = getMovingStats(history, (entry) => entry.cp);
  const ctStats = getMovingStats(history, (entry) => entry.ct);

  return {
    label: "Cp / Ct",
    value: `${formatNumber(sample.cp, 3)} / ${formatNumber(sample.ct, 3)}`,
    averageValue: `${formatNumber(cpStats.average, 3)} / ${formatNumber(ctStats.average, 3)}`,
    standardDeviationValue: `${formatNumber(cpStats.standardDeviation, 3)} / ${formatNumber(
      ctStats.standardDeviation,
      3,
    )}`,
  };
}

function getMovingStats(
  history: SimulationScenarioSample[],
  pickValue: (sample: SimulationScenarioSample) => number,
): MovingStats {
  const latestSample = history.length === 0 ? undefined : history[history.length - 1];

  if (latestSample === undefined) {
    return { average: Number.NaN, standardDeviation: Number.NaN };
  }

  const minTimeS = latestSample.timeS - STATUS_MOVING_WINDOW_S;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const candidate = history[i];

    if (candidate.timeS < minTimeS) {
      break;
    }

    const value = pickValue(candidate);

    if (Number.isFinite(value)) {
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }

  if (count === 0) {
    return { average: Number.NaN, standardDeviation: Number.NaN };
  }

  const average = sum / count;
  const variance = Math.max(0, sumSquares / count - average * average);

  return {
    average,
    standardDeviation: Math.sqrt(variance),
  };
}

function getStatusLabel(
  status: SimulationWorkerStatus,
  runState: SimulationRunState,
  isRunning: boolean,
): string {
  if (isRunning || runState === "running") {
    return "Simulation running";
  }

  if (runState === "reset") {
    return "Simulation reset to the initial condition";
  }

  if (runState === "stopped") {
    return "Simulation stopped";
  }

  switch (status) {
    case "idle":
      return "Worker idle";
    case "loading":
      return "Loading aerodynamic data";
    case "ready":
      return "Simulation ready";
    case "running":
      return "Simulation running";
    case "error":
      return "Simulation error";
  }
}

function formatRunState(runState: SimulationRunState): string {
  switch (runState) {
    case "loading":
      return "loading";
    case "stopped":
      return "stopped";
    case "running":
      return "running";
    case "reset":
      return "reset";
    case "error":
      return "error";
  }
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }

  return value.toFixed(digits);
}
