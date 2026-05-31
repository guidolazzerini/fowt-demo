import type { SimulationScenarioSample } from "./simulation";

export type UiWindMode = "constant" | "gust" | "random";

export const DEMO_WIND_SPEED_MIN_MPS = 10;
export const DEMO_WIND_SPEED_MAX_MPS = 20;

export interface SimulationUiSettings {
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
  dtS: 0.02,
  stepsPerWorkerTick: 8,

  windMode: "constant",
  meanWindSpeedMps: 11,
  turbulenceIntensity: 0.06,
  gustAmplitudeMps: 2,
  gustStartTimeS: 30,
  gustDurationS: 5,

  pitchKp: 1.50,
  pitchKi: 0.05,
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
      sample: SimulationScenarioSample;
      controllerBandwidthEstimate: ControllerBandwidthEstimate;
      isRunning: boolean;
    }
  | {
      type: "sample";
      sample: SimulationScenarioSample;
      settings: SimulationUiSettings;
      controllerBandwidthEstimate: ControllerBandwidthEstimate;
      isRunning: boolean;
    }
  | { type: "error"; message: string; isRunning: boolean };
