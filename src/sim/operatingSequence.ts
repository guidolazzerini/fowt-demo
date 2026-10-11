import { computeAerodynamicOutputs, type AeroPerformanceTable } from "./aero";
import type { ControllerWindSource } from "./windEstimator";
import { belowRatedPitchDemand } from "./belowRatedPitch";
import { createCoordinatedControllerState, retuneCoordinatedControllerState, type CoordinatedControllerConfig, type CoordinatedControllerState } from "./coordinatedController";
import type { ControlInputs, EnvironmentInputs } from "./inputs";
import { computeRelativeWind, stepSimulation } from "./model";
import type { TunableParameters } from "./params";
import type { TurbineState } from "./state";
import { filteredTorqueWind, torqueSpeedReference } from "./torqueController";
import { stepTurbineController, type TurbineControllerDiagnostics } from "./turbineController";
import { FEATHER_PITCH_RAD, transientAerodynamics } from "./transientAerodynamics";

import { OperatingSupervisor, TORQUE_WINDOW_S, START_TORQUE_NM, STOP_TORQUE_NM, type SupervisorDiagnostics } from "./operatingSupervisor";

export type TurbinePhase = "waiting" | "parked" | "starting" | "loading" | "generating" | "shutting-down";
export interface OperatingSequence {
  phase: TurbinePhase;
  elapsedS: number;
  qualifiedS: number;
  reason: string;
  mechanicalBrakeTorqueNm: number;
  supervisor?: SupervisorDiagnostics;
  approximateAerodynamics?: boolean;
}
export const LOADING_TIME_S = 20;
export const STARTUP_SPEED_CAPTURE_TIME_S = 10;
export const SHUTDOWN_PITCH_RATE_RAD_S = 2 * Math.PI / 180;
export const PARKING_SPEED_RAD_S = .2 * Math.PI / 30;
export const PARKING_BRAKE_NM = .5e6;
const STARTUP_TIMEOUT_S = 1200;
const approach = (current: number, target: number, increment: number) =>
  current + Math.max(-increment, Math.min(increment, target - current));

export function createOperatingSequence(): OperatingSequence {
  return { phase: "parked", elapsedS: 0, qualifiedS: 0, reason: "Parked after Reset", mechanicalBrakeTorqueNm: 0 };
}
export function requestStartup(sequence: OperatingSequence): OperatingSequence {
  if (sequence.phase !== "parked") return sequence;
  // Arm the request even in calm wind; the running supervisor qualifies it.
  return { ...sequence, phase: "waiting", elapsedS: 0, qualifiedS: 0, reason: "Waiting for 20 s torque assessment" };
}
export function requestShutdown(sequence: OperatingSequence, reason = "Manual shutdown"): OperatingSequence {
  if (sequence.phase === "parked" || sequence.phase === "shutting-down") return sequence;
  if (sequence.phase === "waiting") return { ...sequence, phase: "parked", elapsedS: 0, reason: "Startup cancelled" };
  return { ...sequence, phase: "shutting-down", elapsedS: 0, qualifiedS: 0, reason };
}

/** Coarse bounded torque search, using actual Cq rather than assuming that
 * ever-higher pitch means more torque. The standstill surrogate uses this same
 * 2 rpm boundary. Pitch commands remain rate-limited; this is not gain scheduling.
 */
export function startupPitchTarget(table: AeroPerformanceTable, params: TunableParameters,
  config: CoordinatedControllerConfig, omega: number, wind: number) {
  const floor = belowRatedPitchDemand(wind, config.minimumPitch).targetPitchRad;
  let bestPitch = floor;
  let bestTorque = -Infinity;
  for (let i = 0; i <= 15; i++) {
    const pitch = floor + (config.pitch.maxPitchRad - floor) * i / 15;
    const torque = transientAerodynamics(table, params, omega, pitch, wind).torqueNm;
    if (torque > bestTorque) { bestTorque = torque; bestPitch = pitch; }
  }
  return bestPitch;
}

export function sequenceAerodynamics(sequence: OperatingSequence, state: TurbineState, control: ControlInputs,
  environment: EnvironmentInputs, params: TunableParameters, table: AeroPerformanceTable) {
  const relative = computeRelativeWind(state, environment, params);
  const useApproximation = usesTransientAerodynamics(sequence, state, relative.effectiveWindSpeedMps, table);
  return useApproximation ? transientAerodynamics(table, params, state.rotorSpeedRadPerSec,
    control.collectivePitchRad, relative.effectiveWindSpeedMps) : computeAerodynamicOutputs(table, {
      rotorSpeedRadPerSec: state.rotorSpeedRadPerSec, pitchRad: control.collectivePitchRad,
      windSpeedMps: relative.effectiveWindSpeedMps,
    }, { airDensityKgPerM3: params.airDensityKgPerM3, rotorRadiusM: params.rotorRadiusM });
}

function usesTransientAerodynamics(sequence: OperatingSequence, state: TurbineState, wind: number, table: AeroPerformanceTable) {
  // Ride through short resource dips without clamping physical wind to the table.
  return sequence.phase !== "generating" || state.rotorSpeedRadPerSec < table.rotorSpeedRadPerSec[0] ||
    wind < table.windSpeedMps[0] || wind > table.windSpeedMps[table.nWind - 1];
}

/** Shared browser/offline sequence step. Start/Stop of the simulation clock is
 * deliberately separate from physical startup/shutdown. Defaults are teaching
 * assumptions, not certified IEA shutdown rates or an emergency-stop design.
 */
export function stepOperatingSequence(input: {
  supervisor: OperatingSupervisor; sequence: OperatingSequence; state: TurbineState; control: ControlInputs;
  controllerState: CoordinatedControllerState; config: CoordinatedControllerConfig;
  environment: EnvironmentInputs; params: TunableParameters; table: AeroPerformanceTable; dtS: number;
  generatingWindMps?: number; // Selected input affects generating control only.
  windInputSource?: ControllerWindSource;
}) {
  const { state, config, environment, params, table, dtS } = input;
  if (!(dtS > 0) || !Number.isFinite(dtS) || !Object.values(state).every(Number.isFinite) ||
    !Number.isFinite(environment.windSpeedMps) || environment.windSpeedMps < 0) throw new Error("Invalid operating-sequence state or timestep.");
  let sequence = { ...input.sequence, elapsedS: input.sequence.elapsedS + dtS, mechanicalBrakeTorqueNm: 0 };
  let control = { ...input.control };
  let controllerState = input.controllerState;
  let diagnostics: TurbineControllerDiagnostics | undefined;
  const wind = environment.windSpeedMps;
  const relative = computeRelativeWind(state, environment, params);
  // Keep the normal 5 s free-stream filter alive through the sequence. Loading
  // must not chase instantaneous turbulent wind with an unfiltered speed target.
  if (sequence.phase !== "generating") controllerState = { ...controllerState, torque: { ...controllerState.torque,
    filteredWindMps: filteredTorqueWind(controllerState.torque.filteredWindMps, wind, config.torque.windFilterTimeConstantS, dtS) } };
  // This deliberately modest surrogate is limited to 0–30 m/s and the table's
  // maximum speed; beyond that stop with an explicit model-validity error.
  if (wind > 30 || relative.effectiveWindSpeedMps > 30 || state.rotorSpeedRadPerSec > table.rotorSpeedRadPerSec[table.nOmega - 1]) {
    throw new Error("Startup/shutdown approximation exceeded 30 m/s or the aerodynamic maximum speed. Reset required.");
  }
  // Parked actual torque is zero. Startup instead assesses available rotor-side
  // torque at the minimum generating speed and scheduled pitch using simulated
  // rotor-effective wind. This is a model capability proxy, not a measurement.
  const capabilityPitch = belowRatedPitchDemand(relative.effectiveWindSpeedMps, config.minimumPitch).targetPitchRad;
  const availableTorque = Math.max(0, transientAerodynamics(table, params,
    config.torque.minimumRotorSpeedRadPerSec, capabilityPitch, relative.effectiveWindSpeedMps).torqueNm);
  const actualTorque = sequenceAerodynamics(sequence, state, control, environment, params, table).torqueNm;
  const supervisor = input.supervisor.step(actualTorque, availableTorque, sequence.phase === "generating",
    wind, params.cutOutWindSpeedMps, dtS);
  sequence.supervisor = supervisor;
  const fullWindow = supervisor.availableObservedS >= TORQUE_WINDOW_S - 1e-8;
  if (supervisor.stormBlocked && sequence.phase !== "waiting") sequence = requestShutdown(sequence, "Storm protection: 100 s filtered wind above cut-out");
  if (sequence.phase === "generating" && supervisor.generatingObservedS >= TORQUE_WINDOW_S - 1e-8 &&
    supervisor.aerodynamicTorqueMeanNm < STOP_TORQUE_NM) {
    sequence = requestShutdown(sequence, "Low aerodynamic torque: 20 s mean below 0.040 MN m");
  }
  if ((sequence.phase === "starting" || sequence.phase === "loading") && fullWindow &&
    supervisor.availableTorqueMeanNm < STOP_TORQUE_NM) {
    sequence = requestShutdown(sequence, "Insufficient available torque: 20 s mean below 0.040 MN m");
  }
  if (sequence.phase === "waiting") {
    if (fullWindow && supervisor.availableTorqueMeanNm >= START_TORQUE_NM && !supervisor.stormBlocked) {
      sequence = { ...sequence, phase: "starting", elapsedS: 0, reason: "Free-wheeling; generator unloaded" };
    } else sequence.reason = supervisor.stormBlocked ? "Waiting for filtered storm wind below 23 m/s" :
      `Waiting for available torque: ${(supervisor.availableTorqueMeanNm / 1e6).toFixed(3)} / 0.080 MN m (${supervisor.availableObservedS.toFixed(0)} / 20 s)`;
  }
  if (state.rotorSpeedRadPerSec > 1.2 * params.ratedRotorSpeedRadPerSec) {
    sequence = requestShutdown(sequence, "Overspeed above 120% rated");
  }
  if ((sequence.phase === "starting" || sequence.phase === "loading") && sequence.elapsedS > STARTUP_TIMEOUT_S) {
    sequence = requestShutdown(sequence, "Startup timed out; insufficient acceleration");
  }

  if (sequence.phase === "starting") {
    const target = startupPitchTarget(table, params, config, state.rotorSpeedRadPerSec, relative.effectiveWindSpeedMps);
    control.collectivePitchRad = approach(control.collectivePitchRad, target, config.pitch.maxPitchRateRadPerSec * dtS);
    control.generatorTorqueNm = 0;
    // Hand over near the minimum generating speed, not rated speed: waiting
    // until rated at high wind leaves too little margin for a gradual loading.
    const speedThreshold = .95 * config.torque.minimumRotorSpeedRadPerSec;
    sequence.qualifiedS = state.rotorSpeedRadPerSec >= speedThreshold ? sequence.qualifiedS + dtS : 0;
    if (sequence.qualifiedS >= .5 && control.collectivePitchRad <= config.pitch.maxPitchRad) {
      // Begin loading without a speed reset or instantaneous generator load.
      sequence = { ...sequence, phase: "loading", elapsedS: 0, qualifiedS: 0, reason: "Ramping generator load" };
    }
  } else if (sequence.phase === "loading") {
    const fraction = Math.min(1, sequence.elapsedS / LOADING_TIME_S);
    const filteredWind = controllerState.torque.filteredWindMps;
    const reference = torqueSpeedReference(filteredWind, config.torque);
    const floor = belowRatedPitchDemand(filteredWind, config.minimumPitch).targetPitchRad;
    const equilibriumTorque = Math.max(0, Math.min(config.torque.maxTorqueNm,
      transientAerodynamics(table, params, reference, floor, relative.effectiveWindSpeedMps).torqueNm));
    const loadTarget = equilibriumTorque * fraction ** 2 * (3 - 2 * fraction);
    control.generatorTorqueNm = approach(control.generatorTorqueNm, loadTarget, config.torque.maxTorqueRateNmPerSec * dtS);
    // Model-based speed capture during loading: Qa = Qg + J*(reference-speed)/tau.
    // Search the feather side of the torque peak, then bisect. The ordinary PI
    // gains are not changed or used until this temporary sequence hands over.
    const desiredTorque = control.generatorTorqueNm + params.rotorInertiaKgM2 *
      (reference - state.rotorSpeedRadPerSec) / STARTUP_SPEED_CAPTURE_TIME_S;
    let lowerPitch = startupPitchTarget(table, params, config, state.rotorSpeedRadPerSec, relative.effectiveWindSpeedMps);
    let upperPitch = FEATHER_PITCH_RAD;
    for (let i = 0; i < 18; i++) {
      const middle = (lowerPitch + upperPitch) / 2;
      if (transientAerodynamics(table, params, state.rotorSpeedRadPerSec, middle, relative.effectiveWindSpeedMps).torqueNm > desiredTorque) lowerPitch = middle;
      else upperPitch = middle;
    }
    control.collectivePitchRad = approach(control.collectivePitchRad, (lowerPitch + upperPitch) / 2,
      config.pitch.maxPitchRateRadPerSec * dtS);
    const settled = fraction === 1 && Math.abs(state.rotorSpeedRadPerSec - reference) < .01 * reference &&
      control.collectivePitchRad <= config.pitch.maxPitchRad && control.collectivePitchRad >= floor;
    sequence.qualifiedS = settled ? sequence.qualifiedS + dtS : 0;
    if (sequence.qualifiedS >= 2) {
      controllerState = createCoordinatedControllerState(config, { windMps: filteredWind,
        rotorSpeedRadPerSec: state.rotorSpeedRadPerSec, pitchRad: control.collectivePitchRad, torqueNm: control.generatorTorqueNm });
      // Initialize floating filtering to the current rate to avoid a false
      // filter transient on handover; the PI is retuned by its normal factory.
      controllerState.pitch.filteredPlatformPitchRateRadPerSec = state.platformPitchRateRadPerSec;
      controllerState = retuneCoordinatedControllerState(controllerState, state.rotorSpeedRadPerSec, config);
      sequence = { ...sequence, phase: "generating", elapsedS: 0, reason: "Generating" };
    }
  } else if (sequence.phase === "generating") {
    if (input.windInputSource === "coflex-estimate" && input.generatingWindMps === undefined) {
      throw new Error("Estimated-wind generating control requires an estimate; no simulated-wind fallback.");
    }
    const result = stepTurbineController(controllerState, { rotorSpeedRadPerSec: state.rotorSpeedRadPerSec,
      platformPitchRateRadPerSec: state.platformPitchRateRadPerSec,
      controlWindMps: input.generatingWindMps ?? wind, windInputSource: input.windInputSource }, config, dtS);
    if (result.state.strategy !== "coordinated-tsr-pi") throw new Error("Sequence requires coordinated control.");
    controllerState = result.state;
    control = result.control;
    diagnostics = result.diagnostics;
  } else if (sequence.phase === "shutting-down") {
    // Normal controlled shutdown: pitch to feather and slew generator torque
    // down. No grid-loss fault is modeled. Parking brake only below 0.2 rpm,
    // with blades >=85 degrees; never use it as a high-speed emergency brake.
    control.collectivePitchRad = approach(control.collectivePitchRad, FEATHER_PITCH_RAD,
      Math.min(SHUTDOWN_PITCH_RATE_RAD_S, config.pitch.maxPitchRateRadPerSec) * dtS);
    control.generatorTorqueNm = approach(control.generatorTorqueNm, 0, config.torque.maxTorqueRateNmPerSec * dtS);
    if (state.rotorSpeedRadPerSec <= PARKING_SPEED_RAD_S && control.collectivePitchRad >= 85 * Math.PI / 180) {
      sequence.mechanicalBrakeTorqueNm = PARKING_BRAKE_NM;
    }
  } else {
    control = { collectivePitchRad: FEATHER_PITCH_RAD, generatorTorqueNm: 0 };
  }

  sequence.approximateAerodynamics = usesTransientAerodynamics(sequence, state, relative.effectiveWindSpeedMps, table);
  const aero = sequenceAerodynamics(sequence, state, control, environment, params, table);
  // Limit the brake to torque needed to stop this step, preventing reversal or
  // reporting fictitious brake work after the rotor is already stationary.
  sequence.mechanicalBrakeTorqueNm = Math.min(sequence.mechanicalBrakeTorqueNm,
    Math.max(0, aero.torqueNm - control.generatorTorqueNm + params.rotorInertiaKgM2 * state.rotorSpeedRadPerSec / dtS));
  const snapshot = stepSimulation(state, environment, control, params, table,
    { dtS, aerodynamics: aero, mechanicalBrakeTorqueNm: sequence.mechanicalBrakeTorqueNm });
  if (!Object.values(snapshot.state).every(Number.isFinite)) throw new Error("Non-finite transient model state; Reset required.");
  if (sequence.phase === "shutting-down" && snapshot.state.rotorSpeedRadPerSec === 0 &&
    control.collectivePitchRad >= FEATHER_PITCH_RAD - 1e-10 && control.generatorTorqueNm === 0) {
    sequence = { ...sequence, phase: "parked", elapsedS: 0, reason: "Parked: " + sequence.reason };
  }
  return { sequence, state: snapshot.state, control, controllerState, diagnostics };
}
