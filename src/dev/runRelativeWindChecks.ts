import {
  computeAerodynamicOutputs,
  loadAeroTable,
  type AeroPerformanceTable,
} from "../sim/aero";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import type { EnvironmentInputs } from "../sim/inputs";
import { computeRelativeWind } from "../sim/model";
import type { TunableParameters } from "../sim/params";
import type { TurbineState } from "../sim/state";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);

interface RelativeWindDebugSample {
  timeS: number;
  freeStreamWindSpeedMps: number;
  projectedWindSpeedMps: number;
  platformVelocityWindCorrectionMps: number;
  effectiveWindSpeedMps: number;
  platformPitchDeg: number;
  platformPitchRateDegPerSec: number;
  rotorSpeedRpm: number;
  aerodynamicTorqueMNm: number;
  aerodynamicPowerMW: number;
  thrustMN: number;
  cp: number;
  ct: number;
}

interface ImposedPlatformMotionConfig {
  totalTimeS: number;
  dtS: number;
  windSpeedMps: number;
  amplitudeRad: number;
  frequencyHz: number;
  fixedPitchRad: number;
  initialRotorSpeedRadPerSec: number;
  generatorTorqueNm: number;
}

export async function runRelativeWindChecks(): Promise<void> {
  const params = DEFAULT_TUNABLE_PARAMETERS;
  const aeroTable = await loadAeroTable(params.aero.filePath);

  const config: ImposedPlatformMotionConfig = {
    totalTimeS: 80,
    dtS: 0.05,

    // Use rated wind for now.
    windSpeedMps: params.ratedWindSpeedMps,

    // Imposed motion: phi = A sin(2 pi f t)
    amplitudeRad: 10 * DEG_TO_RAD,
    frequencyHz: 0.04,

    // Important: use an aerodynamically active pitch for this check.
    // Try params.trimPitchRad afterwards to diagnose the current default.
    fixedPitchRad: 4 * DEG_TO_RAD,

    initialRotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec,
    generatorTorqueNm: params.ratedGeneratorTorqueNm,
  };

  const samples = runImposedPlatformMotionCheck(config, params, aeroTable);

  const oneSecondStride = Math.max(1, Math.round(1 / config.dtS));
  const selectedSamples = samples.filter(
    (_sample, index) => index % oneSecondStride === 0,
  );

  console.group("Relative-wind imposed platform-motion check");
  console.log("Imposed platform motion:", {
    equation: "phi(t) = A sin(2 pi f t)",
    amplitudeDeg: config.amplitudeRad * RAD_TO_DEG,
    frequencyHz: config.frequencyHz,
    windSpeedMps: config.windSpeedMps,
    fixedPitchDeg: config.fixedPitchRad * RAD_TO_DEG,
    shaftTiltDeg: params.shaftTiltRad * RAD_TO_DEG,
    leverArmM: params.pitchToWindCouplingMpsPerRadPerSec,
  });
  console.table(selectedSamples);
  console.log("Summary:", summarize(samples));
  console.groupEnd();

  renderRelativeWindPlot(samples);
}

function runImposedPlatformMotionCheck(
  config: ImposedPlatformMotionConfig,
  params: TunableParameters,
  aeroTable: AeroPerformanceTable,
): RelativeWindDebugSample[] {
  const samples: RelativeWindDebugSample[] = [];

  let rotorSpeedRadPerSec = config.initialRotorSpeedRadPerSec;

  for (
    let timeS = 0;
    timeS <= config.totalTimeS + 1e-12;
    timeS += config.dtS
  ) {
    const omega = 2 * Math.PI * config.frequencyHz;

    const platformPitchRad =
      config.amplitudeRad * Math.sin(omega * timeS);

    const platformPitchRateRadPerSec =
      config.amplitudeRad * omega * Math.cos(omega * timeS);

    const state: TurbineState = {
      timeS,
      rotorSpeedRadPerSec,
      rotorAzimuthRad: 0,
      platformPitchRad,
      platformPitchRateRadPerSec,
    };

    const environment: EnvironmentInputs = {
      windSpeedMps: config.windSpeedMps,
      wavePitchMomentNm: 0,
    };

    const relativeWind = computeRelativeWind(state, environment, params);

    const aero = computeAerodynamicOutputs(
      aeroTable,
      {
        rotorSpeedRadPerSec,
        pitchRad: config.fixedPitchRad,
        windSpeedMps: relativeWind.effectiveWindSpeedMps,
      },
      {
        airDensityKgPerM3: params.airDensityKgPerM3,
        rotorRadiusM: params.rotorRadiusM,
      },
    );

    samples.push({
      timeS,
      freeStreamWindSpeedMps: relativeWind.freeStreamWindSpeedMps,
      projectedWindSpeedMps: relativeWind.projectedWindSpeedMps,
      platformVelocityWindCorrectionMps:
        relativeWind.platformVelocityWindCorrectionMps,
      effectiveWindSpeedMps: relativeWind.effectiveWindSpeedMps,
      platformPitchDeg: platformPitchRad * RAD_TO_DEG,
      platformPitchRateDegPerSec: platformPitchRateRadPerSec * RAD_TO_DEG,
      rotorSpeedRpm: rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM,
      aerodynamicTorqueMNm: aero.torqueNm / 1e6,
      aerodynamicPowerMW: aero.powerW / 1e6,
      thrustMN: aero.thrustN / 1e6,
      cp: aero.cp,
      ct: aero.ct,
    });

    const rotorAccelerationRadPerSec2 =
      (aero.torqueNm - config.generatorTorqueNm) /
      params.rotorInertiaKgM2;

    rotorSpeedRadPerSec = Math.max(
      0,
      rotorSpeedRadPerSec + config.dtS * rotorAccelerationRadPerSec2,
    );
  }

  return samples;
}

function summarize(samples: RelativeWindDebugSample[]): Record<string, unknown> {
  return {
    freeStreamWindSpeedMps: range(samples.map((sample) => sample.freeStreamWindSpeedMps)),
    projectedWindSpeedMps: range(samples.map((sample) => sample.projectedWindSpeedMps)),
    platformVelocityWindCorrectionMps: range(
      samples.map((sample) => sample.platformVelocityWindCorrectionMps),
    ),
    effectiveWindSpeedMps: range(samples.map((sample) => sample.effectiveWindSpeedMps)),
    rotorSpeedRpm: range(samples.map((sample) => sample.rotorSpeedRpm)),
    aerodynamicPowerMW: range(samples.map((sample) => sample.aerodynamicPowerMW)),
  };
}

function range(values: number[]): { min: number; max: number; range: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);

  return {
    min,
    max,
    range: max - min,
  };
}

function renderRelativeWindPlot(samples: RelativeWindDebugSample[]): void {
  if (typeof document === "undefined") {
    return;
  }

  const previous = document.getElementById("relative-wind-debug-panel");
  previous?.remove();

  const panel = document.createElement("section");
  panel.id = "relative-wind-debug-panel";
  panel.style.cssText = [
    "position: fixed",
    "right: 16px",
    "bottom: 16px",
    "z-index: 9999",
    "width: min(760px, calc(100vw - 32px))",
    "background: rgba(255, 255, 255, 0.96)",
    "color: #111",
    "border: 1px solid #ccc",
    "border-radius: 12px",
    "box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18)",
    "padding: 12px",
    "font: 12px system-ui, sans-serif",
  ].join(";");

  const title = document.createElement("h2");
  title.textContent = "Relative-wind debug: imposed platform motion";
  title.style.cssText = "font-size: 15px; margin: 0 0 8px 0";
  panel.appendChild(title);

  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 340;
  canvas.style.cssText = "display: block; width: 100%; background: white; border: 1px solid #eee";
  panel.appendChild(canvas);

  const note = document.createElement("p");
  note.textContent =
    "Signals: V∞, V∞ cos(θ + ϕ), Hϕ˙, and Vn = max(0, V∞ cos(θ + ϕ) − Hϕ˙).";
  note.style.cssText = "margin: 8px 0 0 0";
  panel.appendChild(note);

  document.body.appendChild(panel);

  drawPlot(canvas, samples);
}

function drawPlot(
  canvas: HTMLCanvasElement,
  samples: RelativeWindDebugSample[],
): void {
  const context = canvas.getContext("2d");

  if (context === null) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  const marginLeft = 50;
  const marginRight = 20;
  const marginTop = 20;
  const marginBottom = 40;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const series = [
    {
      label: "V∞",
      color: "#1f77b4",
      values: samples.map((sample) => sample.freeStreamWindSpeedMps),
    },
    {
      label: "V∞ cos(θ + ϕ)",
      color: "#ff7f0e",
      values: samples.map((sample) => sample.projectedWindSpeedMps),
    },
    {
      label: "Hϕ˙",
      color: "#2ca02c",
      values: samples.map((sample) => sample.platformVelocityWindCorrectionMps),
    },
    {
      label: "Vn",
      color: "#d62728",
      values: samples.map((sample) => sample.effectiveWindSpeedMps),
    },
  ];

  const timeValues = samples.map((sample) => sample.timeS);
  const yValues = series.flatMap((item) => item.values);

  const xMin = Math.min(...timeValues);
  const xMax = Math.max(...timeValues);
  const yMinRaw = Math.min(...yValues);
  const yMaxRaw = Math.max(...yValues);
  const yPadding = 0.08 * Math.max(1e-9, yMaxRaw - yMinRaw);
  const yMin = yMinRaw - yPadding;
  const yMax = yMaxRaw + yPadding;

  context.clearRect(0, 0, width, height);
  context.lineWidth = 1;
  context.strokeStyle = "#333";

  context.beginPath();
  context.moveTo(marginLeft, marginTop);
  context.lineTo(marginLeft, marginTop + plotHeight);
  context.lineTo(marginLeft + plotWidth, marginTop + plotHeight);
  context.stroke();

  context.fillStyle = "#333";
  context.font = "11px system-ui, sans-serif";
  context.fillText("m/s", 8, marginTop + 12);
  context.fillText("time [s]", marginLeft + 0.5 * plotWidth - 20, height - 10);

  for (let i = 0; i <= 5; i += 1) {
    const yValue = yMin + ((yMax - yMin) * i) / 5;
    const y = scale(yValue, yMin, yMax, marginTop + plotHeight, marginTop);

    context.strokeStyle = "#eee";
    context.beginPath();
    context.moveTo(marginLeft, y);
    context.lineTo(marginLeft + plotWidth, y);
    context.stroke();

    context.fillStyle = "#333";
    context.fillText(yValue.toFixed(1), 8, y + 4);
  }

  series.forEach((item, seriesIndex) => {
    context.strokeStyle = item.color;
    context.lineWidth = item.label === "Vn" ? 2.5 : 1.6;
    context.beginPath();

    item.values.forEach((yValue, index) => {
      const xValue = timeValues[index] ?? xMin;
      const x = scale(xValue, xMin, xMax, marginLeft, marginLeft + plotWidth);
      const y = scale(yValue, yMin, yMax, marginTop + plotHeight, marginTop);

      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });

    context.stroke();

    const legendX = marginLeft + 8 + seriesIndex * 150;
    const legendY = marginTop + 12;

    context.strokeStyle = item.color;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(legendX, legendY);
    context.lineTo(legendX + 22, legendY);
    context.stroke();

    context.fillStyle = "#333";
    context.fillText(item.label, legendX + 28, legendY + 4);
  });
}

function scale(
  value: number,
  inputMin: number,
  inputMax: number,
  outputMin: number,
  outputMax: number,
): number {
  if (Math.abs(inputMax - inputMin) < 1e-12) {
    return 0.5 * (outputMin + outputMax);
  }

  return (
    outputMin +
    ((value - inputMin) / (inputMax - inputMin)) *
      (outputMax - outputMin)
  );
}