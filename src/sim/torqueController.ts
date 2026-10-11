/** All torques are rotor-side [N m]. Positive generator torque brakes the rotor. */
export interface TorqueControllerConfig {
  targetTsr: number;
  rotorRadiusM: number;
  minimumRotorSpeedRadPerSec: number;
  ratedRotorSpeedRadPerSec: number;
  windFilterTimeConstantS: number;
  kpNmsPerRad: number;
  kiNmPerRad: number;
  minTorqueNm: number;
  maxTorqueNm: number;
  maxTorqueRateNmPerSec: number;
}

export interface TorqueControllerState {
  filteredWindMps: number;
  integralTorqueNm: number;
  previousTorqueNm: number;
}

export interface TorqueControllerDiagnostics {
  simulatedFreeStreamWindMps: number;
  filteredWindMps: number;
  speedRefRadPerSec: number;
  minimumSpeedActive: boolean;
  ratedSpeedActive: boolean;
  targetTsr: number;
  speedErrorRadPerSec: number;
  proportionalTorqueNm: number;
  integralTorqueNm: number;
  unsaturatedTorqueNm: number;
  wasSaturated: boolean;
  wasRateLimited: boolean;
  integralWasHeld: boolean;
}

export function torqueSpeedReference(windMps: number, config: TorqueControllerConfig): number {
  return clamp(config.targetTsr * windMps / config.rotorRadiusM,
    config.minimumRotorSpeedRadPerSec, config.ratedRotorSpeedRadPerSec);
}

/** Pure filter prediction lets the shared controller use the same wind sample
 * for pitch scheduling and torque control without advancing filter state twice.
 */
export function filteredTorqueWind(previousWindMps: number, windMps: number, timeConstantS: number, dtS: number): number {
  const alpha = timeConstantS === 0 ? 1 : -Math.expm1(-dtS / timeConstantS);
  return previousWindMps + alpha * (windMps - previousWindMps);
}

export function createTorqueControllerState(
  config: TorqueControllerConfig,
  windMps: number,
  rotorSpeedRadPerSec: number,
  initialTorqueNm: number,
  speedReferenceShiftRadPerSec = 0,
): TorqueControllerState {
  validateConfig(config);
  validateMeasurements(windMps, rotorSpeedRadPerSec);
  if (!Number.isFinite(initialTorqueNm)) throw new Error("Initial torque must be finite [N m].");
  const torque = clamp(initialTorqueNm, config.minTorqueNm, config.maxTorqueNm);
  if (!Number.isFinite(speedReferenceShiftRadPerSec)) throw new Error("Torque reference shift must be finite [rad/s].");
  const error = rotorSpeedRadPerSec - (torqueSpeedReference(windMps, config) + speedReferenceShiftRadPerSec);
  return {
    filteredWindMps: windMps,
    previousTorqueNm: torque,
    // Preload the PI to the specified actuator torque, including any speed error.
    integralTorqueNm: config.kiNmPerRad === 0 ? 0 : torque - config.kpNmsPerRad * error,
  };
}

export function stepTorqueController(
  state: TorqueControllerState,
  measurements: { rotorSpeedRadPerSec: number; simulatedFreeStreamWindMps: number },
  config: TorqueControllerConfig,
  dtS: number,
  speedReferenceShiftRadPerSec = 0,
): { state: TorqueControllerState; torqueNm: number; diagnostics: TorqueControllerDiagnostics } {
  validateConfig(config);
  validateMeasurements(measurements.simulatedFreeStreamWindMps, measurements.rotorSpeedRadPerSec);
  if (!Number.isFinite(dtS) || dtS <= 0) throw new Error("Torque controller dt must be positive [s].");
  if (!Object.values(state).every(Number.isFinite) || state.filteredWindMps < 0) {
    throw new Error("Invalid torque controller state.");
  }
  // Exact discrete first-order low pass of the simulated FREE-STREAM wind.
  // This is an available simulator signal, not an estimated or rotor-effective wind.
  if (!Number.isFinite(speedReferenceShiftRadPerSec)) throw new Error("Torque reference shift must be finite [rad/s].");
  const filteredWindMps = filteredTorqueWind(state.filteredWindMps,
    measurements.simulatedFreeStreamWindMps, config.windFilterTimeConstantS, dtS);
  const unconstrainedRef = config.targetTsr * filteredWindMps / config.rotorRadiusM;
  const speedRefRadPerSec = torqueSpeedReference(filteredWindMps, config) + speedReferenceShiftRadPerSec;
  // Overspeed => positive error => increased braking torque (opposite sign to
  // a PI written with reference-minus-measurement error).
  const error = measurements.rotorSpeedRadPerSec - speedRefRadPerSec;
  const proportional = config.kpNmsPerRad * error;
  const candidateIntegral = config.kiNmPerRad === 0 ? 0 :
    state.integralTorqueNm + config.kiNmPerRad * error * dtS;
  const previous = clamp(state.previousTorqueNm, config.minTorqueNm, config.maxTorqueNm);
  const maxChange = config.maxTorqueRateNmPerSec * dtS;
  const limit = (integral: number) => {
    const demand = proportional + integral;
    const bounded = clamp(demand, config.minTorqueNm, config.maxTorqueNm);
    const torque = previous + clamp(bounded - previous, -maxChange, maxChange);
    return { demand, torque, saturated: bounded !== demand, rateLimited: Math.abs(torque - bounded) > 1e-8 };
  };
  const candidate = limit(candidateIntegral);
  // Conditional integration: hold only when the error would push farther into
  // an amplitude or slew limit; allow integration to recover from a limit.
  const hold = config.kiNmPerRad !== 0 && (
    (error > 0 && candidate.demand >= config.maxTorqueNm) ||
    (error < 0 && candidate.demand <= config.minTorqueNm) ||
    (candidate.rateLimited && error * (candidate.demand - previous) > 0)
  );
  const integralTorqueNm = hold ? state.integralTorqueNm : candidateIntegral;
  const accepted = hold ? limit(integralTorqueNm) : candidate;
  return {
    state: { filteredWindMps, integralTorqueNm, previousTorqueNm: accepted.torque },
    torqueNm: accepted.torque,
    diagnostics: {
      simulatedFreeStreamWindMps: measurements.simulatedFreeStreamWindMps,
      filteredWindMps, speedRefRadPerSec,
      minimumSpeedActive: unconstrainedRef < config.minimumRotorSpeedRadPerSec,
      ratedSpeedActive: unconstrainedRef > config.ratedRotorSpeedRadPerSec,
      targetTsr: config.targetTsr, speedErrorRadPerSec: error,
      proportionalTorqueNm: proportional, integralTorqueNm,
      unsaturatedTorqueNm: accepted.demand,
      wasSaturated: accepted.saturated, wasRateLimited: accepted.rateLimited, integralWasHeld: hold,
    },
  };
}

function validateConfig(config: TorqueControllerConfig): void {
  if (!Object.values(config).every(Number.isFinite) || config.targetTsr <= 0 ||
    config.rotorRadiusM <= 0 || config.minimumRotorSpeedRadPerSec <= 0 ||
    config.ratedRotorSpeedRadPerSec < config.minimumRotorSpeedRadPerSec ||
    config.windFilterTimeConstantS < 0 || config.kpNmsPerRad < 0 || config.kiNmPerRad < 0 ||
    config.minTorqueNm < 0 || config.maxTorqueNm <= config.minTorqueNm || config.maxTorqueRateNmPerSec <= 0) {
    throw new Error("Invalid torque-controller gains, limits, or geometry.");
  }
}

function validateMeasurements(wind: number, speed: number): void {
  if (!Number.isFinite(wind) || wind < 0 || !Number.isFinite(speed) || speed < 0) {
    throw new Error("Torque control requires non-negative finite wind [m/s] and speed [rad/s].");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
