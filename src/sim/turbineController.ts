import {
  createPitchControllerState,
  retunePitchControllerState,
  stepPitchController,
  type PitchControllerConfig,
  type PitchControllerDiagnostics,
  type PitchControllerMeasurements,
  type PitchControllerState,
} from "./controller";
import type { ControlInputs } from "./inputs";
import type { ControllerWindSource } from "./windEstimator";
import { stepCoordinatedController, type CoordinatedControllerConfig, type CoordinatedControllerState } from "./coordinatedController";
import { belowRatedPitchDemand, stepBelowRatedPitch, type BelowRatedPitchConfig } from "./belowRatedPitch";
import {
  createTorqueControllerState,
  stepTorqueController,
  type TorqueControllerConfig,
  type TorqueControllerState,
  type TorqueControllerDiagnostics,
} from "./torqueController";

// Keep the above-rated pitch PI available as the reference strategy. Torque
// remains constant and rotor-side [N m]; positive torque opposes rotor rotation.
export interface LegacyTurbineControllerConfig {
  strategy: "legacy-above-rated";
  pitch: PitchControllerConfig;
}

export interface LegacyTurbineControllerState {
  strategy: "legacy-above-rated";
  pitch: PitchControllerState;
}

export interface BelowRatedTurbineControllerConfig {
  strategy: "below-rated-tsr-pi";
  torque: TorqueControllerConfig;
  pitch: BelowRatedPitchConfig;
}

export interface BelowRatedTurbineControllerState {
  strategy: "below-rated-tsr-pi";
  torque: TorqueControllerState;
  previousPitchRad: number;
}

export type TurbineControllerConfig = LegacyTurbineControllerConfig | BelowRatedTurbineControllerConfig | CoordinatedControllerConfig;
export type TurbineControllerState = LegacyTurbineControllerState | BelowRatedTurbineControllerState | CoordinatedControllerState;
export interface TurbineControllerMeasurements extends PitchControllerMeasurements {
  controlWindMps?: number;
  windInputSource?: ControllerWindSource;
}

// Retain the existing pitch diagnostics so current consumers remain compatible.
// This strategy tag identifies the control law, not the actual operating region.
export interface LegacyTurbineControllerDiagnostics extends PitchControllerDiagnostics {
  strategy: "legacy-above-rated";
  pitchSpeedRefRadPerSec: number;
}

export type TurbineControllerDiagnostics = ReturnType<typeof stepCoordinatedController>["diagnostics"] | LegacyTurbineControllerDiagnostics | {
  strategy: "below-rated-tsr-pi";
  torque: TorqueControllerDiagnostics;
  pitch: ReturnType<typeof stepBelowRatedPitch>["diagnostics"];
};

export interface TurbineControllerStepResult {
  state: TurbineControllerState;
  control: ControlInputs;
  diagnostics: TurbineControllerDiagnostics;
}

export function createLegacyTurbineControllerConfig(
  pitch: PitchControllerConfig,
): LegacyTurbineControllerConfig {
  return { strategy: "legacy-above-rated", pitch };
}

interface InitialControllerOptions {
  initialPitchRad?: number;
  pitchState?: PitchControllerState;
  initialWindMps?: number;
  initialRotorSpeedRadPerSec?: number;
  initialTorqueNm?: number;
}

export function createTurbineControllerState(
  config: LegacyTurbineControllerConfig, options?: InitialControllerOptions,
): LegacyTurbineControllerState;
export function createTurbineControllerState(
  config: BelowRatedTurbineControllerConfig, options: InitialControllerOptions,
): BelowRatedTurbineControllerState;
export function createTurbineControllerState(
  config: LegacyTurbineControllerConfig | BelowRatedTurbineControllerConfig,
  options: InitialControllerOptions = {},
): TurbineControllerState {
  if (config.strategy === "below-rated-tsr-pi") {
    if (options.initialWindMps === undefined || options.initialRotorSpeedRadPerSec === undefined ||
      options.initialTorqueNm === undefined) {
      throw new Error("Below-rated initialization requires wind, rotor speed, and torque.");
    }
    return {
      strategy: config.strategy,
      previousPitchRad: belowRatedPitchDemand(options.initialWindMps, config.pitch).targetPitchRad,
      torque: createTorqueControllerState(config.torque,
        options.initialWindMps, options.initialRotorSpeedRadPerSec, options.initialTorqueNm),
    };
  }
  return {
    strategy: config.strategy,
    // An explicit state preserves offline restart/regression scenarios. Without
    // one, retain legacy zero-integral initialization; preload via retune below.
    pitch: options.pitchState ?? createPitchControllerState(config.pitch, options.initialPitchRad),
  };
}

export function retuneTurbineControllerState(
  state: LegacyTurbineControllerState,
  rotorSpeedRadPerSec: number,
  config: LegacyTurbineControllerConfig,
): LegacyTurbineControllerState {
  return {
    ...state,
    pitch: retunePitchControllerState(state.pitch, rotorSpeedRadPerSec, config.pitch),
  };
}

/** Advance control once using pre-physics speeds [rad/s], wind [m/s], and dt [s].
 * The caller then advances wind and physics, preserving the legacy step order.
 * Pitch limiting, anti-windup, filtering, and gain-transfer logic stay in the
 * existing pitch controller; neither caller implements a second control law.
 */
export function stepTurbineController(
  state: LegacyTurbineControllerState, measurements: TurbineControllerMeasurements,
  config: LegacyTurbineControllerConfig, dtS: number,
): TurbineControllerStepResult & {
  state: LegacyTurbineControllerState; diagnostics: LegacyTurbineControllerDiagnostics;
};
export function stepTurbineController(
  state: TurbineControllerState, measurements: TurbineControllerMeasurements,
  config: TurbineControllerConfig, dtS: number,
): TurbineControllerStepResult;
export function stepTurbineController(
  state: TurbineControllerState,
  measurements: TurbineControllerMeasurements,
  config: TurbineControllerConfig,
  dtS: number,
): TurbineControllerStepResult {
  if (config.strategy === "coordinated-tsr-pi" && state.strategy === "coordinated-tsr-pi") {
    if (measurements.controlWindMps === undefined) throw new Error("Coordinated control requires a selected wind signal.");
    return stepCoordinatedController(state, { ...measurements, controlWindMps: measurements.controlWindMps }, config, dtS);
  }
  if (config.strategy === "below-rated-tsr-pi" && state.strategy === "below-rated-tsr-pi") {
    if (measurements.controlWindMps === undefined) {
      throw new Error("Below-rated control requires a selected wind signal.");
    }
    const result = stepTorqueController(state.torque, {
      rotorSpeedRadPerSec: measurements.rotorSpeedRadPerSec,
      controlWindMps: measurements.controlWindMps,
      windInputSource: measurements.windInputSource,
    }, config.torque, dtS);
    // Share the torque loop's filtered selected wind for scheduled pitch.
    // This isolated development mode has no above-rated pitch PI.
    const pitch = stepBelowRatedPitch(state.previousPitchRad, result.state.filteredWindMps, config.pitch, dtS);
    return {
      state: { strategy: config.strategy, torque: result.state, previousPitchRad: pitch.pitchRad },
      control: { collectivePitchRad: pitch.pitchRad, generatorTorqueNm: result.torqueNm },
      diagnostics: { strategy: config.strategy, torque: result.diagnostics, pitch: pitch.diagnostics },
    };
  }
  if (config.strategy !== "legacy-above-rated" || state.strategy !== "legacy-above-rated") {
    throw new Error("Controller state and strategy do not match.");
  }
  const result = stepPitchController(state.pitch, measurements, config.pitch, dtS);
  return {
    state: { strategy: config.strategy, pitch: result.state },
    control: result.control,
    diagnostics: {
      ...result.diagnostics,
      strategy: config.strategy,
      pitchSpeedRefRadPerSec: config.pitch.rotorSpeedRefRadPerSec,
    },
  };
}
