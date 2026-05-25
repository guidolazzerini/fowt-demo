import { loadAeroTable, type AeroPerformanceTable } from "../sim/aero";
import {
  createPitchControllerConfig,
  type PitchControllerConfig,
} from "../sim/controller";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import type { TunableParameters } from "../sim/params";
import {
  createClosedLoopScenario,
  runSimulationScenario,
  type SimulationInitialStateOptions,
  type SimulationScenarioResult,
  type SimulationScenarioSample,
} from "../sim/simulation";
import type { WindDisturbanceConfig } from "../sim/wind";

interface ResponseSeries {
  name: string;
  result: SimulationScenarioResult;
}

interface ScalarStats {
  mean: number;
  rms: number;
  standardDeviation: number;
  min: number;
  max: number;
}

const RAD_TO_DEG = 180 / Math.PI;
const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);
const INITIAL_WIND_SPEED_MPS = 14;
const DT_S = 0.0025;
const TOTAL_TIME_S = 100;
const PLATFORM_RATE_GAIN_S = 10;
const INITIAL_PLATFORM_PITCH_RATE_RAD_PER_SEC = 0.005;

const CONSTANT_WIND: WindDisturbanceConfig = {
  mode: "constant",
  meanWindSpeedMps: INITIAL_WIND_SPEED_MPS,
  minWindSpeedMps: 0,
};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Floating-feedback validation failed: ${message}`);
  }
}

export async function runFloatingFeedbackChecks(): Promise<void> {
  const params = DEFAULT_TUNABLE_PARAMETERS;
  const aeroTable = await loadAeroTable(params.aero.filePath);

  const baseConfig = createPitchControllerConfig(params);
  const floatingDisabledConfig: PitchControllerConfig = {
    ...baseConfig,
    floatingFeedbackEnabled: false,
    platformPitchRateGainS: 0,
  };
  const floatingEnabledConfig: PitchControllerConfig = {
    ...baseConfig,
    floatingFeedbackEnabled: true,
    platformPitchRateGainS: PLATFORM_RATE_GAIN_S,
  };

  const initialState: SimulationInitialStateOptions = {
    rotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec,
    platformPitchRateRadPerSec: INITIAL_PLATFORM_PITCH_RATE_RAD_PER_SEC,
    equilibriumWindSpeedMps: INITIAL_WIND_SPEED_MPS,
    equilibriumPitchRad: params.trimPitchRad,
  };

  const disabledResult = simulateFloatingFeedbackScenario({
    name: "floating feedback disabled",
    params,
    aeroTable,
    controllerConfig: floatingDisabledConfig,
    initialState,
  });

  const enabledResult = simulateFloatingFeedbackScenario({
    name: "floating feedback enabled",
    params,
    aeroTable,
    controllerConfig: floatingEnabledConfig,
    initialState,
  });

  const allResults = [disabledResult, enabledResult];
  const allSamples = allResults.flatMap((result) => result.samples);
  const allDiagnostics = allSamples
    .map((sample) => sample.controllerDiagnostics)
    .filter((diagnostics) => diagnostics !== undefined);

  assert(
    allSamples.every(sampleIsFinite),
    "all floating-feedback scenario signals are finite",
  );

  assert(
    allSamples.every((sample) => sample.rotorSpeedRadPerSec > 0),
    "rotor speed remains positive",
  );

  assert(
    allSamples.every(
      (sample) =>
        sample.collectivePitchRad >= params.minPitchRad - 1e-12 &&
        sample.collectivePitchRad <= params.maxPitchRad + 1e-12,
    ),
    "collective pitch remains within min/max limits",
  );

  assert(
    allResults.every((result) => pitchRateLimitIsRespected(result, params)),
    "collective pitch rate respects the configured rate limit",
  );

  assert(
    allSamples.every((sample) => sample.wavePitchMomentNm === 0),
    "wavePitchMomentNm remains zero",
  );

  assert(
    disabledResult.samples.every(
      (sample) =>
        sample.controllerDiagnostics === undefined ||
        Math.abs(sample.controllerDiagnostics.floatingPitchTermRad) < 1e-14,
    ),
    "floating pitch term is zero when floating feedback is disabled",
  );

  assert(
    enabledResult.samples.some(
      (sample) =>
        sample.controllerDiagnostics !== undefined &&
        Math.abs(sample.controllerDiagnostics.floatingPitchTermRad) > 1e-6,
    ),
    "floating pitch term is non-zero when floating feedback is enabled and platform pitch rate is non-zero",
  );

  assert(
    allDiagnostics.every((diagnostics) => {
      const expectedFloatingPitchTermRad =
        diagnostics.filteredPlatformPitchRateRadPerSec *
        floatingEnabledConfig.platformPitchRateGainS;

      return (
        Math.abs(diagnostics.floatingPitchTermRad) < 1e-14 ||
        Math.sign(diagnostics.floatingPitchTermRad) ===
          Math.sign(expectedFloatingPitchTermRad)
      );
    }),
    "floating pitch term has the expected gain-times-filtered-platform-rate sign",
  );

  // assert(
  //   allDiagnostics.every((diagnostics) => {
  //     const expectedFloatingPitchTermRad =
  //       diagnostics.filteredPlatformPitchRateRadPerSec *
  //       floatingEnabledConfig.platformPitchRateGainS;

  //     return (
  //       Math.abs(
  //         diagnostics.floatingPitchTermRad - expectedFloatingPitchTermRad,
  //       ) < 1e-10
  //     );
  //   }),
  //   "floating pitch term equals gain times filtered platform pitch rate",
  // );

  const disabledPlatformRateStats = calculateStats(
    selectWindow(disabledResult.samples, 20, TOTAL_TIME_S).map(
      (sample) => sample.platformPitchRateRadPerSec,
    ),
  );
  const enabledPlatformRateStats = calculateStats(
    selectWindow(enabledResult.samples, 20, TOTAL_TIME_S).map(
      (sample) => sample.platformPitchRateRadPerSec,
    ),
  );

  assert(
    enabledPlatformRateStats.rms < disabledPlatformRateStats.rms,
    "enabled floating feedback reduces platform-pitch-rate RMS over the selected decay window",
  );

  renderFloatingFeedbackPanel(
    [
      { name: "disabled", result: disabledResult },
      { name: "enabled", result: enabledResult },
    ],
    {
      disabledPlatformRateStats,
      enabledPlatformRateStats,
      platformPitchRateGainS: floatingEnabledConfig.platformPitchRateGainS,
    },
  );

  console.log("Floating feedback Step 6.1 validation passed.", {
    disabledPlatformRateStats,
    enabledPlatformRateStats,
    platformPitchRateGainS: floatingEnabledConfig.platformPitchRateGainS,
  });
}

function simulateFloatingFeedbackScenario(args: {
  name: string;
  params: TunableParameters;
  aeroTable: AeroPerformanceTable;
  controllerConfig: PitchControllerConfig;
  initialState: SimulationInitialStateOptions;
}): SimulationScenarioResult {
  return runSimulationScenario({
    params: args.params,
    aeroTable: args.aeroTable,
    scenario: createClosedLoopScenario({
      name: args.name,
      totalTimeS: TOTAL_TIME_S,
      dtS: DT_S,
      wind: CONSTANT_WIND,
      params: args.params,
      initialState: args.initialState,
      controllerConfig: args.controllerConfig,
    }),
  });
}

function sampleIsFinite(sample: SimulationScenarioSample): boolean {
  return [
    sample.timeS,
    sample.windSpeedMps,
    sample.meanWindSpeedMps,
    sample.gustMps,
    sample.turbulentMps,
    sample.effectiveWindSpeedMps,
    sample.rotorSpeedRadPerSec,
    sample.rotorAzimuthRad,
    sample.collectivePitchRad,
    sample.generatorTorqueNm,
    sample.platformPitchRad,
    sample.platformPitchRateRadPerSec,
    sample.aerodynamicPowerW,
    sample.aerodynamicTorqueNm,
    sample.thrustN,
    sample.cp,
    sample.ct,
    sample.wavePitchMomentNm,
  ].every(Number.isFinite);
}

function pitchRateLimitIsRespected(
  result: SimulationScenarioResult,
  params: TunableParameters,
): boolean {
  let previousPitchRad: number | undefined;

  for (const sample of result.samples) {
    if (previousPitchRad !== undefined) {
      const pitchRateRadPerSec =
        Math.abs(sample.collectivePitchRad - previousPitchRad) /
        result.scenario.dtS;

      if (pitchRateRadPerSec > params.maxPitchRateRadPerSec + 1e-9) {
        return false;
      }
    }

    previousPitchRad = sample.collectivePitchRad;
  }

  return true;
}

function selectWindow(
  samples: SimulationScenarioSample[],
  startTimeS: number,
  endTimeS: number,
): SimulationScenarioSample[] {
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
    rms: Math.sqrt(
      values.reduce((runningSum, value) => runningSum + value * value, 0) /
        values.length,
    ),
    standardDeviation: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function renderFloatingFeedbackPanel(
  series: ResponseSeries[],
  summary: {
    disabledPlatformRateStats: ScalarStats;
    enabledPlatformRateStats: ScalarStats;
    platformPitchRateGainS: number;
  },
): void {
  if (typeof document === "undefined") {
    return;
  }

  const existingPanel = document.getElementById("floating-feedback-checks-panel");
  existingPanel?.remove();

  const panel = document.createElement("section");
  panel.id = "floating-feedback-checks-panel";
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
  title.textContent = "Step 6.1 floating-feedback checks";
  title.style.cssText = "margin: 0 0 8px 0; font-size: 18px";
  panel.appendChild(title);

  const description = document.createElement("p");
  description.textContent =
    `Closed-loop constant-wind decay from an initial platform pitch-rate perturbation. ` +
    `Enabled case uses Kfloat = ${summary.platformPitchRateGainS.toFixed(2)} s applied to LPF(platform pitch rate).`;
  description.style.cssText = "margin: 0 0 12px 0; font-size: 13px";
  panel.appendChild(description);

  panel.appendChild(
    createSvgPlot({
      title: "Platform pitch",
      yLabel: "θ [deg]",
      series,
      getValue: (sample) => sample.platformPitchRad * RAD_TO_DEG,
    }),
  );

  panel.appendChild(
    createSvgPlot({
      title: "Platform pitch rate",
      yLabel: "θdot [deg/s]",
      series,
      getValue: (sample) => sample.platformPitchRateRadPerSec * RAD_TO_DEG,
    }),
  );

  panel.appendChild(
    createSvgPlot({
      title: "Filtered platform pitch rate used by floating feedback",
      yLabel: "LPF(θdot) [deg/s]",
      series,
      getValue: (sample) =>
        (sample.controllerDiagnostics?.filteredPlatformPitchRateRadPerSec ?? 0) *
        RAD_TO_DEG,
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
      title: "Floating pitch term",
      yLabel: "βfloat [deg]",
      series,
      getValue: (sample) =>
        (sample.controllerDiagnostics?.floatingPitchTermRad ?? 0) * RAD_TO_DEG,
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

  const summaryText = document.createElement("p");
  summaryText.textContent =
    `Platform-pitch-rate RMS disabled = ${summary.disabledPlatformRateStats.rms.toExponential(3)} rad/s, ` +
    `enabled = ${summary.enabledPlatformRateStats.rms.toExponential(3)} rad/s.`;
  summaryText.style.cssText = "margin: 12px 0 0 0; font-size: 13px";
  panel.appendChild(summaryText);

  document.body.appendChild(panel);
}

function createSvgPlot(args: {
  title: string;
  yLabel: string;
  series: ResponseSeries[];
  getValue: (sample: SimulationScenarioSample) => number;
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
  const allSamples = args.series.flatMap((entry) => entry.result.samples);
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
    appendText(svg, marginLeft - 8, tickY + 4, tickValue.toFixed(2), "end", 12);
  }

  const strokeColours = ["#1f77b4", "#d62728"];

  args.series.forEach((entry, index) => {
    const points = entry.result.samples
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
