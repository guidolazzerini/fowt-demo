import { loadAeroTable } from "../sim/aero";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import { stepSimulation } from "../sim/model";
import {
  createWindDisturbance,
  stepWindDisturbance,
  type WindDisturbanceConfig,
} from "../sim/wind";
import type {
  ControlInputs,
  SimulationOutputSnapshot,
  TurbineState,
} from "../sim/types";

interface TurbineResponseSample {
  timeS: number;
  windSpeedMps: number;
  rotorSpeedRadPerSec: number;
  platformPitchRad: number;
  platformPitchRateRadPerSec: number;
}

interface TurbineResponseSeries {
  name: string;
  samples: TurbineResponseSample[];
}

interface ScalarStats {
  mean: number;
  standardDeviation: number;
  min: number;
  max: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);

/**
 * Approximate above-rated operating point.
 *
 * This is deliberately open-loop:
 * - no pitch controller;
 * - no torque controller;
 * - no wave excitation.
 *
 * These values are close to the 18 m/s validation point used previously.
 */
const INITIAL_STATE: TurbineState = {
  timeS: 0,
  rotorSpeedRadPerSec: 0.791681349,
  rotorAzimuthRad: 0,
  platformPitchRad: 0,
  platformPitchRateRadPerSec: 0,
};

const FIXED_CONTROLS: ControlInputs = {
  collectivePitchRad: 14 * DEG_TO_RAD,
  generatorTorqueNm: 15e6 / 0.791681349,
};

export async function runWindResponseChecks(): Promise<void> {
  const aeroTable = await loadAeroTable(
    DEFAULT_TUNABLE_PARAMETERS.aero.filePath,
  );

  const checkMessages: string[] = [];

  const check = (condition: boolean, message: string): void => {
    if (!condition) {
      throw new Error(`Wind-response validation failed: ${message}`);
    }

    checkMessages.push(`✓ ${message}`);
  };

  const constantResponse = simulateTurbineResponse({
    name: "constant wind",
    windConfig: {
      mode: "constant",
      meanWindSpeedMps: 18,
      minWindSpeedMps: 0,
    },
    totalTimeS: 80,
    dtS: 0.05,
    aeroTable,
  });

  const gustResponse = simulateTurbineResponse({
    name: "gust wind",
    windConfig: {
      mode: "gust",
      meanWindSpeedMps: 18,
      gustStartTimeSec: 20,
      gustDurationSec: 20,
      gustAmplitudeMps: 3,
      minWindSpeedMps: 0,
    },
    totalTimeS: 80,
    dtS: 0.05,
    aeroTable,
  });

  const turbulentResponseA = simulateTurbineResponse({
    name: "turbulent wind",
    windConfig: {
      mode: "turbulent",
      meanWindSpeedMps: 18,
      turbulenceIntensity: 0.06,
      seed: 20260404,
      lowPassTimeConstantSec: 4,
      minWindSpeedMps: 0,
      maxWindSpeedMps: 40,
    },
    totalTimeS: 160,
    dtS: 0.05,
    aeroTable,
  });

  const turbulentResponseB = simulateTurbineResponse({
    name: "turbulent wind same seed",
    windConfig: {
      mode: "turbulent",
      meanWindSpeedMps: 18,
      turbulenceIntensity: 0.06,
      seed: 20260404,
      lowPassTimeConstantSec: 4,
      minWindSpeedMps: 0,
      maxWindSpeedMps: 40,
    },
    totalTimeS: 160,
    dtS: 0.05,
    aeroTable,
  });

  const turbulentResponseC = simulateTurbineResponse({
    name: "turbulent wind different seed",
    windConfig: {
      mode: "turbulent",
      meanWindSpeedMps: 18,
      turbulenceIntensity: 0.06,
      seed: 20260405,
      lowPassTimeConstantSec: 4,
      minWindSpeedMps: 0,
      maxWindSpeedMps: 40,
    },
    totalTimeS: 160,
    dtS: 0.05,
    aeroTable,
  });

  const allSamples = [
    ...constantResponse.samples,
    ...gustResponse.samples,
    ...turbulentResponseA.samples,
    ...turbulentResponseB.samples,
    ...turbulentResponseC.samples,
  ];

  check(
    allSamples.every((sample) => Number.isFinite(sample.windSpeedMps)),
    "all wind speeds are finite",
  );

  check(
    allSamples.every((sample) => Number.isFinite(sample.rotorSpeedRadPerSec)),
    "all rotor speeds are finite",
  );

  check(
    allSamples.every((sample) => Number.isFinite(sample.platformPitchRad)),
    "all platform pitch angles are finite",
  );

  check(
    allSamples.every((sample) =>
      Number.isFinite(sample.platformPitchRateRadPerSec),
    ),
    "all platform pitch rates are finite",
  );

  check(
    allSamples.every((sample) => sample.windSpeedMps >= 0),
    "wind speed never becomes negative",
  );

  check(
    allSamples.every((sample) => sample.rotorSpeedRadPerSec > 0),
    "rotor speed remains positive",
  );

  const constantWindStats = calculateStats(
    constantResponse.samples.map((sample) => sample.windSpeedMps),
  );

  check(
    constantWindStats.standardDeviation < 1e-12,
    "constant-wind input remains exactly constant",
  );

  const gustPreWindow = gustResponse.samples.filter(
    (sample) => sample.timeS >= 10 && sample.timeS < 20,
  );

  const gustActiveWindow = gustResponse.samples.filter(
    (sample) => sample.timeS >= 20 && sample.timeS <= 40,
  );

  const preGustRotorStats = calculateStats(
    gustPreWindow.map((sample) => sample.rotorSpeedRadPerSec),
  );

  const activeGustRotorStats = calculateStats(
    gustActiveWindow.map((sample) => sample.rotorSpeedRadPerSec),
  );

  const preGustPitchStats = calculateStats(
    gustPreWindow.map((sample) => sample.platformPitchRad),
  );

  const activeGustPitchStats = calculateStats(
    gustActiveWindow.map((sample) => sample.platformPitchRad),
  );

  check(
    activeGustRotorStats.max > preGustRotorStats.mean,
    "gust produces an increase in rotor speed under fixed pitch and torque",
  );

//   check(
//     activeGustPitchStats.max > preGustPitchStats.mean,
//     "gust produces an increase in platform pitch under increased thrust",
//   );

  check(
    sameResponseSequence(turbulentResponseA.samples, turbulentResponseB.samples),
    "turbulent turbine response is deterministic for the same seed",
  );

  check(
    !sameResponseSequence(
      turbulentResponseA.samples,
      turbulentResponseC.samples,
    ),
    "turbulent turbine response differs for different seeds",
  );

  const turbulentWindStats = calculateStats(
    turbulentResponseA.samples
      .filter((sample) => sample.timeS >= 40)
      .map((sample) => sample.windSpeedMps),
  );

  const turbulentRotorStats = calculateStats(
    turbulentResponseA.samples
      .filter((sample) => sample.timeS >= 40)
      .map((sample) => sample.rotorSpeedRadPerSec),
  );

  check(
    turbulentWindStats.standardDeviation > 0,
    "turbulent wind has nonzero variation",
  );

  check(
    turbulentRotorStats.standardDeviation > 0,
    "rotor speed responds to turbulent wind with nonzero variation",
  );

  renderWindResponsePanel(
    [constantResponse, gustResponse, turbulentResponseA],
    checkMessages,
  );

  console.log("Wind-response Step 4.4b validation passed.", {
    constantWindStats,
    preGustRotorStats,
    activeGustRotorStats,
    preGustPitchStats,
    activeGustPitchStats,
    turbulentWindStats,
    turbulentRotorStats,
  });
}

function simulateTurbineResponse(args: {
  name: string;
  windConfig: WindDisturbanceConfig;
  totalTimeS: number;
  dtS: number;
  aeroTable: Awaited<ReturnType<typeof loadAeroTable>>;
}): TurbineResponseSeries {
  const wind = createWindDisturbance(args.windConfig);

  let state: TurbineState = {
    ...INITIAL_STATE,
  };

  const samples: TurbineResponseSample[] = [];

  const nSteps = Math.round(args.totalTimeS / args.dtS);

  for (let iStep = 0; iStep <= nSteps; iStep += 1) {
    const windSample =
      iStep === 0
        ? stepWindDisturbance(wind, 0)
        : stepWindDisturbance(wind, args.dtS);

    const output: SimulationOutputSnapshot = stepSimulation(
      state,
      windSample.environment,
      FIXED_CONTROLS,
      DEFAULT_TUNABLE_PARAMETERS,
      args.aeroTable,
      {
        dtS: args.dtS,
      },
    );

    state = output.state;

    samples.push({
      timeS: state.timeS,
      windSpeedMps: windSample.windSpeedMps,
      rotorSpeedRadPerSec: state.rotorSpeedRadPerSec,
      platformPitchRad: state.platformPitchRad,
      platformPitchRateRadPerSec: state.platformPitchRateRadPerSec,
    });
  }

  return {
    name: args.name,
    samples,
  };
}

function sameResponseSequence(
  samplesA: TurbineResponseSample[],
  samplesB: TurbineResponseSample[],
): boolean {
  if (samplesA.length !== samplesB.length) {
    return false;
  }

  return samplesA.every((sampleA, index) => {
    const sampleB = samplesB[index];

    return (
      sampleA.windSpeedMps === sampleB.windSpeedMps &&
      sampleA.rotorSpeedRadPerSec === sampleB.rotorSpeedRadPerSec &&
      sampleA.platformPitchRad === sampleB.platformPitchRad &&
      sampleA.platformPitchRateRadPerSec ===
        sampleB.platformPitchRateRadPerSec
    );
  });
}

function calculateStats(values: number[]): ScalarStats {
  if (values.length === 0) {
    throw new Error("Cannot calculate statistics of an empty array.");
  }

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

function renderWindResponsePanel(
  series: TurbineResponseSeries[],
  checkMessages: string[],
): void {
  if (typeof document === "undefined") {
    return;
  }

  const existingPanel = document.getElementById("wind-response-checks-panel");
  existingPanel?.remove();

  const panel = document.createElement("section");
  panel.id = "wind-response-checks-panel";
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
  title.textContent = "Step 4.4b wind-response checks";
  title.style.cssText = "margin: 0 0 8px 0; font-size: 18px";
  panel.appendChild(title);

  const description = document.createElement("p");
  description.textContent =
    "Open-loop response with fixed collective pitch and fixed generator torque. Waves remain disabled.";
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
  series: TurbineResponseSeries[];
  getValue: (sample: TurbineResponseSample) => number;
}): SVGSVGElement {
  const svgNamespace = "http://www.w3.org/2000/svg";

  const width = 920;
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

  const strokeColours = ["#1f77b4", "#d62728", "#2ca02c"];

  args.series.forEach((entry, index) => {
    const points = entry.samples
      .map((sample) => `${x(sample.timeS)},${y(args.getValue(sample))}`)
      .join(" ");

    const polyline = document.createElementNS(svgNamespace, "polyline");
    polyline.setAttribute("points", points);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", strokeColours[index % strokeColours.length]);
    polyline.setAttribute("stroke-width", "2");
    svg.appendChild(polyline);

    const legendX = marginLeft + 220 + index * 170;
    const legendY = 15;

    appendLine(
      svg,
      legendX,
      legendY,
      legendX + 24,
      legendY,
      strokeColours[index % strokeColours.length],
      3,
    );

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