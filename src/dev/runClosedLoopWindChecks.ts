import { loadAeroTable, type AeroPerformanceTable } from "../sim/aero";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import type { TunableParameters } from "../sim/params";
import {
  createClosedLoopScenario,
  createOpenLoopScenario,
  runSimulationScenario,
  type SimulationScenarioSample,
} from "../sim/simulation";
import type { WindDisturbanceConfig } from "../sim/wind";

type ClosedLoopSample = SimulationScenarioSample;

interface ResponseSeries {
  name: string;
  samples: ClosedLoopSample[];
}

interface ScalarStats {
  mean: number;
  standardDeviation: number;
  min: number;
  max: number;
}

const RAD_TO_DEG = 180 / Math.PI;
const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);
const INITIAL_WIND_SPEED_MPS = 18;

const WIND_CASES: WindDisturbanceConfig[] = [
  {
    mode: "constant",
    meanWindSpeedMps: INITIAL_WIND_SPEED_MPS,
    minWindSpeedMps: 0,
  },
  {
    mode: "gust",
    meanWindSpeedMps: INITIAL_WIND_SPEED_MPS,
    gustStartTimeSec: 20,
    gustDurationSec: 20,
    gustAmplitudeMps: 3,
    minWindSpeedMps: 0,
  },
  {
    mode: "turbulent",
    meanWindSpeedMps: INITIAL_WIND_SPEED_MPS,
    turbulenceIntensity: 0.06,
    seed: 20260516,
    lowPassTimeConstantSec: 4,
    minWindSpeedMps: 0,
    maxWindSpeedMps: 40,
  },
];

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Closed-loop wind validation failed: ${message}`);
  }
}

export async function runClosedLoopWindChecks(): Promise<void> {
  const params = DEFAULT_TUNABLE_PARAMETERS;
  const aeroTable = await loadAeroTable(params.aero.filePath);

  const checkMessages: string[] = [];
  const check = (condition: boolean, message: string): void => {
    assert(condition, message);
    checkMessages.push(`✓ ${message}`);
  };

  const constantOpenLoop = simulateResponse({
    name: "open-loop constant",
    windConfig: WIND_CASES[0],
    closedLoop: false,
    totalTimeS: 80,
    dtS: 0.05,
    params,
    aeroTable,
  });

  const constantClosedLoop = simulateResponse({
    name: "closed-loop constant",
    windConfig: WIND_CASES[0],
    closedLoop: true,
    totalTimeS: 80,
    dtS: 0.05,
    params,
    aeroTable,
  });

  const gustOpenLoop = simulateResponse({
    name: "open-loop gust",
    windConfig: WIND_CASES[1],
    closedLoop: false,
    totalTimeS: 100,
    dtS: 0.05,
    params,
    aeroTable,
  });

  const gustClosedLoop = simulateResponse({
    name: "closed-loop gust",
    windConfig: WIND_CASES[1],
    closedLoop: true,
    totalTimeS: 100,
    dtS: 0.05,
    params,
    aeroTable,
  });

  const turbulentOpenLoop = simulateResponse({
    name: "open-loop turbulent",
    windConfig: WIND_CASES[2],
    closedLoop: false,
    totalTimeS: 180,
    dtS: 0.05,
    params,
    aeroTable,
  });

  const turbulentClosedLoop = simulateResponse({
    name: "closed-loop turbulent",
    windConfig: WIND_CASES[2],
    closedLoop: true,
    totalTimeS: 180,
    dtS: 0.05,
    params,
    aeroTable,
  });

  const turbulentClosedLoopRepeat = simulateResponse({
    name: "closed-loop turbulent repeat",
    windConfig: WIND_CASES[2],
    closedLoop: true,
    totalTimeS: 180,
    dtS: 0.05,
    params,
    aeroTable,
  });

  const allSamples = [
    constantOpenLoop,
    constantClosedLoop,
    gustOpenLoop,
    gustClosedLoop,
    turbulentOpenLoop,
    turbulentClosedLoop,
    turbulentClosedLoopRepeat,
  ].flatMap((series) => series.samples);

  check(
    allSamples.every((sample) =>
      [
        sample.timeS,
        sample.windSpeedMps,
        sample.rotorSpeedRadPerSec,
        sample.collectivePitchRad,
        sample.platformPitchRad,
        sample.platformPitchRateRadPerSec,
        sample.wavePitchMomentNm,
      ].every(Number.isFinite),
    ),
    "all closed-loop validation signals are finite",
  );

  check(
    allSamples.every((sample) => sample.rotorSpeedRadPerSec > 0),
    "rotor speed remains positive",
  );

  check(
    allSamples.every(
      (sample) =>
        sample.collectivePitchRad >= params.minPitchRad - 1e-12 &&
        sample.collectivePitchRad <= params.maxPitchRad + 1e-12,
    ),
    "collective pitch remains within min/max limits",
  );

  check(
    pitchRateLimitIsRespected(gustClosedLoop.samples, 0.05, params) &&
      pitchRateLimitIsRespected(turbulentClosedLoop.samples, 0.05, params),
    "collective pitch rate respects the configured rate limit",
  );

  check(
    allSamples.every((sample) => sample.wavePitchMomentNm === 0),
    "wavePitchMomentNm remains zero",
  );

  const gustOpenLoopStats = calculateStats(
    selectWindow(gustOpenLoop.samples, 20, 70).map(
      (sample) => sample.rotorSpeedRadPerSec,
    ),
  );
  const gustClosedLoopStats = calculateStats(
    selectWindow(gustClosedLoop.samples, 20, 70).map(
      (sample) => sample.rotorSpeedRadPerSec,
    ),
  );

  check(
    gustClosedLoopStats.standardDeviation < gustOpenLoopStats.standardDeviation,
    "closed-loop rotor-speed variation is smaller than open-loop for gust wind",
  );

  const turbulentOpenLoopStats = calculateStats(
    selectWindow(turbulentOpenLoop.samples, 40, 180).map(
      (sample) => sample.rotorSpeedRadPerSec,
    ),
  );
  const turbulentClosedLoopStats = calculateStats(
    selectWindow(turbulentClosedLoop.samples, 40, 180).map(
      (sample) => sample.rotorSpeedRadPerSec,
    ),
  );

  check(
    turbulentClosedLoopStats.standardDeviation <
      turbulentOpenLoopStats.standardDeviation,
    "closed-loop rotor-speed variation is smaller than open-loop for turbulent wind",
  );

  check(
    gustPitchIncreasesAfterRotorOverspeed(gustClosedLoop.samples),
    "gust causes collective pitch to increase after rotor speed increases",
  );

  check(
    sameResponseSequence(
      turbulentClosedLoop.samples,
      turbulentClosedLoopRepeat.samples,
    ),
    "closed-loop turbulent response is deterministic for the same seed",
  );

  renderClosedLoopPanel(
    [constantClosedLoop, gustOpenLoop, gustClosedLoop, turbulentClosedLoop],
    checkMessages,
  );

  console.log("Closed-loop wind Step 5 validation passed.", {
    gustOpenLoopStats,
    gustClosedLoopStats,
    turbulentOpenLoopStats,
    turbulentClosedLoopStats,
  });
}

function simulateResponse(args: {
  name: string;
  windConfig: WindDisturbanceConfig;
  closedLoop: boolean;
  totalTimeS: number;
  dtS: number;
  params: TunableParameters;
  aeroTable: AeroPerformanceTable;
}): ResponseSeries {
  const scenario = args.closedLoop
    ? createClosedLoopScenario({
        name: args.name,
        totalTimeS: args.totalTimeS,
        dtS: args.dtS,
        wind: args.windConfig,
        params: args.params,
      })
    : createOpenLoopScenario({
        name: args.name,
        totalTimeS: args.totalTimeS,
        dtS: args.dtS,
        wind: args.windConfig,
        params: args.params,
      });

  return {
    name: args.name,
    samples: runSimulationScenario({
      scenario,
      params: args.params,
      aeroTable: args.aeroTable,
    }).samples,
  };
}

function selectWindow(
  samples: ClosedLoopSample[],
  startTimeS: number,
  endTimeS: number,
): ClosedLoopSample[] {
  return samples.filter(
    (sample) => sample.timeS >= startTimeS && sample.timeS <= endTimeS,
  );
}

function calculateStats(values: number[]): ScalarStats {
  assert(values.length > 0, "cannot calculate statistics for an empty array");

  const mean =
    values.reduce((runningSum, value) => runningSum + value, 0) / values.length;

  const variance =
    values.reduce((runningSum, value) => {
      const error = value - mean;
      return runningSum + error * error;
    }, 0) / values.length;

  return {
    mean,
    standardDeviation: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function pitchRateLimitIsRespected(
  samples: ClosedLoopSample[],
  dtS: number,
  params: TunableParameters,
): boolean {
  let previousPitchRad: number | undefined;

  for (const sample of samples) {
    if (previousPitchRad !== undefined) {
      const pitchRateRadPerSec =
        Math.abs(sample.collectivePitchRad - previousPitchRad) / dtS;

      if (pitchRateRadPerSec > params.maxPitchRateRadPerSec + 1e-9) {
        return false;
      }
    }

    previousPitchRad = sample.collectivePitchRad;
  }

  return true;
}

function gustPitchIncreasesAfterRotorOverspeed(
  samples: ClosedLoopSample[],
): boolean {
  const preGustSamples = selectWindow(samples, 10, 20);
  const activeSamples = selectWindow(samples, 20, 50);
  const preGustRotorStats = calculateStats(
    preGustSamples.map((sample) => sample.rotorSpeedRadPerSec),
  );
  const preGustPitchStats = calculateStats(
    preGustSamples.map((sample) => sample.collectivePitchRad),
  );

  const rotorThreshold = preGustRotorStats.mean + 1e-4;
  const pitchThreshold = preGustPitchStats.mean + 0.1 * (Math.PI / 180);
  let overspeedHasOccurred = false;

  for (const sample of activeSamples) {
    if (sample.rotorSpeedRadPerSec > rotorThreshold) {
      overspeedHasOccurred = true;
    }

    if (overspeedHasOccurred && sample.collectivePitchRad > pitchThreshold) {
      return true;
    }
  }

  return false;
}

function sameResponseSequence(
  samplesA: ClosedLoopSample[],
  samplesB: ClosedLoopSample[],
): boolean {
  if (samplesA.length !== samplesB.length) {
    return false;
  }

  for (let i = 0; i < samplesA.length; i += 1) {
    const sampleA = samplesA[i];
    const sampleB = samplesB[i];

    if (sampleA === undefined || sampleB === undefined) {
      return false;
    }

    if (
      sampleA.timeS !== sampleB.timeS ||
      sampleA.windSpeedMps !== sampleB.windSpeedMps ||
      sampleA.rotorSpeedRadPerSec !== sampleB.rotorSpeedRadPerSec ||
      sampleA.collectivePitchRad !== sampleB.collectivePitchRad ||
      sampleA.platformPitchRad !== sampleB.platformPitchRad ||
      sampleA.platformPitchRateRadPerSec !== sampleB.platformPitchRateRadPerSec
    ) {
      return false;
    }
  }

  return true;
}

function renderClosedLoopPanel(
  series: ResponseSeries[],
  checkMessages: string[],
): void {
  if (typeof document === "undefined") {
    return;
  }

  const existingPanel = document.getElementById("closed-loop-checks-panel");
  existingPanel?.remove();

  const panel = document.createElement("section");
  panel.id = "closed-loop-checks-panel";
  panel.style.cssText = [
    "margin: 16px",
    "padding: 16px",
    "border: 1px solid #ddd",
    "border-radius: 12px",
    "font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "background: #fff",
    "color: #111",
  ].join("; ");

  const title = document.createElement("h2");
  title.textContent = "Step 5 closed-loop wind checks";
  title.style.cssText = "margin: 0 0 8px 0; font-size: 18px";
  panel.appendChild(title);

  const description = document.createElement("p");
  description.textContent =
    "Region 3 pitch PI controller with fixed rated generator torque. Waves remain disabled.";
  description.style.cssText = "margin: 0 0 12px 0; font-size: 13px";
  panel.appendChild(description);

  panel.appendChild(
    createSvgPlot({
      title: "Wind speed",
      yLabel: "V [m/s]",
      series,
      getValue: (sample) => sample.windSpeedMps,
    }),
  );

  panel.appendChild(
    createSvgPlot({
      title: "Rotor speed",
      yLabel: "Ω [rpm]",
      series,
      getValue: (sample) => sample.rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM,
    }),
  );

  panel.appendChild(
    createSvgPlot({
      title: "Collective pitch",
      yLabel: "β [deg]",
      series,
      getValue: (sample) => sample.collectivePitchRad * RAD_TO_DEG,
    }),
  );

  panel.appendChild(
    createSvgPlot({
      title: "Platform pitch",
      yLabel: "θ [deg]",
      series,
      getValue: (sample) => sample.platformPitchRad * RAD_TO_DEG,
    }),
  );

  const list = document.createElement("ul");
  list.style.cssText =
    "margin: 12px 0 0 0; padding-left: 20px; font-size: 13px";

  for (const message of checkMessages) {
    const item = document.createElement("li");
    item.textContent = message;
    list.appendChild(item);
  }

  panel.appendChild(list);
  document.body.appendChild(panel);
}

function createSvgPlot(args: {
  title: string;
  yLabel: string;
  series: ResponseSeries[];
  getValue: (sample: ClosedLoopSample) => number;
}): SVGSVGElement {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const width = 980;
  const height = 280;
  const marginLeft = 64;
  const marginRight = 18;
  const marginTop = 34;
  const marginBottom = 42;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;
  const allSamples = args.series.flatMap((entry) => entry.samples);
  const tMin = Math.min(...allSamples.map((sample) => sample.timeS));
  const tMax = Math.max(...allSamples.map((sample) => sample.timeS));
  const rawYMin = Math.min(...allSamples.map(args.getValue));
  const rawYMax = Math.max(...allSamples.map(args.getValue));
  const yPadding = Math.max(0.001, 0.08 * (rawYMax - rawYMin || 1));
  const yMin = rawYMin - yPadding;
  const yMax = rawYMax + yPadding;
  const x = (timeS: number): number =>
    marginLeft + ((timeS - tMin) / (tMax - tMin)) * plotWidth;
  const y = (value: number): number =>
    marginTop + ((yMax - value) / (yMax - yMin)) * plotHeight;

  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("width", `${width}`);
  svg.setAttribute("height", `${height}`);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.cssText =
    "display: block; max-width: 100%; height: auto; margin-top: 10px";

  appendText(svg, marginLeft, 18, args.title, "start", 14);
  appendLine(svg, marginLeft, marginTop, marginLeft, marginTop + plotHeight);
  appendLine(
    svg,
    marginLeft,
    marginTop + plotHeight,
    marginLeft + plotWidth,
    marginTop + plotHeight,
  );
  appendText(svg, marginLeft, height - 10, "time [s]", "start", 12);
  appendText(svg, 8, marginTop + 12, args.yLabel, "start", 12);

  for (let iTick = 0; iTick <= 4; iTick += 1) {
    const fraction = iTick / 4;
    const tickTime = tMin + fraction * (tMax - tMin);
    const tickX = marginLeft + fraction * plotWidth;
    appendLine(
      svg,
      tickX,
      marginTop + plotHeight,
      tickX,
      marginTop + plotHeight + 5,
    );
    appendText(
      svg,
      tickX,
      marginTop + plotHeight + 20,
      tickTime.toFixed(0),
      "middle",
      12,
    );
  }

  for (let iTick = 0; iTick <= 4; iTick += 1) {
    const fraction = iTick / 4;
    const tickValue = yMin + fraction * (yMax - yMin);
    const tickY = y(tickValue);
    appendLine(svg, marginLeft - 5, tickY, marginLeft, tickY);
    appendText(
      svg,
      marginLeft - 8,
      tickY + 4,
      tickValue.toFixed(2),
      "end",
      12,
    );
  }

  const strokeColours = ["#1f77b4", "#d62728", "#2ca02c", "#9467bd"];

  args.series.forEach((entry, index) => {
    const points = entry.samples
      .map((sample) => `${x(sample.timeS)},${y(args.getValue(sample))}`)
      .join(" ");
    const colour = strokeColours[index % strokeColours.length];

    const polyline = document.createElementNS(svgNamespace, "polyline");
    polyline.setAttribute("points", points);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", colour);
    polyline.setAttribute("stroke-width", "2");
    svg.appendChild(polyline);

    const legendX = marginLeft + 185 + index * 175;
    const legendY = 15;
    appendLine(svg, legendX, legendY, legendX + 24, legendY, colour, 3);
    appendText(svg, legendX + 30, legendY + 4, entry.name, "start", 12);
  });

  return svg;
}

function appendLine(
  svg: SVGSVGElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke = "#222",
  strokeWidth = 1,
): void {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", `${x1}`);
  line.setAttribute("y1", `${y1}`);
  line.setAttribute("x2", `${x2}`);
  line.setAttribute("y2", `${y2}`);
  line.setAttribute("stroke", stroke);
  line.setAttribute("stroke-width", `${strokeWidth}`);
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(line);
}

function appendText(
  svg: SVGSVGElement,
  x: number,
  y: number,
  textContent: string,
  anchor: "start" | "middle" | "end",
  fontSize: number,
): void {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", `${x}`);
  text.setAttribute("y", `${y}`);
  text.setAttribute("text-anchor", anchor);
  text.setAttribute("font-size", `${fontSize}`);
  text.textContent = textContent;
  svg.appendChild(text);
}