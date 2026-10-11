import { DEFAULT_WIND_ESTIMATOR_TUNING, type ControllerWindSource } from "./windEstimator";
import type { SimulationScenarioSample } from "./simulation";
import type { BrowserOperation, BrowserStrategy } from "./generatingEnvelope";
import { SETTING_RANGES } from "./settingRanges";

export type UiWindMode = "constant" | "gust" | "random";

// Input range permits deliberate boundary crossings; generating limits are separate.
export const DEMO_WIND_SPEED_MIN_MPS = SETTING_RANGES.meanWindSpeedMps.min;
export const DEMO_WIND_SPEED_MAX_MPS = SETTING_RANGES.meanWindSpeedMps.max;
export const TORQUE_KP_MAX = SETTING_RANGES.torqueKpNmsPerRad.max;
export const TORQUE_KI_MAX = SETTING_RANGES.torqueKiNmPerRad.max;

export interface SimulationUiSettings {
  strategy: BrowserStrategy;
  controllerWindSource: ControllerWindSource;
  gainSchedulingEnabled: boolean;
  windEstimatorKp: number; // m/rad
  windEstimatorKi: number; // m/(rad s)
  windEstimatorInitialMps: number; // Independent guess, applied on Reset.

  startupShutdownEnabled: boolean;
  smoothingEnabled: boolean;
  torqueKpNmsPerRad: number;
  torqueKiNmPerRad: number;
  torqueReferenceShiftGain: number;
  pitchReferenceShiftGain: number;
  dtS: number;
  stepsPerWorkerTick: number;

  windMode: UiWindMode;
  meanWindSpeedMps: number;
  turbulenceIntensity: number;
  gustAmplitudeMps: number;
  gustStartTimeS: number;
  gustDurationS: number;

  pitchKp: number;
  pitchKi: number;
  initialCollectivePitchDeg: number;
  minPitchDeg: number;
  maxPitchDeg: number;
  maxPitchRateDegPerSec: number;

  floatingFeedbackEnabled: boolean;
  platformPitchRateGainS: number;
}

export interface ControllerBandwidthEstimate {
  crossoverRadPerSec: number | undefined;
  crossoverHz: number | undefined;
  plantPoleRadPerSec: number;
  plantPitchGainRadPerSec2PerRad: number;
  plantSpeedSlopePerSec: number;
  valid: boolean;
  message: string;
}

export const DEFAULT_SIMULATION_UI_SETTINGS: SimulationUiSettings = {
  strategy: "coordinated-tsr-pi",
  gainSchedulingEnabled: false,
  controllerWindSource: "simulated-free-stream",
  windEstimatorKp: DEFAULT_WIND_ESTIMATOR_TUNING.kpMPerRad,
  windEstimatorKi: DEFAULT_WIND_ESTIMATOR_TUNING.kiMPerRadSec,
  windEstimatorInitialMps: DEFAULT_WIND_ESTIMATOR_TUNING.initialWindMps,
  startupShutdownEnabled: false,
  smoothingEnabled: true,
  torqueKpNmsPerRad: 50.4e6,
  torqueKiNmPerRad: 2.24e6,
  torqueReferenceShiftGain: 1,
  pitchReferenceShiftGain: 0.001,
  dtS: 0.02,
  stepsPerWorkerTick: 8,

  windMode: "constant",
  meanWindSpeedMps: 11,
  turbulenceIntensity: 0.06,
  gustAmplitudeMps: 2,
  gustStartTimeS: 30,
  gustDurationS: 5,

  pitchKp: 0.60,
  pitchKi: 0.015,
  initialCollectivePitchDeg: 4.10,
  minPitchDeg: 0,
  maxPitchDeg: 30,
  maxPitchRateDegPerSec: 5,

  floatingFeedbackEnabled: false,
  platformPitchRateGainS: 0,
};

export type SimulationWorkerStatus = "idle" | "loading" | "ready" | "running" | "error";

export type SimulationWorkerRequest =
  | { type: "initialise" }
  | { type: "start" }
  | { type: "stop" }
  | { type: "start-turbine" }
  | { type: "shutdown-turbine" }
  | { type: "reset" }
  | { type: "update-settings"; settings: Partial<SimulationUiSettings> };

export type SimulationWorkerResponse =
  | {
      type: "status";
      status: SimulationWorkerStatus;
      isRunning: boolean;
      message?: string;
    }
  | {
      type: "ready";
      settings: SimulationUiSettings;
      operation: BrowserOperation;
      sample: SimulationScenarioSample;
      controllerBandwidthEstimate: ControllerBandwidthEstimate;
      isRunning: boolean;
    }
  | {
      type: "sample";
      sample: SimulationScenarioSample;
      settings: SimulationUiSettings;
      operation: BrowserOperation;
      controllerBandwidthEstimate: ControllerBandwidthEstimate;
      isRunning: boolean;
    }
  | { type: "error"; message: string; isRunning: boolean };
