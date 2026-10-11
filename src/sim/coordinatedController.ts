import { belowRatedPitchDemand, type BelowRatedPitchConfig } from "./belowRatedPitch";
import type { ControllerWindSource } from "./windEstimator";
import { createPitchControllerState, retunePitchControllerState, stepPitchController,
  type PitchControllerConfig, type PitchControllerMeasurements, type PitchControllerState } from "./controller";
import { smoothSetpoints, type SetpointSmootherConfig } from "./setpointSmoother";
import { createTorqueControllerState, filteredTorqueWind, stepTorqueController, torqueSpeedReference,
  type TorqueControllerConfig, type TorqueControllerState } from "./torqueController";

/** Both loops always run; no wind-threshold switching or automatic gain scheduling. */
export interface CoordinatedControllerConfig {
  strategy: "coordinated-tsr-pi";
  torque: TorqueControllerConfig; // maxTorqueNm is the normal operating cap.
  absoluteTorqueLimitNm: number; // Separate hardware ceiling; never a normalization.
  pitch: PitchControllerConfig;
  minimumPitch: BelowRatedPitchConfig;
  smoother: SetpointSmootherConfig;
}

export interface CoordinatedControllerState {
  strategy: "coordinated-tsr-pi";
  torque: TorqueControllerState;
  pitch: PitchControllerState;
  minimumPitchRad: number; // Floor used with the previous applied pitch command.
}

function validateConfig(config: CoordinatedControllerConfig): void {
  if (!Number.isFinite(config.absoluteTorqueLimitNm) || config.torque.maxTorqueNm > config.absoluteTorqueLimitNm ||
    config.pitch.minPitchRad !== config.minimumPitch.minPitchRad ||
    config.pitch.maxPitchRad !== config.minimumPitch.maxPitchRad ||
    config.pitch.maxPitchRateRadPerSec !== config.minimumPitch.maxPitchRateRadPerSec) {
    throw new Error("Inconsistent coordinated controller actuator limits.");
  }
}

function references(config: CoordinatedControllerConfig, windMps: number, pitchRad: number,
  minimumPitchRad: number, generatorTorqueNm: number) {
  const baseTorqueSpeedRefRadPerSec = torqueSpeedReference(windMps, config.torque);
  return { baseTorqueSpeedRefRadPerSec, ...smoothSetpoints({ baseTorqueSpeedRefRadPerSec,
    ratedSpeedRadPerSec: config.torque.ratedRotorSpeedRadPerSec, pitchRad, minimumPitchRad,
    generatorTorqueNm, normalTorqueCapNm: config.torque.maxTorqueNm }, config.smoother) };
}

/** Live manual tuning: match the currently applied commands using the new
 * gains/references. Keep wind and floating-filter state. Ki=0 clears its state;
 * actuator slew limits govern any unavoidable proportional-only adjustment.
 */
export function retuneCoordinatedControllerState(state: CoordinatedControllerState,
  rotorSpeedRadPerSec: number, config: CoordinatedControllerConfig): CoordinatedControllerState {
  const refs = references(config, state.torque.filteredWindMps, state.pitch.previousPitchRad,
    state.minimumPitchRad, state.torque.previousTorqueNm);
  const torque = createTorqueControllerState(config.torque, state.torque.filteredWindMps,
    rotorSpeedRadPerSec, state.torque.previousTorqueNm,
    refs.torqueSpeedRefRadPerSec - refs.baseTorqueSpeedRefRadPerSec);
  const pitch = retunePitchControllerState(state.pitch, rotorSpeedRadPerSec, { ...config.pitch,
    minPitchRad: state.minimumPitchRad, trimPitchRad: Math.max(state.minimumPitchRad, config.pitch.trimPitchRad),
    rotorSpeedRefRadPerSec: refs.pitchSpeedRefRadPerSec });
  return { ...state, torque, pitch };
}

export function createCoordinatedControllerState(config: CoordinatedControllerConfig, initial: {
  windMps: number; rotorSpeedRadPerSec: number; pitchRad: number; torqueNm: number;
}): CoordinatedControllerState {
  validateConfig(config);
  const minimumPitchRad = belowRatedPitchDemand(initial.windMps, config.minimumPitch).targetPitchRad;
  const pitchRad = Math.max(minimumPitchRad, Math.min(config.pitch.maxPitchRad, initial.pitchRad));
  const torqueNm = Math.max(config.torque.minTorqueNm, Math.min(config.torque.maxTorqueNm, initial.torqueNm));
  const refs = references(config, initial.windMps, pitchRad, minimumPitchRad, torqueNm);
  const pitchConfig = { ...config.pitch, minPitchRad: minimumPitchRad,
    trimPitchRad: Math.max(minimumPitchRad, config.pitch.trimPitchRad), rotorSpeedRefRadPerSec: refs.pitchSpeedRefRadPerSec };
  const initialPitchState = createPitchControllerState(pitchConfig, pitchRad);
  return { strategy: config.strategy, minimumPitchRad,
    torque: createTorqueControllerState(config.torque, initial.windMps, initial.rotorSpeedRadPerSec, torqueNm,
      refs.torqueSpeedRefRadPerSec - refs.baseTorqueSpeedRefRadPerSec),
    // Below rated, let the negative speed error saturate at minimum pitch with
    // zero integral; cancelling that error would leave a spurious positive trim
    // as wind rises. Above minimum pitch, preload the true generating trim.
    pitch: pitchRad <= minimumPitchRad + 1e-12 ? initialPitchState :
      retunePitchControllerState(initialPitchState, initial.rotorSpeedRadPerSec, pitchConfig) };
}

export function stepCoordinatedController(state: CoordinatedControllerState,
  measurements: PitchControllerMeasurements & { controlWindMps: number; windInputSource?: ControllerWindSource },
  config: CoordinatedControllerConfig, dtS: number) {
  validateConfig(config);
  const wind = filteredTorqueWind(state.torque.filteredWindMps, measurements.controlWindMps,
    config.torque.windFilterTimeConstantS, dtS);
  const scheduledMinimumPitchRad = belowRatedPitchDemand(wind, config.minimumPitch).targetPitchRad;
  // A rising scheduled floor must respect actuator slew too. Feed this reachable
  // bound to the existing PI so anti-windup sees the constraint actually applied.
  const minimumPitchRad = Math.min(scheduledMinimumPitchRad,
    state.pitch.previousPitchRad + config.pitch.maxPitchRateRadPerSec * dtS);
  // Previous applied torque/pitch and their associated floor avoid an algebraic
  // loop. Both PI states persist through every crossing and smoother toggle.
  const smoother = references(config, wind, state.pitch.previousPitchRad, state.minimumPitchRad, state.torque.previousTorqueNm);
  const torque = stepTorqueController(state.torque, measurements, config.torque, dtS,
    smoother.torqueSpeedRefRadPerSec - smoother.baseTorqueSpeedRefRadPerSec);
  const pitch = stepPitchController(state.pitch, measurements, { ...config.pitch,
    minPitchRad: minimumPitchRad, trimPitchRad: Math.max(minimumPitchRad, config.pitch.trimPitchRad),
    rotorSpeedRefRadPerSec: smoother.pitchSpeedRefRadPerSec }, dtS);
  const nextState: CoordinatedControllerState = { strategy: config.strategy, torque: torque.state, pitch: pitch.state, minimumPitchRad };
  return { state: nextState,
    control: { collectivePitchRad: pitch.control.collectivePitchRad, generatorTorqueNm: torque.torqueNm },
    diagnostics: { strategy: config.strategy, torque: torque.diagnostics, pitch: pitch.diagnostics,
      smoother, scheduledMinimumPitchRad, minimumPitchRad,
      torqueAtOperatingCap: torque.torqueNm >= config.torque.maxTorqueNm - 1e-6,
      pitchAtMinimum: pitch.control.collectivePitchRad <= minimumPitchRad + 1e-12 } };
}
