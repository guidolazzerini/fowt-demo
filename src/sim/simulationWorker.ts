import { OperatingSupervisor } from "./operatingSupervisor";
/// <reference lib="webworker" />

import { computeAerodynamicOutputs, loadAeroTable, type AeroPerformanceTable } from "./aero";
import { createPitchControllerConfig } from "./controller";
import {
  createLegacyTurbineControllerConfig,
  createTurbineControllerState,
  retuneTurbineControllerState,
  stepTurbineController,
  type LegacyTurbineControllerConfig,
  type LegacyTurbineControllerState,
} from "./turbineController";
import type { TurbineControllerDiagnostics } from "./turbineController";
import { createCoordinatedControllerConfig, createCoordinatedScenario } from "./coordinated";
import { createCoordinatedControllerState, retuneCoordinatedControllerState, type CoordinatedControllerConfig, type CoordinatedControllerState } from "./coordinatedController";
import { createOperatingSequence, requestStartup, requestShutdown, stepOperatingSequence,
  sequenceAerodynamics, type OperatingSequence } from "./operatingSequence";
import { FEATHER_PITCH_RAD } from "./transientAerodynamics";
import { generatingWindBounds, windIsSupported, REENTRY_WIND_MARGIN_MPS, type BrowserOperation } from "./generatingEnvelope";
import { DEFAULT_TUNABLE_PARAMETERS } from "./defaults";
import { clampSetting, SETTING_RANGES, type NumericSetting } from "./settingRanges";
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
let controllerConfig: LegacyTurbineControllerConfig | CoordinatedControllerConfig = buildControllerConfig(params, settings);
let controllerState: LegacyTurbineControllerState | CoordinatedControllerState | undefined;
let wind: WindDisturbance | undefined;
let windSample: WindDisturbanceSample | undefined;
let state: TurbineState | undefined;
let control: ControlInputs | undefined;
let controllerDiagnostics: TurbineControllerDiagnostics | undefined;
let operatingSequence: OperatingSequence | undefined;
let operatingSupervisor = new OperatingSupervisor();
let boundaryTripped = false;
let unsupportedReason: string | undefined;
let limitsNeedReset = false;
let lastSupportedSample: SimulationScenarioSample | undefined;
let workerTickCount = 0;
let cachedControllerBandwidthEstimate: ControllerBandwidthEstimate | undefined;
let cachedControllerBandwidthTimeS = Number.NEGATIVE_INFINITY;

// Serialize async initialization/settings so rapid UI actions cannot race a Reset.
let requests = Promise.resolve();
self.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
  requests = requests.then(() => handleRequest(event.data));
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
      case "start-turbine":
      case "shutdown-turbine":
        await initialise();
        if (operatingSequence && getOperation().canStart && (request.type === "start-turbine" ?
          getOperation().canStartTurbine : getOperation().canShutDown)) {
          operatingSequence = request.type === "start-turbine" ? requestStartup(operatingSequence) :
            requestShutdown(operatingSequence);
          startLoop();
        }
        postCurrentSample();
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

  const nextWind = createWindDisturbance(buildWindConfig(settings));
  const nextWindSample = getWindDisturbanceSample(nextWind);
  const bounds = generatingWindBounds(settings.strategy, params.cutInWindSpeedMps, params.cutOutWindSpeedMps);
  wind = nextWind;
  windSample = nextWindSample;
  if (settings.startupShutdownEnabled && settings.strategy === "coordinated-tsr-pi") {
    params = buildParameters(settings);
    const nextConfig = buildControllerConfig(params, settings);
    if (nextConfig.strategy !== "coordinated-tsr-pi") throw new Error("Startup requires coordinated control.");
    controllerConfig = nextConfig;
    operatingSequence = createOperatingSequence();
    operatingSupervisor = new OperatingSupervisor();
    state = { timeS: 0, rotorAzimuthRad: 0, rotorSpeedRadPerSec: 0, platformPitchRad: 0, platformPitchRateRadPerSec: 0 };
    control = { collectivePitchRad: FEATHER_PITCH_RAD, generatorTorqueNm: 0 };
    controllerState = createCoordinatedControllerState(nextConfig, { windMps: windSample.windSpeedMps,
      rotorSpeedRadPerSec: 0, pitchRad: nextConfig.pitch.minPitchRad, torqueNm: 0 });
    finishReset();
    return;
  }
  if (!windIsSupported(windSample.windSpeedMps, bounds, boundaryTripped)) {
    tripUnsupported(`Reset needs wind within ${bounds.min + (boundaryTripped ? REENTRY_WIND_MARGIN_MPS : 0)}–${bounds.max - (boundaryTripped ? REENTRY_WIND_MARGIN_MPS : 0)} m/s.`);
    return;
  }
  const nextParams = buildParameters(settings);
  const nextConfig = buildControllerConfig(nextParams, settings);
  if (nextConfig.strategy === "coordinated-tsr-pi") {
    try {
      const { scenario } = createCoordinatedScenario({ name: "browser initialization", totalTimeS: 0, dtS: settings.dtS,
        wind: buildWindConfig(settings), params: nextParams, aeroTable, config: nextConfig });
      if (scenario.controller.mode !== "coordinated-tsr-pi") throw new Error("Incorrect initialization strategy.");
      params = nextParams;
      controllerConfig = nextConfig;
      controllerState = scenario.controller.initialControllerState;
      state = { timeS: 0, rotorAzimuthRad: 0, rotorSpeedRadPerSec: scenario.initialState!.rotorSpeedRadPerSec!,
        platformPitchRad: scenario.initialState!.platformPitchRad!, platformPitchRateRadPerSec: 0 };
      control = { collectivePitchRad: controllerState.pitch.previousPitchRad, generatorTorqueNm: controllerState.torque.previousTorqueNm };
      operatingSequence = undefined;
      finishReset();
    } catch (error) {
      unsupportedReason = `Cannot initialize generating operation with these limits: ${error instanceof Error ? error.message : String(error)}`;
    }
    return;
  }
  params = nextParams;
  controllerConfig = nextConfig;
  const initialPitchRad = settings.initialCollectivePitchDeg * DEG_TO_RAD;
  controllerState = retuneTurbineControllerState(
    createTurbineControllerState(controllerConfig, { initialPitchRad }),
    params.ratedRotorSpeedRadPerSec,
    controllerConfig,
  );
  wind = createWindDisturbance(buildWindConfig(settings));
  windSample = getWindDisturbanceSample(wind);

  const initialAero = computeAerodynamicOutputs(
    aeroTable,
    {
      rotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec,
      pitchRad: initialPitchRad,
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
    collectivePitchRad: initialPitchRad,
    generatorTorqueNm: controllerConfig.pitch.generatorTorqueNm,
  };

  operatingSequence = undefined;
  finishReset();
}

function finishReset(): void {
  boundaryTripped = false;
  unsupportedReason = undefined;
  limitsNeedReset = false;
  controllerDiagnostics = undefined;
  workerTickCount = 0;
  invalidateBandwidthEstimate();
  lastSupportedSample = createSample();
}

function updateSettings(partialSettings: Partial<SimulationUiSettings>): void {
  const previousSettings = settings;
  const nextSettings = sanitiseSettings({ ...settings, ...partialSettings });
  const limitsChanged = nextSettings.minPitchDeg !== settings.minPitchDeg || nextSettings.maxPitchDeg !== settings.maxPitchDeg ||
    nextSettings.maxPitchRateDegPerSec !== settings.maxPitchRateDegPerSec;
  // Coordinated actuator-limit edits require a fresh equilibrium. Legacy edits
  // keep the established live behavior used by the regression comparison.
  if (controllerConfig.strategy === "coordinated-tsr-pi" && limitsChanged) limitsNeedReset = true;
  settings = nextSettings;
  if (settings.strategy !== controllerConfig.strategy || limitsNeedReset ||
    settings.startupShutdownEnabled !== previousSettings.startupShutdownEnabled) stopLoop();
  if (!limitsNeedReset) {
    params = buildParameters(settings);
    controllerConfig = buildControllerConfig(params, { ...settings, strategy: controllerConfig.strategy });
  }
  invalidateBandwidthEstimate();

  if (
    state !== undefined && controllerState !== undefined &&
    (settings.pitchKp !== previousSettings.pitchKp || settings.pitchKi !== previousSettings.pitchKi) &&
    controllerState.strategy === "legacy-above-rated" && controllerConfig.strategy === "legacy-above-rated"
  ) {
    controllerState = retuneTurbineControllerState(
      controllerState, state.rotorSpeedRadPerSec, controllerConfig,
    );
  }

  if ((!operatingSequence || operatingSequence.phase === "generating") && !limitsNeedReset && state && controllerState?.strategy === "coordinated-tsr-pi" && controllerConfig.strategy === "coordinated-tsr-pi" &&
    (["pitchKp", "pitchKi", "torqueKpNmsPerRad", "torqueKiNmPerRad", "floatingFeedbackEnabled", "platformPitchRateGainS",
      "smoothingEnabled", "torqueReferenceShiftGain", "pitchReferenceShiftGain"] as const).some(key => settings[key] !== previousSettings[key])) {
    controllerState = retuneCoordinatedControllerState(controllerState, state.rotorSpeedRadPerSec, controllerConfig);
  }

  if (state !== undefined && haveActiveWindSettingsChanged(previousSettings, settings)) {
    if (!unsupportedReason) lastSupportedSample = createSample();
    wind = createWindDisturbance(buildWindConfig(settings));
    // Gust start remains an absolute simulation time. Evaluate it at the current
    // time without advancing the newly seeded random process.
    wind.state.timeSec = state.timeS;
    windSample = stepWindDisturbance(wind, 0);
    checkWindEnvelope();
  }
}

function haveActiveWindSettingsChanged(
  previous: SimulationUiSettings,
  next: SimulationUiSettings,
): boolean {
  if (previous.windMode !== next.windMode || previous.meanWindSpeedMps !== next.meanWindSpeedMps) {
    return true;
  }
  switch (next.windMode) {
    case "random":
      return previous.turbulenceIntensity !== next.turbulenceIntensity;
    case "gust":
      return (
        previous.gustAmplitudeMps !== next.gustAmplitudeMps ||
        previous.gustStartTimeS !== next.gustStartTimeS ||
        previous.gustDurationS !== next.gustDurationS
      );
    case "constant":
      return false;
  }
}

function startLoop(): void {
  if (isRunning) {
    return;
  }
  if (!getOperation().canStart) {
    postStatus("ready", getOperation().message);
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
      if (!isRunning) break;
    }

    workerTickCount += 1;

    if (!isRunning || workerTickCount % UI_SAMPLE_POST_EVERY_N_TICKS === 0) {
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

  if (operatingSequence && controllerConfig.strategy === "coordinated-tsr-pi" && controllerState.strategy === "coordinated-tsr-pi" && control) {
    windSample = stepWindDisturbance(wind, settings.dtS);
    const next = stepOperatingSequence({ supervisor: operatingSupervisor, sequence: operatingSequence, state, control, controllerState,
      config: controllerConfig, environment: windSample.environment, params, table: aeroTable, dtS: settings.dtS });
    operatingSequence = next.sequence;
    state = next.state;
    control = next.control;
    controllerState = next.controllerState;
    controllerDiagnostics = next.diagnostics;
    lastSupportedSample = createSample();
    return;
  }

  const controllerResult = stepTurbineController(
    controllerState,
    {
      rotorSpeedRadPerSec: state.rotorSpeedRadPerSec,
      platformPitchRateRadPerSec: state.platformPitchRateRadPerSec,
      simulatedFreeStreamWindMps: windSample!.windSpeedMps,
    },
    controllerConfig,
    settings.dtS,
  );

  if (controllerResult.state.strategy === "below-rated-tsr-pi") throw new Error("Isolated development mode is not a browser strategy.");
  lastSupportedSample = createSample();
  controllerState = controllerResult.state;
  control = controllerResult.control;
  controllerDiagnostics = controllerResult.diagnostics;
  windSample = stepWindDisturbance(wind, settings.dtS);
  if (!checkWindEnvelope()) return;
  const relative = computeRelativeWind(state, windSample.environment, params);
  if (state.rotorSpeedRadPerSec < aeroTable.rotorSpeedRadPerSec[0] || state.rotorSpeedRadPerSec > aeroTable.rotorSpeedRadPerSec[aeroTable.nOmega - 1] ||
    relative.effectiveWindSpeedMps < aeroTable.windSpeedMps[0] || relative.effectiveWindSpeedMps > aeroTable.windSpeedMps[aeroTable.nWind - 1]) {
    tripUnsupported("Rotor speed or rotor-effective wind left the aerodynamic table. Adjust settings and Reset; startup/shutdown are unsupported.");
    return;
  }

  const snapshot = stepSimulation(
    state,
    windSample.environment,
    control,
    params,
    aeroTable,
    { dtS: settings.dtS },
  );

  const nextRelative = computeRelativeWind(snapshot.state, windSample.environment, params);
  if (!Object.values(snapshot.state).every(Number.isFinite) ||
    snapshot.state.rotorSpeedRadPerSec < aeroTable.rotorSpeedRadPerSec[0] ||
    snapshot.state.rotorSpeedRadPerSec > aeroTable.rotorSpeedRadPerSec[aeroTable.nOmega - 1] ||
    nextRelative.effectiveWindSpeedMps < aeroTable.windSpeedMps[0] ||
    nextRelative.effectiveWindSpeedMps > aeroTable.windSpeedMps[aeroTable.nWind - 1]) {
    tripUnsupported("The next model state leaves the aerodynamic table. Frozen last valid state; change gains or wind and Reset. No startup/shutdown model.");
    return;
  }
  state = snapshot.state;
}

function createSample(): SimulationScenarioSample {
  if (unsupportedReason && lastSupportedSample && windSample) {
    // Hold model outputs at the last valid state; expose the triggering wind.
    return { ...lastSupportedSample, windSpeedMps: windSample.windSpeedMps,
      meanWindSpeedMps: windSample.meanWindSpeedMps, gustMps: windSample.gustMps, turbulentMps: windSample.turbulentMps };
  }
  if (
    aeroTable === undefined ||
    state === undefined ||
    control === undefined ||
    windSample === undefined
  ) {
    throw new Error("Cannot create sample before the simulation state exists.");
  }

  const relativeWind = computeRelativeWind(state, windSample.environment, params);
  const aero = operatingSequence ? sequenceAerodynamics(operatingSequence, state, control, windSample.environment, params, aeroTable) : computeAerodynamicOutputs(
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
    ...(operatingSequence ? { operatingSequence } : {}),
  };
}

function postReady(): void {
  postMessageToMain({
    type: "ready",
    settings,
    operation: getOperation(),
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
    operation: getOperation(),
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

function tripUnsupported(message: string): void {
  stopLoop();
  boundaryTripped = true;
  unsupportedReason = message;
}

function checkWindEnvelope(): boolean {
  if (settings.strategy !== controllerConfig.strategy) return true; // Pending Reset selects its own envelope.
  if (operatingSequence) return true; // Sequence supervisor owns averaged operating decisions.
  const bounds = generatingWindBounds(controllerConfig.strategy, params.cutInWindSpeedMps, params.cutOutWindSpeedMps);
  if (windSample && !windIsSupported(windSample.windSpeedMps, bounds)) {
    tripUnsupported(`Wind ${windSample.windSpeedMps.toFixed(2)} m/s is outside ${bounds.min}–${bounds.max} m/s. Frozen last valid model state; triggering wind is shown. Set wind within ${bounds.min + REENTRY_WIND_MARGIN_MPS}–${bounds.max - REENTRY_WIND_MARGIN_MPS} m/s and Reset. No startup or shutdown model.`);
    return false;
  }
  return !boundaryTripped;
}

function getOperation(): BrowserOperation {
  const activeStrategy = controllerConfig.strategy;
  const requiresReset = settings.strategy !== activeStrategy || limitsNeedReset || boundaryTripped || unsupportedReason !== undefined ||
    Boolean(operatingSequence) !== settings.startupShutdownEnabled;
  if (unsupportedReason) return { activeStrategy, region: "Unsupported operation", message: unsupportedReason, canStart: false, requiresReset: true };
  if (requiresReset) return { activeStrategy, region: "Reset required", message: "Strategy, initialization mode or coordinated pitch limits changed. Reset to initialize; gains are retained.", canStart: false, requiresReset };
  if (operatingSequence && operatingSequence.phase !== "generating") {
    const phaseNames = { waiting: "Waiting to start", parked: "Parked", starting: "Starting: free-wheel", loading: "Starting: load ramp", "shutting-down": "Shutting down" };
    return { activeStrategy, region: phaseNames[operatingSequence.phase], canStart: true, requiresReset: false,
      turbinePhase: operatingSequence.phase, canStartTurbine: operatingSequence.phase === "parked",
      canShutDown: operatingSequence.phase === "waiting" || operatingSequence.phase === "starting" || operatingSequence.phase === "loading",
      message: `${operatingSequence.reason}. 20 s torque supervision; simplified transient aerodynamics.` };
  }
  let region = "Legacy above-rated";
  if (activeStrategy === "coordinated-tsr-pi") {
    const diagnostic = controllerDiagnostics?.strategy === activeStrategy ? controllerDiagnostics : undefined;
    const pitchAboveFloor = diagnostic ? !diagnostic.pitchAtMinimum :
      controllerState?.strategy === activeStrategy && control!.collectivePitchRad > controllerState.minimumPitchRad + 1e-4;
    const torqueAtCap = control!.generatorTorqueNm >= controllerConfig.torque.maxTorqueNm * 0.99;
    region = pitchAboveFloor && torqueAtCap ? "Above rated" : pitchAboveFloor || torqueAtCap ? "Transition" : "Below rated";
  }
  return { activeStrategy, region, canStart: true, requiresReset: false,
    ...(operatingSequence ? { turbinePhase: operatingSequence.phase, canStartTurbine: false, canShutDown: true } : {}),
    message: activeStrategy === "coordinated-tsr-pi" ? "Generating model: 3–25 m/s. Minimum speed reference 5 rpm; transient dips are possible. Gains change only by user action." :
      "Legacy constant-torque mode: 10–20 m/s. Full-range initialization is available in Coordinated TSR PI mode." };
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
  if (controllerConfig.strategy === "coordinated-tsr-pi") {
    return invalidBandwidthEstimate("The legacy one-loop crossover estimate does not describe coordinated torque/pitch control.");
  }
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
  // The running bias is independent of the Reset-only initial pitch [rad].
  const trimPitchRad = Math.min(
    maxPitchRad,
    Math.max(minPitchRad, DEFAULT_TUNABLE_PARAMETERS.trimPitchRad),
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
): LegacyTurbineControllerConfig | CoordinatedControllerConfig {
  if (nextSettings.strategy === "coordinated-tsr-pi") {
    if (!aeroTable) throw new Error("Coordinated control requires the aerodynamic table.");
    // The cut-out normalization uses the reference operating point, independent
    // of student actuator-limit edits. Those limits still constrain the model.
    const config = createCoordinatedControllerConfig(DEFAULT_TUNABLE_PARAMETERS, aeroTable, {
      torqueKpNmsPerRad: nextSettings.torqueKpNmsPerRad, torqueKiNmPerRad: nextSettings.torqueKiNmPerRad,
      pitchKpS: nextSettings.pitchKp, pitchKi: nextSettings.pitchKi,
      floatingFeedbackEnabled: nextSettings.floatingFeedbackEnabled, platformPitchRateGainS: nextSettings.platformPitchRateGainS,
      torqueReferenceShiftGain: nextSettings.torqueReferenceShiftGain, pitchReferenceShiftGain: nextSettings.pitchReferenceShiftGain,
    });
    config.pitch = { ...config.pitch, minPitchRad: nextParams.minPitchRad, maxPitchRad: nextParams.maxPitchRad,
      maxPitchRateRadPerSec: nextParams.maxPitchRateRadPerSec, trimPitchRad: nextParams.minPitchRad };
    config.minimumPitch = { ...config.minimumPitch, minPitchRad: nextParams.minPitchRad, maxPitchRad: nextParams.maxPitchRad,
      maxPitchRateRadPerSec: nextParams.maxPitchRateRadPerSec };
    config.smoother.enabled = nextSettings.smoothingEnabled;
    return config;
  }
  return createLegacyTurbineControllerConfig({
    ...createPitchControllerConfig(nextParams),
    floatingFeedbackEnabled: nextSettings.floatingFeedbackEnabled,
    platformPitchRateGainS: nextSettings.platformPitchRateGainS,
  });
}

function buildWindConfig(nextSettings: SimulationUiSettings): WindDisturbanceConfig {
  switch (nextSettings.windMode) {
    case "constant":
      return {
        mode: "constant",
        meanWindSpeedMps: nextSettings.meanWindSpeedMps,
      };
    case "gust":
      return {
        mode: "gust",
        meanWindSpeedMps: nextSettings.meanWindSpeedMps,
        gustAmplitudeMps: nextSettings.gustAmplitudeMps,
        gustStartTimeSec: nextSettings.gustStartTimeS,
        gustDurationSec: nextSettings.gustDurationS,
      };
    case "random":
      return {
        mode: "turbulent",
        meanWindSpeedMps: nextSettings.meanWindSpeedMps,
        turbulenceIntensity: nextSettings.turbulenceIntensity,
        lowPassTimeConstantSec: 2.5,
        seed: 12345,
      };
  }
}

function sanitiseSettings(nextSettings: SimulationUiSettings): SimulationUiSettings {
  const bounded = { ...nextSettings };
  for (const key of Object.keys(SETTING_RANGES) as NumericSetting[]) {
    bounded[key] = clampSetting(key, nextSettings[key]);
  }
  const minPitchDeg = bounded.minPitchDeg;
  const maxPitchDeg = Math.max(minPitchDeg, bounded.maxPitchDeg);
  return { ...bounded,
    strategy: nextSettings.strategy === "coordinated-tsr-pi" ? nextSettings.strategy : "legacy-above-rated",
    smoothingEnabled: Boolean(nextSettings.smoothingEnabled),
    startupShutdownEnabled: nextSettings.strategy === "coordinated-tsr-pi" && Boolean(nextSettings.startupShutdownEnabled),
    stepsPerWorkerTick: Math.round(bounded.stepsPerWorkerTick),
    windMode: ["constant", "gust", "random"].includes(nextSettings.windMode) ? nextSettings.windMode : "constant",
    initialCollectivePitchDeg: Math.min(maxPitchDeg, Math.max(minPitchDeg, bounded.initialCollectivePitchDeg)),
    minPitchDeg,
    maxPitchDeg,
    floatingFeedbackEnabled: nextSettings.floatingFeedbackEnabled,
  };
}

export {};
