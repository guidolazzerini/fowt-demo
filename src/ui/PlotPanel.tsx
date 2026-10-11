import type { SimulationRunState } from "../app/useSimulation";
import type { SimulationScenarioSample } from "../sim/simulation";
import { useState } from "react";
import { InfoDisclosure } from "./InfoDisclosure";
import { finitePlotSegments, generatorMechanicalPowerW, type PlotPoint } from "./diagnosticSignals";

interface PlotPanelProps {
  history: SimulationScenarioSample[];
  runState: SimulationRunState;
}

export interface PlotSeries {
  title: string;
  unit: string;
  values: PlotPoint[];
  label?: string;
  overlays?: { label: string; values: PlotPoint[] }[];
}

interface PlotBounds {
  minTimeS: number;
  maxTimeS: number;
  minValue: number;
  maxValue: number;
}

interface MovingStats {
  average: number;
  standardDeviation: number;
}

const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);
const RAD_TO_DEG = 180 / Math.PI;
const WIDTH = 520;
const HEIGHT = 180;
const PADDING_LEFT = 58;
const PADDING_RIGHT = 18;
const PADDING_TOP = 18;
const PADDING_BOTTOM = 34;
const PLOT_MOVING_WINDOW_S = 30;

export function PlotPanel(props: PlotPanelProps) {
  const { history, runState } = props;
  const series = createPlotSeries(history);
  const [showStatistics, setShowStatistics] = useState(false);

  return (
    <section className="panel plot-panel" aria-labelledby="plots-heading">
      <div className="panel-header">
        <div>
          <h2 id="plots-heading">Time histories</h2>
        </div>
        <span className={`plot-meta-pill run-state-${runState}`}>{formatRunState(runState)}</span>
      </div>
      <InfoDisclosure label="Plot options">
        <label className="checkbox-row"><input type="checkbox" checked={showStatistics}
          onChange={event => setShowStatistics(event.currentTarget.checked)} /><span>Show 30 s average and standard deviation</span></label>
        <p>Traces show instantaneous values. Axes scale to the displayed history. Statistics use available samples in the last 30 s.</p>
        <p>Aerodynamic power comes from the table, or torque × speed during approximate transients.
          Negative aerodynamic power indicates braking. Generator mechanical power is generator torque × rotor speed, before electrical losses.
          The traces can differ during acceleration and through table interpolation.</p>
      </InfoDisclosure>

      {history.length === 0 ? (
        <p className="empty-state">Waiting for the first simulation sample.</p>
      ) : (
        <div className="plot-grid">
          {series.map((plotSeries) => (
            <MiniPlot key={plotSeries.title} series={plotSeries} showStatistics={showStatistics} />
          ))}
        </div>
      )}
    </section>
  );
}

function createPlotSeries(history: SimulationScenarioSample[]): PlotSeries[] {
  return [
    {
      title: "Rotor speed",
      unit: "rpm",
      values: history.map((sample) => ({
        timeS: sample.timeS,
        value: sample.rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM,
      })),
    },
    {
      title: "Collective pitch",
      unit: "deg",
      values: history.map((sample) => ({
        timeS: sample.timeS,
        value: sample.collectivePitchRad * RAD_TO_DEG,
      })),
    },
    {
      title: "Platform pitch",
      unit: "deg",
      values: history.map((sample) => ({
        timeS: sample.timeS,
        value: sample.platformPitchRad * RAD_TO_DEG,
      })),
    },
    {
      title: "Wind speed",
      unit: "m/s",
      values: history.map((sample) => ({
        timeS: sample.timeS,
        value: sample.windSpeedMps,
      })),
    },
    {
      title: "Power comparison",
      unit: "MW",
      label: "Aerodynamic",
      values: history.map((sample) => ({
        timeS: sample.timeS,
        value: sample.aerodynamicPowerW / 1e6,
      })),
      overlays: [{ label: "Generator mechanical", values: history.map(sample => ({
        timeS: sample.timeS, value: generatorMechanicalPowerW(sample) / 1e6,
      })) }],
    },
  ];
}

export function MiniPlot(props: { series: PlotSeries; showStatistics?: boolean }) {
  const { series, showStatistics } = props;
  const lines = [{ label: series.label ?? series.title, values: series.values }, ...(series.overlays ?? [])];
  const finiteValues = getFiniteValues(lines.flatMap(line => line.values));
  const bounds = getBounds(finiteValues);
  const colors = ["#0076c2", "#b54708", "#6941c6", "#067647", "#475467"];
  const dashes = ["", "8 4", "2 4", "10 3 2 3", "4 3"];
  const yTicks = [bounds.maxValue, 0.5 * (bounds.maxValue + bounds.minValue), bounds.minValue];

  return (
    <article className="mini-plot">
      <div className="mini-plot-header">
        <div>
          <h3>{series.title}</h3>
          <span>{series.unit}</span>
        </div>
        {lines.length === 1 && <strong>{formatValue(series.values.at(-1)?.value)}</strong>}
      </div>
      {finiteValues.length === 0 && <p className="setting-timing">No active signal in this history</p>}
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={series.title}>
        <rect
          className="plot-area"
          x={PADDING_LEFT}
          y={PADDING_TOP}
          width={WIDTH - PADDING_LEFT - PADDING_RIGHT}
          height={HEIGHT - PADDING_TOP - PADDING_BOTTOM}
        />
        {/* Stable axis positions reuse nodes even when the scale changes. */}
        {yTicks.map((tickValue, index) => {
          const y = scaleY(tickValue, bounds);
          return (
            <g key={index}>
              <line
                className="plot-grid-line"
                x1={PADDING_LEFT}
                y1={y}
                x2={WIDTH - PADDING_RIGHT}
                y2={y}
              />
              <text className="plot-tick-label" x={PADDING_LEFT - 8} y={y + 4} textAnchor="end">
                {formatValue(tickValue)}
              </text>
            </g>
          );
        })}
        <line
          className="plot-axis"
          x1={PADDING_LEFT}
          y1={HEIGHT - PADDING_BOTTOM}
          x2={WIDTH - PADDING_RIGHT}
          y2={HEIGHT - PADDING_BOTTOM}
        />
        <line
          className="plot-axis"
          x1={PADDING_LEFT}
          y1={PADDING_TOP}
          x2={PADDING_LEFT}
          y2={HEIGHT - PADDING_BOTTOM}
        />
        {lines.flatMap((line, index) => finitePlotSegments(line.values).map((segment, part) =>
          segment.length === 1 ? <circle key={index + "-" + part} cx={scaleX(segment[0].timeS, bounds)}
            cy={scaleY(segment[0].value, bounds)} r="3" fill={colors[index % colors.length]} /> :
          <path key={index + "-" + part} className="plot-line" d={createLinePath(segment, bounds)} fill="none"
            style={{ stroke: colors[index % colors.length] }} strokeDasharray={dashes[index % dashes.length]} />))}
        <text className="plot-tick-label" x={PADDING_LEFT} y={HEIGHT - 13} textAnchor="middle">
          {formatTime(bounds.minTimeS)}
        </text>
        <text
          className="plot-tick-label"
          x={WIDTH - PADDING_RIGHT}
          y={HEIGHT - 13}
          textAnchor="middle"
        >
          {formatTime(bounds.maxTimeS)}
        </text>
        <text className="plot-axis-label" x={WIDTH / 2} y={HEIGHT - 2} textAnchor="middle">
          time [s]
        </text>
      </svg>
      {(lines.length > 1 || showStatistics) && <ul className="plot-legend" aria-label={series.title + " signals"}>
        {lines.map((line, index) => {
          const stats = showStatistics ?
            getMovingStats(getFiniteValues(line.values), PLOT_MOVING_WINDOW_S, line.values.at(-1)?.timeS) : undefined;
          return <li key={line.label}>
            <svg width="24" height="10" aria-hidden="true"><line x1="0" y1="5" x2="24" y2="5"
              stroke={colors[index % colors.length]} strokeWidth="2.5" strokeDasharray={dashes[index % dashes.length]} /></svg>
            <span>{line.label}</span><strong>{formatValue(line.values.at(-1)?.value)} {series.unit}</strong>
            {stats && <small>avg {formatValue(stats.average)} · std {formatValue(stats.standardDeviation)}</small>}
          </li>;
        })}
      </ul>}
    </article>
  );
}

function createLinePath(values: PlotPoint[], bounds: PlotBounds): string {
  // Keep every sample, but round DRAWING coordinates to 0.01 SVG units.
  // This reduces per-update string size and uses a path instead of an SVG
  // point list. Physical values, axis bounds and statistics retain precision.
  return values
    .map((point, index) => `${index === 0 ? "M" : "L"}${scaleX(point.timeS, bounds).toFixed(2)} ${scaleY(point.value, bounds).toFixed(2)}`)
    .join("");
}

function getFiniteValues(values: PlotPoint[]): PlotPoint[] {
  return values.filter((point) => Number.isFinite(point.timeS) && Number.isFinite(point.value));
}

function getMovingStats(values: PlotPoint[], windowS: number, latestTimeS?: number): MovingStats {
  const latestValue = values.length === 0 ? undefined : values[values.length - 1];

  if (latestValue === undefined) {
    return { average: Number.NaN, standardDeviation: Number.NaN };
  }

  // Anchor to the displayed time even if the latest signal is unavailable.
  const minTimeS = (latestTimeS ?? latestValue.timeS) - windowS;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let i = values.length - 1; i >= 0; i -= 1) {
    const candidate = values[i];

    if (candidate.timeS < minTimeS) {
      break;
    }

    sum += candidate.value;
    sumSquares += candidate.value * candidate.value;
    count += 1;
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

function getBounds(values: PlotPoint[]): PlotBounds {
  if (values.length === 0) {
    return { minTimeS: 0, maxTimeS: 1, minValue: 0, maxValue: 1 };
  }

  // The caller already filtered missing values across all overlaid lines.
  let minTimeS = values[0].timeS;
  let maxTimeS = minTimeS;
  let minValue = values[0].value;
  let maxValue = values[0].value;

  for (const point of values) {
    minTimeS = Math.min(minTimeS, point.timeS);
    maxTimeS = Math.max(maxTimeS, point.timeS);
    minValue = Math.min(minValue, point.value);
    maxValue = Math.max(maxValue, point.value);
  }

  if (Math.abs(maxValue - minValue) < 1e-9) {
    const scale = Math.max(1, Math.abs(maxValue));
    minValue -= 0.05 * scale;
    maxValue += 0.05 * scale;
  } else {
    const padding = 0.08 * (maxValue - minValue);
    minValue -= padding;
    maxValue += padding;
  }

  return {
    minTimeS,
    maxTimeS: maxTimeS <= minTimeS ? minTimeS + 1 : maxTimeS,
    minValue,
    maxValue,
  };
}

function scaleX(timeS: number, bounds: PlotBounds): number {
  const usableWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
  return PADDING_LEFT + ((timeS - bounds.minTimeS) / (bounds.maxTimeS - bounds.minTimeS)) * usableWidth;
}

function scaleY(value: number, bounds: PlotBounds): number {
  const usableHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  return (
    HEIGHT -
    PADDING_BOTTOM -
    ((value - bounds.minValue) / (bounds.maxValue - bounds.minValue)) * usableHeight
  );
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

function formatTime(value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }

  return value.toFixed(value >= 10 ? 0 : 1);
}

function formatValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  const absoluteValue = Math.abs(value);

  if (absoluteValue >= 100) {
    return value.toFixed(0);
  }

  if (absoluteValue >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}
