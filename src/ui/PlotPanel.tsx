import type { SimulationRunState } from "../app/useSimulation";
import type { SimulationScenarioSample } from "../sim/simulation";

interface PlotPanelProps {
  history: SimulationScenarioSample[];
  runState: SimulationRunState;
}

interface PlotSeries {
  title: string;
  unit: string;
  values: PlotPoint[];
}

interface PlotPoint {
  timeS: number;
  value: number;
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
const MAX_PLOT_POINTS = 300;

export function PlotPanel(props: PlotPanelProps) {
  const { history, runState } = props;
  const series = createPlotSeries(history);

  return (
    <section className="panel plot-panel" aria-labelledby="plots-heading">
      <div className="panel-header">
        <div>
          <h2 id="plots-heading">Time histories</h2>
          <p>Instantaneous traces only; 30 s average and standard deviation are shown as values.</p>
        </div>
        <span className={`plot-meta-pill run-state-${runState}`}>{formatRunState(runState)}</span>
      </div>

      {history.length === 0 ? (
        <p className="empty-state">Waiting for the first simulation sample.</p>
      ) : (
        <div className="plot-grid">
          {series.map((plotSeries) => (
            <MiniPlot key={plotSeries.title} series={plotSeries} />
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
      title: "Aerodynamic power",
      unit: "MW",
      values: history.map((sample) => ({
        timeS: sample.timeS,
        value: sample.aerodynamicPowerW / 1e6,
      })),
    },
  ];
}

function MiniPlot(props: { series: PlotSeries }) {
  const { series } = props;
  const finiteValues = getFiniteValues(series.values);
  const bounds = getBounds(finiteValues);
  const drawableValues = getDrawableValues(downsamplePlotPoints(finiteValues, MAX_PLOT_POINTS), bounds);
  const points = createPolylinePoints(drawableValues, bounds);
  const latestValue = getLatestValue(finiteValues);
  const stats = getMovingStats(finiteValues, PLOT_MOVING_WINDOW_S);
  const yTicks = [bounds.maxValue, 0.5 * (bounds.maxValue + bounds.minValue), bounds.minValue];

  return (
    <article className="mini-plot">
      <div className="mini-plot-header">
        <div>
          <h3>{series.title}</h3>
          <span>{series.unit}</span>
        </div>
        <div className="mini-plot-values">
          <strong>inst {formatValue(latestValue)}</strong>
          <span className="moving-average-value">avg {formatValue(stats.average)}</span>
          <span className="moving-std-value">std {formatValue(stats.standardDeviation)}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={series.title}>
        <rect
          className="plot-area"
          x={PADDING_LEFT}
          y={PADDING_TOP}
          width={WIDTH - PADDING_LEFT - PADDING_RIGHT}
          height={HEIGHT - PADDING_TOP - PADDING_BOTTOM}
        />
        {yTicks.map((tickValue) => {
          const y = scaleY(tickValue, bounds);
          return (
            <g key={tickValue}>
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
        <polyline className="plot-line" points={points} fill="none" />
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
    </article>
  );
}

function createPolylinePoints(values: PlotPoint[], bounds: PlotBounds): string {
  return values
    .map((point) => `${scaleX(point.timeS, bounds)} ${scaleY(point.value, bounds)}`)
    .join(" ");
}

function downsamplePlotPoints(values: PlotPoint[], maxPoints: number): PlotPoint[] {
  if (values.length <= maxPoints) {
    return values;
  }

  const downsampledValues: PlotPoint[] = [];
  const lastIndex = values.length - 1;

  for (let i = 0; i < maxPoints; i += 1) {
    const sourceIndex = Math.round((i / (maxPoints - 1)) * lastIndex);
    downsampledValues.push(values[sourceIndex]);
  }

  return downsampledValues;
}

function getLatestValue(values: PlotPoint[]): number | undefined {
  return values.length === 0 ? undefined : values[values.length - 1].value;
}

function getFiniteValues(values: PlotPoint[]): PlotPoint[] {
  return values.filter((point) => Number.isFinite(point.timeS) && Number.isFinite(point.value));
}

function getDrawableValues(values: PlotPoint[], bounds: PlotBounds): PlotPoint[] {
  if (values.length === 0) {
    return [];
  }

  if (values.length === 1) {
    return [
      { timeS: bounds.minTimeS, value: values[0].value },
      { timeS: bounds.maxTimeS, value: values[0].value },
    ];
  }

  return values;
}

function getMovingStats(values: PlotPoint[], windowS: number): MovingStats {
  const latestValue = values.length === 0 ? undefined : values[values.length - 1];

  if (latestValue === undefined) {
    return { average: Number.NaN, standardDeviation: Number.NaN };
  }

  const minTimeS = latestValue.timeS - windowS;
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

  const finiteValues = getFiniteValues(values);

  if (finiteValues.length === 0) {
    return { minTimeS: 0, maxTimeS: 1, minValue: 0, maxValue: 1 };
  }

  const minTimeS = finiteValues[0].timeS;
  const maxTimeS = finiteValues[finiteValues.length - 1].timeS;
  let minValue = finiteValues[0].value;
  let maxValue = finiteValues[0].value;

  for (const point of finiteValues) {
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
