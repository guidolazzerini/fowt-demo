import {
  computeAerodynamicOutputs,
  loadAeroTable,
  type AeroPerformanceTable,
} from "../sim/aero";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import type { ControlInputs, EnvironmentInputs } from "../sim/inputs";
import { stepSimulation } from "../sim/model";
import type { TunableParameters } from "../sim/params";
import type { TurbineState } from "../sim/state";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);

interface PitchStepSample {
  timeS: number;
  pitchDeg: number;
  rotorSpeedRpm: number;
  aeroTorqueMNm: number;
  thrustMN: number;
  platformPitchDeg: number;
  platformPitchRateDegPerSec: number;
  effectiveWindSpeedMps: number;
}

interface SeriesDefinition {
  title: string;
  unit: string;
  getValue: (sample: PitchStepSample) => number;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFinite(name: string, value: number): void {
  assert(Number.isFinite(value), `${name} is not finite: ${value}`);
}

function evaluateAero(
  table: AeroPerformanceTable,
  params: TunableParameters,
  rotorSpeedRadPerSec: number,
  pitchRad: number,
  windSpeedMps: number,
) {
  return computeAerodynamicOutputs(
    table,
    {
      rotorSpeedRadPerSec,
      pitchRad,
      windSpeedMps,
    },
    {
      airDensityKgPerM3: params.airDensityKgPerM3,
      rotorRadiusM: params.rotorRadiusM,
    },
  );
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function renderSingleChart(
  samples: PitchStepSample[],
  series: SeriesDefinition,
  stepTimeS: number,
): SVGSVGElement {
  const width = 620;
  const height = 210;
  const margin = {
    left: 58,
    right: 18,
    top: 28,
    bottom: 34,
  };

  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const values = samples.map(series.getValue);
  const times = samples.map((sample) => sample.timeS);

  const xMin = Math.min(...times);
  const xMax = Math.max(...times);

  let yMin = Math.min(...values);
  let yMax = Math.max(...values);

  if (Math.abs(yMax - yMin) < 1e-12) {
    yMin -= 1;
    yMax += 1;
  }

  const yPadding = 0.08 * (yMax - yMin);
  yMin -= yPadding;
  yMax += yPadding;

  const xScale = (timeS: number): number =>
    margin.left + ((timeS - xMin) / (xMax - xMin)) * innerWidth;

  const yScale = (value: number): number =>
    margin.top + ((yMax - value) / (yMax - yMin)) * innerHeight;

  const svg = createSvgElement("svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.background = "white";
  svg.style.border = "1px solid #ddd";
  svg.style.borderRadius = "8px";

  const title = createSvgElement("text");
  title.setAttribute("x", String(margin.left));
  title.setAttribute("y", "18");
  title.setAttribute("font-size", "13");
  title.setAttribute("font-family", "system-ui, sans-serif");
  title.setAttribute("font-weight", "600");
  title.textContent = `${series.title} [${series.unit}]`;
  svg.appendChild(title);

  const xAxis = createSvgElement("line");
  xAxis.setAttribute("x1", String(margin.left));
  xAxis.setAttribute("x2", String(width - margin.right));
  xAxis.setAttribute("y1", String(height - margin.bottom));
  xAxis.setAttribute("y2", String(height - margin.bottom));
  xAxis.setAttribute("stroke", "#333");
  svg.appendChild(xAxis);

  const yAxis = createSvgElement("line");
  yAxis.setAttribute("x1", String(margin.left));
  yAxis.setAttribute("x2", String(margin.left));
  yAxis.setAttribute("y1", String(margin.top));
  yAxis.setAttribute("y2", String(height - margin.bottom));
  yAxis.setAttribute("stroke", "#333");
  svg.appendChild(yAxis);

  const pathData = samples
    .map((sample, index) => {
      const x = xScale(sample.timeS);
      const y = yScale(series.getValue(sample));
      return `${index === 0 ? "M" : "L"} ${x.toFixed(3)} ${y.toFixed(3)}`;
    })
    .join(" ");

  const path = createSvgElement("path");
  path.setAttribute("d", pathData);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#0066cc");
  path.setAttribute("stroke-width", "2");
  svg.appendChild(path);

  const stepLine = createSvgElement("line");
  stepLine.setAttribute("x1", String(xScale(stepTimeS)));
  stepLine.setAttribute("x2", String(xScale(stepTimeS)));
  stepLine.setAttribute("y1", String(margin.top));
  stepLine.setAttribute("y2", String(height - margin.bottom));
  stepLine.setAttribute("stroke", "#cc0000");
  stepLine.setAttribute("stroke-width", "1.5");
  stepLine.setAttribute("stroke-dasharray", "5 4");
  svg.appendChild(stepLine);

  const xLabel = createSvgElement("text");
  xLabel.setAttribute("x", String(width / 2));
  xLabel.setAttribute("y", String(height - 8));
  xLabel.setAttribute("font-size", "11");
  xLabel.setAttribute("font-family", "system-ui, sans-serif");
  xLabel.setAttribute("text-anchor", "middle");
  xLabel.textContent = "time [s]";
  svg.appendChild(xLabel);

  const yMinLabel = createSvgElement("text");
  yMinLabel.setAttribute("x", String(margin.left - 8));
  yMinLabel.setAttribute("y", String(height - margin.bottom + 4));
  yMinLabel.setAttribute("font-size", "10");
  yMinLabel.setAttribute("font-family", "system-ui, sans-serif");
  yMinLabel.setAttribute("text-anchor", "end");
  yMinLabel.textContent = yMin.toPrecision(4);
  svg.appendChild(yMinLabel);

  const yMaxLabel = createSvgElement("text");
  yMaxLabel.setAttribute("x", String(margin.left - 8));
  yMaxLabel.setAttribute("y", String(margin.top + 4));
  yMaxLabel.setAttribute("font-size", "10");
  yMaxLabel.setAttribute("font-family", "system-ui, sans-serif");
  yMaxLabel.setAttribute("text-anchor", "end");
  yMaxLabel.textContent = yMax.toPrecision(4);
  svg.appendChild(yMaxLabel);

  const stepLabel = createSvgElement("text");
  stepLabel.setAttribute("x", String(xScale(stepTimeS) + 5));
  stepLabel.setAttribute("y", String(margin.top + 12));
  stepLabel.setAttribute("font-size", "10");
  stepLabel.setAttribute("font-family", "system-ui, sans-serif");
  stepLabel.setAttribute("fill", "#cc0000");
  stepLabel.textContent = "+1 deg pitch step";
  svg.appendChild(stepLabel);

  return svg;
}

function renderPitchStepPanel(samples: PitchStepSample[], stepTimeS: number): void {
  const existing = document.getElementById("pitch-step-check-panel");
  existing?.remove();

  const panel = document.createElement("section");
  panel.id = "pitch-step-check-panel";
  panel.style.padding = "16px";
  panel.style.margin = "16px";
  panel.style.border = "1px solid #ccc";
  panel.style.borderRadius = "12px";
  panel.style.background = "#f8f8f8";
  panel.style.fontFamily = "system-ui, sans-serif";

  const heading = document.createElement("h2");
  heading.textContent = "Pitch-step validation around V = 18 m/s above-rated steady state";
  heading.style.margin = "0 0 8px 0";
  heading.style.fontSize = "18px";
  panel.appendChild(heading);

  const note = document.createElement("p");
  note.textContent =
    "The red dashed line marks the +1 deg collective-pitch step. Generator torque is kept fixed.";
  note.style.margin = "0 0 14px 0";
  note.style.fontSize = "13px";
  panel.appendChild(note);

  const grid = document.createElement("div");
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(620px, 1fr))";
  grid.style.gap = "12px";

  const seriesDefinitions: SeriesDefinition[] = [
    {
      title: "Blade pitch",
      unit: "deg",
      getValue: (sample) => sample.pitchDeg,
    },
    {
      title: "Rotor speed",
      unit: "rpm",
      getValue: (sample) => sample.rotorSpeedRpm,
    },
    {
      title: "Aerodynamic torque",
      unit: "MNm",
      getValue: (sample) => sample.aeroTorqueMNm,
    },
    {
      title: "Rotor thrust",
      unit: "MN",
      getValue: (sample) => sample.thrustMN,
    },
    {
      title: "Platform pitch",
      unit: "deg",
      getValue: (sample) => sample.platformPitchDeg,
    },
    {
      title: "Effective wind speed",
      unit: "m/s",
      getValue: (sample) => sample.effectiveWindSpeedMps,
    },
  ];

  for (const series of seriesDefinitions) {
    grid.appendChild(renderSingleChart(samples, series, stepTimeS));
  }

  panel.appendChild(grid);
  document.body.appendChild(panel);
}

async function runPitchStepChecks(): Promise<void> {
  console.group("Pitch-step validation");

  const params = DEFAULT_TUNABLE_PARAMETERS;
  const aeroTable = await loadAeroTable(params.aero.filePath);

  const windSpeedMps = 18;
  const initialRotorSpeedRadPerSec = params.ratedRotorSpeedRadPerSec;

  // From your steady-state check at V = 18 m/s.
  const initialPitchRad = 15.596350340733814 * DEG_TO_RAD;

  const initialAero = evaluateAero(
    aeroTable,
    params,
    initialRotorSpeedRadPerSec,
    initialPitchRad,
    windSpeedMps,
  );

  const initialPlatformPitchRad =
    (params.thrustToPitchMomentArmM * initialAero.thrustN) /
    params.platformPitchStiffnessNm;

  const environment: EnvironmentInputs = {
    windSpeedMps,
    wavePitchMomentNm: 0,
  };

  const initialControl: ControlInputs = {
    collectivePitchRad: initialPitchRad,
    generatorTorqueNm: initialAero.torqueNm,
  };

  let state: TurbineState = {
    timeS: 0,
    rotorSpeedRadPerSec: initialRotorSpeedRadPerSec,
    rotorAzimuthRad: 0,
    platformPitchRad: initialPlatformPitchRad,
    platformPitchRateRadPerSec: 0,
  };

  const dtS = 0.02;
  const durationS = 80;
  const stepTimeS = 20;
  const pitchStepRad = 3 * DEG_TO_RAD;

  const samples: PitchStepSample[] = [];

  let sampleBeforeStep: PitchStepSample | undefined;
  let sampleAfterStep: PitchStepSample | undefined;

  const nSteps = Math.round(durationS / dtS);

  for (let k = 0; k <= nSteps; k += 1) {
    const timeS = k * dtS;

    const control: ControlInputs = {
      collectivePitchRad:
        timeS < stepTimeS
          ? initialControl.collectivePitchRad
          : initialControl.collectivePitchRad + pitchStepRad,
      generatorTorqueNm: initialControl.generatorTorqueNm,
    };

    const snapshot = stepSimulation(
      state,
      environment,
      control,
      params,
      aeroTable,
      { dtS },
    );

    state = snapshot.state;

    const sample: PitchStepSample = {
      timeS: snapshot.timeS,
      pitchDeg: control.collectivePitchRad * RAD_TO_DEG,
      rotorSpeedRpm: snapshot.state.rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM,
      aeroTorqueMNm: snapshot.outputs.aerodynamicTorqueNm / 1e6,
      thrustMN: snapshot.outputs.thrustN / 1e6,
      platformPitchDeg: snapshot.state.platformPitchRad * RAD_TO_DEG,
      platformPitchRateDegPerSec:
        snapshot.state.platformPitchRateRadPerSec * RAD_TO_DEG,
      effectiveWindSpeedMps: snapshot.outputs.effectiveWindSpeedMps,
    };

    samples.push(sample);

    if (timeS < stepTimeS) {
      sampleBeforeStep = sample;
    }

    if (sampleAfterStep === undefined && timeS >= stepTimeS + dtS) {
      sampleAfterStep = sample;
    }

    assertFinite("rotorSpeedRpm", sample.rotorSpeedRpm);
    assertFinite("aeroTorqueMNm", sample.aeroTorqueMNm);
    assertFinite("thrustMN", sample.thrustMN);
    assertFinite("platformPitchDeg", sample.platformPitchDeg);
    assertFinite("effectiveWindSpeedMps", sample.effectiveWindSpeedMps);
  }

  assert(sampleBeforeStep !== undefined, "Missing sample before pitch step.");
  assert(sampleAfterStep !== undefined, "Missing sample after pitch step.");

  const torqueDropMNm =
    sampleAfterStep.aeroTorqueMNm - sampleBeforeStep.aeroTorqueMNm;

  const thrustDropMN =
    sampleAfterStep.thrustMN - sampleBeforeStep.thrustMN;

  const rotorSpeedChangeRpm =
    sampleAfterStep.rotorSpeedRpm - sampleBeforeStep.rotorSpeedRpm;

  console.table([
    {
      quantity: "pitch",
      before: sampleBeforeStep.pitchDeg,
      after: sampleAfterStep.pitchDeg,
      delta: sampleAfterStep.pitchDeg - sampleBeforeStep.pitchDeg,
      unit: "deg",
    },
    {
      quantity: "aero torque",
      before: sampleBeforeStep.aeroTorqueMNm,
      after: sampleAfterStep.aeroTorqueMNm,
      delta: torqueDropMNm,
      unit: "MNm",
    },
    {
      quantity: "rotor thrust",
      before: sampleBeforeStep.thrustMN,
      after: sampleAfterStep.thrustMN,
      delta: thrustDropMN,
      unit: "MN",
    },
    {
      quantity: "rotor speed",
      before: sampleBeforeStep.rotorSpeedRpm,
      after: sampleAfterStep.rotorSpeedRpm,
      delta: rotorSpeedChangeRpm,
      unit: "rpm",
    },
  ]);

  assert(
    torqueDropMNm < 0,
    "Expected aerodynamic torque to decrease after positive pitch step.",
  );

  assert(
    thrustDropMN < 0,
    "Expected rotor thrust to decrease after positive pitch step.",
  );

  assert(
    rotorSpeedChangeRpm < 0,
    "Expected rotor speed to initially decrease after positive pitch step.",
  );

  renderPitchStepPanel(samples, stepTimeS);

  console.log("Pitch-step validation passed.");
  console.groupEnd();
}

if (import.meta.env.DEV) {
  void runPitchStepChecks().catch((error: unknown) => {
    console.error("Pitch-step validation failed:", error);
  });
}