/// <reference lib="webworker" />

import { computeAerodynamicOutputs, loadAeroTable, type AeroPerformanceTable } from "./aero";
import {
  createPitchControllerConfig,
  createPitchControllerState,
  stepPitchController,
  type PitchControllerConfig,
  type PitchControllerDiagnostics,
  type PitchControllerState,
} from "./controller";
import { DEFAULT_TUNABLE_PARAMETERS } from "./defaults";
import type { ControlInputs } from "./inputs";
import { computeRelativeWind, stepSimulation } from "./model";
import type { TunableParameters } from "./params";
import type { SimulationScenarioSample } from "./simulation";
import type { TurbineState } from "./state";
import {
  createWindDisturbance,
  getWindDisturbanceSample,
  stepWindDisturbance,
  type WindDisturbance,
  type WindDisturbanceConfig,
  type WindDisturbanceSample,
} from "./wind";
import {
  DEFAULT_SIMULATION_UI_SETTINGS,
  DEMO_WIND_SPEED_MAX_MPS,
  DEMO_WIND_SPEED_MIN_MPS,
  type ControllerBandwidthEstimate,
  type SimulationUiSettings,
  type SimulationWorkerRequest,
  type SimulationWorkerResponse,
  type SimulationWorkerStatus,
} from "./workerMessages";

const DEG_TO_RAD = Math.PI / 180;
const WORKER_TICK_MS = 50;
const UI_SAMPLE_POST_EVERY_N_TICKS = 2;
const BANDWIDTH_ESTIMATE_UPDATE_INTERVAL_S = 1;
const MIN_BANDWIDTH_SCAN_RAD_PER_SEC = 1e-4;
const MAX_BANDWIDTH_SCAN_RAD_PER_SEC = 10;
const BANDWIDTH_SCAN_POINTS = 160;

let settings: SimulationUiSettings = { ...DEFAULT_SIMULATION_UI_SETTINGS };
let status: SimulationWorkerStatus = "idle";
let isRunning = false;
let timerId: number | undefined;
let aeroTable: AeroPerformanceTable | undefined;
let params: TunableParameters = buildParameters(settings);
let controllerConfig: PitchControllerConfig = buildControllerConfig(params, settings);
let controllerState: PitchControllerState | undefined;
let wind: WindDisturbance | undefined;
let windSample: WindDisturbanceSample | undefined;
let state: TurbineState | undefined;
let control: ControlInputs | undefined;
let controllerDiagnostics: PitchControllerDiagnostics | undefined;
let workerTickCount = 0;
let cachedControllerBandwidthEstimate: ControllerBandwidthEstimate | undefined;
let cachedControllerBandwidthTimeS = Number.NEGATIVE_INFINITY;

self.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
  void handleRequest(event.data);
};

async function handleRequest(request: SimulationWorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case "initialise":
        await initialise();
        break;
      case "start":
        await initialise();
        startLoop();
        break;
      case "stop":
        stopLoop();
        postStatus("ready");
        break;
      case "reset":
        stopLoop();
        await initialise();
        resetSimulationState();
        status = "ready";
        postReady();
        break;
      case "update-settings":
        await initialise();
        updateSettings(request.settings);
        postCurrentSample();
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status = "error";
    stopLoop();
    postMessageToMain({ type: "error", message, isRunning });
  }
}

async function initialise(): Promise<void> {
  if (aeroTable !== undefined && state !== undefined) {
    return;
  }

  status = "loading";
  postStatus("loading", "Loading aerodynamic table");

  aeroTable = await loadAeroTable(DEFAULT_TUNABLE_PARAMETERS.aero.filePath);
  resetSimulationState();

  status = "ready";
  postReady();
}

function resetSimulationState(): void {
  if (aeroTable === undefined) {
    throw new Error("Cannot reset simulation before the aerodynamic table is loaded.");
  }

  params = buildParameters(settings);
  controllerConfig = buildControllerConfig(params, settings);
  controllerState = createPitchControllerState(controllerConfig, controllerConfig.trimPitchRad);
  wind = createWindDisturbance(buildWindConfig(settings));
  windSample = getWindDisturbanceSample(wind);

  const initialAero = computeAerodynamicOutputs(
    aeroTable,
    {
      rotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec,
      pitchRad: controllerConfig.trimPitchRad,
      windSpeedMps: settings.meanWindSpeedMps,
    },
    {
      airDensityKgPerM3: params.airDensityKgPerM3,
      rotorRadiusM: params.rotorRadiusM,
    },
  );

  state = {
    timeS: 0,
    rotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec,
    rotorAzimuthRad: 0,
    platformPitchRad:
      (params.thrustToPitchMomentArmM * initialAero.thrustN) /
      params.platformPitchStiffnessNm,
    platformPitchRateRadPerSec: 0,
  };

  control = {
    collectivePitchRad: controllerConfig.trimPitchRad,
    generatorTorqueNm: controllerConfig.generatorTorqueNm,
  };

  controllerDiagnostics = undefined;
  workerTickCount = 0;
  invalidateBandwidthEstimate();
}

function updateSettings(partialSettings: Partial<SimulationUiSettings>): void {
  settings = sanitiseSettings({ ...settings, ...partialSettings });
  params = buildParameters(settings);
  controllerConfig = buildControllerConfig(params, settings);
  invalidateBandwidthEstimate();

  if (state !== undefined) {
    wind = createWindDisturbance(buildWindConfig(settings));
    wind.state.timeSec = state.timeS;
    windSample = getWindDisturbanceSample(wind);
  }
}

function startLoop(): void {
  if (isRunning) {
    return;
  }

  isRunning = true;
  status = "running";
  postStatus("running");
  timerId = self.setInterval(runWorkerTick, WORKER_TICK_MS);
}

function stopLoop(): void {
  if (timerId !== undefined) {
    self.clearInterval(timerId);
    timerId = undefined;
  }

  isRunning = false;
}

function runWorkerTick(): void {
  try {
    for (let iStep = 0; iStep < settings.stepsPerWorkerTick; iStep += 1) {
      stepOnce();
    }

    workerTickCount += 1;

    if (workerTickCount % UI_SAMPLE_POST_EVERY_N_TICKS === 0) {
      postCurrentSample();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status = "error";
    stopLoop();
    postMessageToMain({ type: "error", message, isRunning });
  }
}

function stepOnce(): void {
  if (
    aeroTable === undefined ||
    state === undefined ||
    wind === undefined ||
    controllerState === undefined
  ) {
    throw new Error("Simulation worker was stepped before it was initialised.");
  }

  const controllerResult = stepPitchController(
    controllerState,
    {
      rotorSpeedRadPerSec: state.rotorSpeedRadPerSec,
      platformPitchRateRadPerSec: state.platformPitchRateRadPerSec,
    },
    controllerConfig,
    settings.dtS,
  );

  controllerState = controllerResult.state;
  control = controllerResult.control;
  controllerDiagnostics = controllerResult.diagnostics;
  windSample = stepWindDisturbance(wind, settings.dtS);

  const snapshot = stepSimulation(
    state,
    windSample.environment,
    control,
    params,
    aeroTable,
    { dtS: settings.dtS },
  );

  state = snapshot.state;
}

function createSample(): SimulationScenarioSample {
  if (
    aeroTable === undefined ||
    state === undefined ||
    control === undefined ||
    windSample === undefined
  ) {
    throw new Error("Cannot create sample before the simulation state exists.");
  }

  const relativeWind = computeRelativeWind(state, windSample.environment, params);
  const aero = computeAerodynamicOutputs(
    aeroTable,
    {
      rotorSpeedRadPerSec: state.rotorSpeedRadPerSec,
      pitchRad: control.collectivePitchRad,
      windSpeedMps: relativeWind.effectiveWindSpeedMps,
    },
    {
      airDensityKgPerM3: params.airDensityKgPerM3,
      rotorRadiusM: params.rotorRadiusM,
    },
  );

  return {
    timeS: state.timeS,
    windSpeedMps: windSample.windSpeedMps,
    meanWindSpeedMps: windSample.meanWindSpeedMps,
    gustMps: windSample.gustMps,
    turbulentMps: windSample.turbulentMps,
    effectiveWindSpeedMps: relativeWind.effectiveWindSpeedMps,
    projectedWindSpeedMps: relativeWind.projectedWindSpeedMps,
    platformVelocityWindCorrectionMps: relativeWind.platformVelocityWindCorrectionMps,
    rotorTiltRad: relativeWind.rotorTiltRad,
    rotorNormalProjectionFactor: relativeWind.rotorNormalProjectionFactor,
    rotorSpeedRadPerSec: state.rotorSpeedRadPerSec,
    rotorAzimuthRad: state.rotorAzimuthRad,
    collectivePitchRad: control.collectivePitchRad,
    generatorTorqueNm: control.generatorTorqueNm,
    platformPitchRad: state.platformPitchRad,
    platformPitchRateRadPerSec: state.platformPitchRateRadPerSec,
    aerodynamicPowerW: aero.powerW,
    aerodynamicTorqueNm: aero.torqueNm,
    thrustN: aero.thrustN,
    cp: aero.cp,
    ct: aero.ct,
    wavePitchMomentNm: windSample.environment.wavePitchMomentNm,
    controllerDiagnostics,
  };
}

function postReady(): void {
  postMessageToMain({
    type: "ready",
    settings,
    sample: createSample(),
    controllerBandwidthEstimate: getControllerBandwidthEstimate(),
    isRunning,
  });
}

function postCurrentSample(): void {
  postMessageToMain({
    type: "sample",
    sample: createSample(),
    settings,
    controllerBandwidthEstimate: getControllerBandwidthEstimate(),
    isRunning,
  });
}

function postStatus(
  nextStatus: SimulationWorkerStatus,
  message?: string,
): void {
  status = nextStatus;
  postMessageToMain({
    type: "status",
    status,
    isRunning,
    message,
  });
}

function postMessageToMain(message: SimulationWorkerResponse): void {
  self.postMessage(message);
}

function getControllerBandwidthEstimate(): ControllerBandwidthEstimate {
  if (
    cachedControllerBandwidthEstimate !== undefined &&
    state !== undefined &&
    state.timeS - cachedControllerBandwidthTimeS < BANDWIDTH_ESTIMATE_UPDATE_INTERVAL_S
  ) {
    return cachedControllerBandwidthEstimate;
  }

  const estimate = computeControllerBandwidthEstimate();
  cachedControllerBandwidthEstimate = estimate;
  cachedControllerBandwidthTimeS = state?.timeS ?? 0;

  return estimate;
}

function invalidateBandwidthEstimate(): void {
  cachedControllerBandwidthEstimate = undefined;
  cachedControllerBandwidthTimeS = Number.NEGATIVE_INFINITY;
}

function computeControllerBandwidthEstimate(): ControllerBandwidthEstimate {
  if (aeroTable === undefined || state === undefined || control === undefined || windSample === undefined) {
    return invalidBandwidthEstimate("The simulation state is not initialised yet.");
  }

  const relativeWind = computeRelativeWind(state, windSample.environment, params);
  const operatingPoint = {
    rotorSpeedRadPerSec: state.rotorSpeedRadPerSec,
    pitchRad: control.collectivePitchRad,
    windSpeedMps: relativeWind.effectiveWindSpeedMps,
  };

  const omegaDelta = Math.max(0.0025, 0.005 * Math.max(1, operatingPoint.rotorSpeedRadPerSec));
  const pitchDelta = 0.1 * DEG_TO_RAD;

  const torqueAtOmegaPlus = computeAeroTorque(
    operatingPoint.rotorSpeedRadPerSec + omegaDelta,
    operatingPoint.pitchRad,
    operatingPoint.windSpeedMps,
  );
  const torqueAtOmegaMinus = computeAeroTorque(
    Math.max(0.01, operatingPoint.rotorSpeedRadPerSec - omegaDelta),
    operatingPoint.pitchRad,
    operatingPoint.windSpeedMps,
  );
  const torqueAtPitchPlus = computeAeroTorque(
    operatingPoint.rotorSpeedRadPerSec,
    operatingPoint.pitchRad + pitchDelta,
    operatingPoint.windSpeedMps,
  );
  const torqueAtPitchMinus = computeAeroTorque(
    operatingPoint.rotorSpeedRadPerSec,
    operatingPoint.pitchRad - pitchDelta,
    operatingPoint.windSpeedMps,
  );

  const actualOmegaDelta =
    Math.max(0.01, operatingPoint.rotorSpeedRadPerSec + omegaDelta) -
    Math.max(0.01, operatingPoint.rotorSpeedRadPerSec - omegaDelta);
  const torqueSpeedSlopeNmPerRadPerSec =
    (torqueAtOmegaPlus - torqueAtOmegaMinus) / actualOmegaDelta;
  const torquePitchSlopeNmPerRad =
    (torqueAtPitchPlus - torqueAtPitchMinus) / (2 * pitchDelta);

  const plantSpeedSlopePerSec = torqueSpeedSlopeNmPerRadPerSec / params.rotorInertiaKgM2;
  const plantPitchGainRadPerSec2PerRad = torquePitchSlopeNmPerRad / params.rotorInertiaKgM2;
  const plantPoleRadPerSec = -plantSpeedSlopePerSec;

  if (Math.abs(plantPitchGainRadPerSec2PerRad) < 1e-9) {
    return {
      crossoverRadPerSec: undefined,
      crossoverHz: undefined,
      plantPoleRadPerSec,
      plantPitchGainRadPerSec2PerRad,
      plantSpeedSlopePerSec,
      valid: false,
      message: "Pitch-to-speed gain is too small at this operating point.",
    };
  }

  if (settings.pitchKp <= 0 && settings.pitchKi <= 0) {
    return {
      crossoverRadPerSec: undefined,
      crossoverHz: undefined,
      plantPoleRadPerSec,
      plantPitchGainRadPerSec2PerRad,
      plantSpeedSlopePerSec,
      valid: false,
      message: "The PI gains are zero, so no crossover is defined.",
    };
  }

  const crossoverRadPerSec = findOpenLoopCrossoverRadPerSec({
    plantSpeedSlopePerSec,
    plantPitchGainRadPerSec2PerRad,
    pitchKp: settings.pitchKp,
    pitchKi: settings.pitchKi,
  });

  if (crossoverRadPerSec === undefined) {
    return {
      crossoverRadPerSec: undefined,
      crossoverHz: undefined,
      plantPoleRadPerSec,
      plantPitchGainRadPerSec2PerRad,
      plantSpeedSlopePerSec,
      valid: false,
      message: "No unity-gain crossover was found in the scanned frequency range.",
    };
  }

  return {
    crossoverRadPerSec,
    crossoverHz: crossoverRadPerSec / (2 * Math.PI),
    plantPoleRadPerSec,
    plantPitchGainRadPerSec2PerRad,
    plantSpeedSlopePerSec,
    valid: true,
    message: "Estimated from the current one-state rotor-speed linearisation.",
  };
}

function computeAeroTorque(
  rotorSpeedRadPerSec: number,
  pitchRad: number,
  windSpeedMps: number,
): number {
  if (aeroTable === undefined) {
    throw new Error("Cannot compute aerodynamic torque before the aerodynamic table is loaded.");
  }

  return computeAerodynamicOutputs(
    aeroTable,
    {
      rotorSpeedRadPerSec,
      pitchRad,
      windSpeedMps,
    },
    {
      airDensityKgPerM3: params.airDensityKgPerM3,
      rotorRadiusM: params.rotorRadiusM,
    },
  ).torqueNm;
}

interface OpenLoopCrossoverInput {
  plantSpeedSlopePerSec: number;
  plantPitchGainRadPerSec2PerRad: number;
  pitchKp: number;
  pitchKi: number;
}

function findOpenLoopCrossoverRadPerSec(
  input: OpenLoopCrossoverInput,
): number | undefined {
  let previousFrequency = MIN_BANDWIDTH_SCAN_RAD_PER_SEC;
  let previousLogMagnitude = Math.log10(getOpenLoopMagnitude(previousFrequency, input));

  if (!Number.isFinite(previousLogMagnitude)) {
    return undefined;
  }

  for (let i = 1; i < BANDWIDTH_SCAN_POINTS; i += 1) {
    const alpha = i / (BANDWIDTH_SCAN_POINTS - 1);
    const frequency =
      MIN_BANDWIDTH_SCAN_RAD_PER_SEC *
      (MAX_BANDWIDTH_SCAN_RAD_PER_SEC / MIN_BANDWIDTH_SCAN_RAD_PER_SEC) ** alpha;
    const logMagnitude = Math.log10(getOpenLoopMagnitude(frequency, input));

    if (!Number.isFinite(logMagnitude)) {
      previousFrequency = frequency;
      previousLogMagnitude = logMagnitude;
      continue;
    }

    if (previousLogMagnitude === 0) {
      return previousFrequency;
    }

    if (previousLogMagnitude * logMagnitude <= 0) {
      const previousLogFrequency = Math.log(previousFrequency);
      const currentLogFrequency = Math.log(frequency);
      const fraction = previousLogMagnitude / (previousLogMagnitude - logMagnitude);
      return Math.exp(previousLogFrequency + fraction * (currentLogFrequency - previousLogFrequency));
    }

    previousFrequency = frequency;
    previousLogMagnitude = logMagnitude;
  }

  return undefined;
}

function getOpenLoopMagnitude(
  frequencyRadPerSec: number,
  input: OpenLoopCrossoverInput,
): number {
  const controllerMagnitude = Math.hypot(
    input.pitchKp,
    input.pitchKi / frequencyRadPerSec,
  );
  const plantMagnitude =
    Math.abs(input.plantPitchGainRadPerSec2PerRad) /
    Math.hypot(frequencyRadPerSec, input.plantSpeedSlopePerSec);

  return controllerMagnitude * plantMagnitude;
}

function invalidBandwidthEstimate(message: string): ControllerBandwidthEstimate {
  return {
    crossoverRadPerSec: undefined,
    crossoverHz: undefined,
    plantPoleRadPerSec: 0,
    plantPitchGainRadPerSec2PerRad: 0,
    plantSpeedSlopePerSec: 0,
    valid: false,
    message,
  };
}

function buildParameters(nextSettings: SimulationUiSettings): TunableParameters {
  const minPitchRad = nextSettings.minPitchDeg * DEG_TO_RAD;
  const maxPitchRad = Math.max(minPitchRad, nextSettings.maxPitchDeg * DEG_TO_RAD);
  const initialCollectivePitchRad = nextSettings.initialCollectivePitchDeg * DEG_TO_RAD;
  const trimPitchRad = Math.min(
    maxPitchRad,
    Math.max(minPitchRad, initialCollectivePitchRad),
  );

  return {
    ...DEFAULT_TUNABLE_PARAMETERS,
    trimPitchRad,
    minPitchRad,
    maxPitchRad,
    maxPitchRateRadPerSec: nextSettings.maxPitchRateDegPerSec * DEG_TO_RAD,
    speedControllerKp: nextSettings.pitchKp,
    speedControllerKi: nextSettings.pitchKi,
  };
}

function buildControllerConfig(
  nextParams: TunableParameters,
  nextSettings: SimulationUiSettings,
): PitchControllerConfig {
  return {
    ...createPitchControllerConfig(nextParams),
    floatingFeedbackEnabled: nextSettings.floatingFeedbackEnabled,
    platformPitchRateGainS: nextSettings.platformPitchRateGainS,
  };
}

function buildWindConfig(nextSettings: SimulationUiSettings): WindDisturbanceConfig {
  const baseClamp = {
    minWindSpeedMps: DEMO_WIND_SPEED_MIN_MPS,
    maxWindSpeedMps: DEMO_WIND_SPEED_MAX_MPS,
  };

  switch (nextSettings.windMode) {
    case "constant":
      return {
        ...baseClamp,
        mode: "constant",
        meanWindSpeedMps: nextSettings.meanWindSpeedMps,
      };
    case "gust":
      return {
        ...baseClamp,
        mode: "gust",
        meanWindSpeedMps: nextSettings.meanWindSpeedMps,
        gustAmplitudeMps: nextSettings.gustAmplitudeMps,
        gustStartTimeSec: nextSettings.gustStartTimeS,
        gustDurationSec: nextSettings.gustDurationS,
      };
    case "random":
      return {
        ...baseClamp,
        mode: "turbulent",
        meanWindSpeedMps: nextSettings.meanWindSpeedMps,
        turbulenceIntensity: nextSettings.turbulenceIntensity,
        lowPassTimeConstantSec: 2.5,
        seed: 12345,
      };
  }
}

function sanitiseSettings(nextSettings: SimulationUiSettings): SimulationUiSettings {
  const minPitchDeg = clampFinite(nextSettings.minPitchDeg, -5, 35);
  const maxPitchDeg = Math.max(minPitchDeg, clampFinite(nextSettings.maxPitchDeg, -5, 35));

  return {
    dtS: clampFinite(nextSettings.dtS, 0.005, 0.1),
    stepsPerWorkerTick: Math.round(clampFinite(nextSettings.stepsPerWorkerTick, 1, 20)),
    windMode: nextSettings.windMode,
    meanWindSpeedMps: clampFinite(
      nextSettings.meanWindSpeedMps,
      DEMO_WIND_SPEED_MIN_MPS,
      DEMO_WIND_SPEED_MAX_MPS,
    ),
    turbulenceIntensity: clampFinite(nextSettings.turbulenceIntensity, 0, 0.25),
    gustAmplitudeMps: clampFinite(nextSettings.gustAmplitudeMps, 0, 10),
    gustStartTimeS: clampFinite(nextSettings.gustStartTimeS, 0, 120),
    gustDurationS: clampFinite(nextSettings.gustDurationS, 0.5, 120),
    pitchKp: clampFinite(nextSettings.pitchKp, 0.1, 2),
    pitchKi: clampFinite(nextSettings.pitchKi, 0, 0.2),
    initialCollectivePitchDeg: clampFinite(nextSettings.initialCollectivePitchDeg, minPitchDeg, maxPitchDeg),
    minPitchDeg,
    maxPitchDeg,
    maxPitchRateDegPerSec: clampFinite(nextSettings.maxPitchRateDegPerSec, 0.1, 20),
    floatingFeedbackEnabled: nextSettings.floatingFeedbackEnabled,
    platformPitchRateGainS: clampFinite(nextSettings.platformPitchRateGainS, 0, 20),
  };
}

function clampFinite(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export {};
