import {
  createWindDisturbance,
  getWindDisturbanceSample,
  stepWindDisturbance,
  type WindDisturbanceConfig,
  type WindDisturbanceSample,
} from "../sim/wind";

interface WindSeries {
  name: string;
  samples: WindDisturbanceSample[];
}

interface ScalarStats {
  mean: number;
  standardDeviation: number;
  min: number;
  max: number;
}

export function runWindChecks(): void {
  const checkMessages: string[] = [];

  const check = (condition: boolean, message: string): void => {
    if (!condition) {
      throw new Error(`Wind Step 4.4a validation failed: ${message}`);
    }

    checkMessages.push(`✓ ${message}`);
  };

  const constantMeanMps = 12;
  const constantSamples = simulateWind(
    {
      mode: "constant",
      meanWindSpeedMps: constantMeanMps,
    },
    60,
    0.1,
  );

  check(
    constantSamples.every(
      (sample) => sample.windSpeedMps === constantMeanMps,
    ),
    "constant wind remains exactly constant",
  );

  check(
    constantSamples.every((sample) => sample.environment.wavePitchMomentNm === 0),
    "wavePitchMomentNm remains zero",
  );

  const gustMeanMps = 12;
  const gustAmplitudeMps = 3;
  const gustStartTimeSec = 10;
  const gustDurationSec = 20;

  const gustSamples = simulateWind(
    {
      mode: "gust",
      meanWindSpeedMps: gustMeanMps,
      gustStartTimeSec,
      gustDurationSec,
      gustAmplitudeMps,
      minWindSpeedMps: 0,
    },
    40,
    0.05,
  );

  const gustStartSample = nearestSample(gustSamples, gustStartTimeSec);
  const gustPeakSample = nearestSample(
    gustSamples,
    gustStartTimeSec + 0.5 * gustDurationSec,
  );
  const gustEndSample = nearestSample(
    gustSamples,
    gustStartTimeSec + gustDurationSec,
  );
  const gustAfterEndSample = nearestSample(
    gustSamples,
    gustStartTimeSec + gustDurationSec + 5,
  );

  check(
    Math.abs(gustStartSample.windSpeedMps - gustMeanMps) < 1e-10,
    "gust starts at the mean wind speed",
  );

  check(
    Math.abs(
      gustPeakSample.windSpeedMps - (gustMeanMps + gustAmplitudeMps),
    ) < 1e-3,
    "gust peaks approximately at the requested amplitude",
  );

  check(
    Math.abs(gustEndSample.windSpeedMps - gustMeanMps) < 1e-10,
    "gust returns to mean wind speed at the end",
  );

  check(
    Math.abs(gustAfterEndSample.windSpeedMps - gustMeanMps) < 1e-10,
    "gust remains at mean wind speed after the event",
  );

  const turbulentConfigA = {
    mode: "turbulent",
    meanWindSpeedMps: 12,
    turbulenceIntensity: 0.08,
    seed: 12345,
    lowPassTimeConstantSec: 5,
    minWindSpeedMps: 0,
    maxWindSpeedMps: 40,
  } satisfies WindDisturbanceConfig;

  const turbulentConfigB = {
    ...turbulentConfigA,
    seed: 12346,
  } satisfies WindDisturbanceConfig;

  const turbulentSamplesA1 = simulateWind(turbulentConfigA, 600, 0.1);
  const turbulentSamplesA2 = simulateWind(turbulentConfigA, 600, 0.1);
  const turbulentSamplesB = simulateWind(turbulentConfigB, 600, 0.1);

  check(
    sameWindSequence(turbulentSamplesA1, turbulentSamplesA2),
    "random wind is deterministic for the same seed",
  );

  check(
    !sameWindSequence(turbulentSamplesA1, turbulentSamplesB),
    "random wind differs for different seeds",
  );

  const allSamples = [
    ...constantSamples,
    ...gustSamples,
    ...turbulentSamplesA1,
    ...turbulentSamplesB,
  ];

  check(
    allSamples.every((sample) => Number.isFinite(sample.windSpeedMps)),
    "all wind speeds are finite",
  );

  check(
    allSamples.every((sample) => sample.windSpeedMps >= 0),
    "wind speed never becomes negative",
  );

  check(
    allSamples.every(
      (sample) => sample.environment.windSpeedMps === sample.windSpeedMps,
    ),
    "wind output is compatible with EnvironmentInputs.windSpeedMps",
  );

  const turbulentSamplesAfterTransient = turbulentSamplesA1.filter(
    (sample) => sample.timeSec >= 60,
  );

  const turbulentStats = calculateStats(
    turbulentSamplesAfterTransient.map((sample) => sample.windSpeedMps),
  );

  const requestedMeanMps = turbulentConfigA.meanWindSpeedMps;
  const requestedSigmaMps =
    turbulentConfigA.turbulenceIntensity * turbulentConfigA.meanWindSpeedMps;

  check(
    Math.abs(turbulentStats.mean - requestedMeanMps) < 0.5,
    "random wind has approximate mean close to requested mean",
  );

  check(
    turbulentStats.standardDeviation > 0.45 * requestedSigmaMps &&
      turbulentStats.standardDeviation < 1.55 * requestedSigmaMps,
    "random wind has nonzero standard deviation consistent with the requested turbulence intensity",
  );

  const plotConstantSamples = simulateWind(
    {
      mode: "constant",
      meanWindSpeedMps: 12,
    },
    80,
    0.2,
  );

  const plotGustSamples = simulateWind(
    {
      mode: "gust",
      meanWindSpeedMps: 12,
      gustStartTimeSec: 20,
      gustDurationSec: 25,
      gustAmplitudeMps: 4,
      minWindSpeedMps: 0,
    },
    80,
    0.2,
  );

  const plotTurbulentSamples = simulateWind(
    {
      mode: "turbulent",
      meanWindSpeedMps: 12,
      turbulenceIntensity: 0.08,
      seed: 20260404,
      lowPassTimeConstantSec: 4,
      minWindSpeedMps: 0,
      maxWindSpeedMps: 40,
    },
    80,
    0.2,
  );

  renderWindCheckPanel(
    [
      {
        name: "constant wind",
        samples: plotConstantSamples,
      },
      {
        name: "gust wind",
        samples: plotGustSamples,
      },
      {
        name: "random wind",
        samples: plotTurbulentSamples,
      },
    ],
    checkMessages,
    turbulentStats,
    requestedSigmaMps,
  );

  console.log("Wind Step 4.4a validation passed.", {
    turbulentStats,
    requestedMeanMps,
    requestedSigmaMps,
  });
}

function simulateWind(
  config: WindDisturbanceConfig,
  totalTimeSec: number,
  dtSec: number,
): WindDisturbanceSample[] {
  const disturbance = createWindDisturbance(config);
  const samples: WindDisturbanceSample[] = [
    getWindDisturbanceSample(disturbance),
  ];

  const nSteps = Math.round(totalTimeSec / dtSec);

  for (let iStep = 0; iStep < nSteps; iStep += 1) {
    samples.push(stepWindDisturbance(disturbance, dtSec));
  }

  return samples;
}

function nearestSample(
  samples: WindDisturbanceSample[],
  targetTimeSec: number,
): WindDisturbanceSample {
  let nearest = samples[0];

  for (const sample of samples) {
    if (
      Math.abs(sample.timeSec - targetTimeSec) <
      Math.abs(nearest.timeSec - targetTimeSec)
    ) {
      nearest = sample;
    }
  }

  return nearest;
}

function sameWindSequence(
  samplesA: WindDisturbanceSample[],
  samplesB: WindDisturbanceSample[],
): boolean {
  if (samplesA.length !== samplesB.length) {
    return false;
  }

  return samplesA.every(
    (sample, index) => sample.windSpeedMps === samplesB[index].windSpeedMps,
  );
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

function renderWindCheckPanel(
  series: WindSeries[],
  checkMessages: string[],
  turbulentStats: ScalarStats,
  requestedSigmaMps: number,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const existingPanel = document.getElementById("wind-checks-panel");
  existingPanel?.remove();

  const panel = document.createElement("section");
  panel.id = "wind-checks-panel";
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
  title.textContent = "Step 4.4a wind disturbance checks";
  title.style.cssText = "margin: 0 0 8px 0; font-size: 18px";
  panel.appendChild(title);

  const summary = document.createElement("p");
  summary.textContent = `Turbulent wind after transient: mean = ${turbulentStats.mean.toFixed(
    3,
  )} m/s, std = ${turbulentStats.standardDeviation.toFixed(
    3,
  )} m/s, requested sigma = ${requestedSigmaMps.toFixed(3)} m/s.`;
  summary.style.cssText = "margin: 0 0 12px 0; font-size: 13px";
  panel.appendChild(summary);

  panel.appendChild(createSvgPlot(series));

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

function createSvgPlot(series: WindSeries[]): SVGSVGElement {
  const svgNamespace = "http://www.w3.org/2000/svg";

  const width = 920;
  const height = 360;
  const marginLeft = 58;
  const marginRight = 18;
  const marginTop = 22;
  const marginBottom = 44;

  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const allSamples = series.flatMap((entry) => entry.samples);
  const tMin = Math.min(...allSamples.map((sample) => sample.timeSec));
  const tMax = Math.max(...allSamples.map((sample) => sample.timeSec));
  const rawVMin = Math.min(...allSamples.map((sample) => sample.windSpeedMps));
  const rawVMax = Math.max(...allSamples.map((sample) => sample.windSpeedMps));
  const vPadding = Math.max(0.5, 0.08 * (rawVMax - rawVMin));
  const vMin = rawVMin - vPadding;
  const vMax = rawVMax + vPadding;

  const x = (timeSec: number): number =>
    marginLeft + ((timeSec - tMin) / (tMax - tMin)) * plotWidth;

  const y = (windSpeedMps: number): number =>
    marginTop + ((vMax - windSpeedMps) / (vMax - vMin)) * plotHeight;

  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("width", `${width}`);
  svg.setAttribute("height", `${height}`);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.cssText = "display: block; max-width: 100%; height: auto";

  appendLine(svg, marginLeft, marginTop, marginLeft, marginTop + plotHeight);
  appendLine(
    svg,
    marginLeft,
    marginTop + plotHeight,
    marginLeft + plotWidth,
    marginTop + plotHeight,
  );

  appendText(svg, marginLeft, height - 10, "time [s]", "start");
  appendText(svg, 8, marginTop + 12, "V [m/s]", "start");

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
    );
  }

  for (let iTick = 0; iTick <= 4; iTick += 1) {
    const fraction = iTick / 4;
    const tickWindSpeed = vMin + fraction * (vMax - vMin);
    const tickY = y(tickWindSpeed);

    appendLine(svg, marginLeft - 5, tickY, marginLeft, tickY);
    appendText(
      svg,
      marginLeft - 8,
      tickY + 4,
      tickWindSpeed.toFixed(1),
      "end",
    );
  }

  const strokeColours = ["#1f77b4", "#d62728", "#2ca02c"];

  series.forEach((entry, index) => {
    const points = entry.samples
      .map((sample) => `${x(sample.timeSec)},${y(sample.windSpeedMps)}`)
      .join(" ");

    const polyline = document.createElementNS(svgNamespace, "polyline");
    polyline.setAttribute("points", points);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", strokeColours[index % strokeColours.length]);
    polyline.setAttribute("stroke-width", "2");
    svg.appendChild(polyline);

    const legendX = marginLeft + 16 + index * 170;
    const legendY = marginTop + 8;

    appendLine(
      svg,
      legendX,
      legendY,
      legendX + 24,
      legendY,
      strokeColours[index % strokeColours.length],
      3,
    );
    appendText(svg, legendX + 30, legendY + 4, entry.name, "start");
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
): void {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", `${x}`);
  text.setAttribute("y", `${y}`);
  text.setAttribute("text-anchor", anchor);
  text.setAttribute("font-size", "12");
  text.textContent = textContent;
  svg.appendChild(text);
}