import { getAeroCoefficients, type AeroPerformanceTable } from "./aero";
import type { TunableParameters } from "./params";

export type ControllerWindSource = "simulated-free-stream" | "coflex-estimate";

/** Causal selection: use the estimate from the last completed physics step.
 * A held/limited estimate stays selected; never silently substitute truth wind.
 * The existing controller filter and actuator limits handle live source changes.
 */
export function selectControllerWind(source: ControllerWindSource, simulatedWindMps: number,
  estimate: WindEstimatorState | undefined): number {
  const value = source === "coflex-estimate" ? estimate?.estimatedWindMps : simulatedWindMps;
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error("Selected controller wind is unavailable or invalid. Reset required.");
  }
  return value;
}

/** COFLEX, Lazzerini et al. (2025), Sect. 5.1, Eq. (10):
 * https://doi.org/10.5194/wes-10-1303-2025
 * J*d(omegaHat)/dt = rho*pi*R^2*Vhat^3*Cp(omega,Vhat,beta)/(2*omega) - Qg
 * Vhat = Kp*(omega-omegaHat) + Ki*integral(omega-omegaHat).
 * Qg is measured/applied rotor-side braking torque [N m]; Kg=1 because this
 * demonstrator has no drivetrain loss or gearbox conversion. No wind signal,
 * actual aerodynamic torque, or rotor acceleration is an estimator input.
 */
export interface WindEstimatorTuning {
  kpMPerRad: number; // [m/rad], converts speed error [rad/s] to wind [m/s].
  kiMPerRadSec: number; // [m/(rad s)], zero disables the integral contribution.
  initialWindMps: number; // Independent Reset guess [m/s], never simulator truth.
}
// Fixed demonstrator suggestions, not gains claimed from the paper.
export const DEFAULT_WIND_ESTIMATOR_TUNING: Readonly<WindEstimatorTuning> = {
  kpMPerRad: 100, kiMPerRadSec: 5, initialWindMps: 8,
};
export interface WindEstimatorConfig extends WindEstimatorTuning {
  inertiaKgM2: number;
  airDensityKgPerM3: number;
  rotorRadiusM: number;
}
export interface WindEstimatorState {
  estimatedRotorSpeedRadPerSec: number;
  previousMeasuredSpeedRadPerSec: number;
  integralWindMps: number;
  estimatedWindMps: number;
}
export interface WindEstimatorDiagnostics {
  estimatedWindMps: number;
  estimatedRotorSpeedRadPerSec: number;
  speedErrorRadPerSec: number;
  status: "tracking" | "limited" | "held";
  reason: string;
  integralHeld: boolean;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function validateGains(config: WindEstimatorTuning): void {
  if (!Number.isFinite(config.kpMPerRad) || config.kpMPerRad <= 0 ||
    !Number.isFinite(config.kiMPerRadSec) || config.kiMPerRadSec < 0) {
    throw new Error("Wind estimator requires Kp > 0 and Ki >= 0.");
  }
}

export function createWindEstimatorConfig(params: TunableParameters,
  tuning: WindEstimatorTuning = DEFAULT_WIND_ESTIMATOR_TUNING): WindEstimatorConfig {
  validateGains(tuning);
  return { ...tuning, inertiaKgM2: params.rotorInertiaKgM2,
    airDensityKgPerM3: params.airDensityKgPerM3, rotorRadiusM: params.rotorRadiusM };
}

export function createWindEstimatorState(rotorSpeedRadPerSec: number, config: WindEstimatorConfig,
  table: AeroPerformanceTable): WindEstimatorState {
  validateGains(config);
  const initialWind = clamp(config.initialWindMps, table.windSpeedMps[0], table.windSpeedMps[table.nWind - 1]);
  if (config.kiMPerRadSec === 0) {
    // Pure proportional output: Vhat = Kp*(omega-omegaHat), with no hidden bias.
    // Initialize the speed prediction error to represent the independent guess.
    return { estimatedRotorSpeedRadPerSec: rotorSpeedRadPerSec - initialWind / config.kpMPerRad,
      previousMeasuredSpeedRadPerSec: rotorSpeedRadPerSec, integralWindMps: 0, estimatedWindMps: initialWind };
  }
  return { estimatedRotorSpeedRadPerSec: rotorSpeedRadPerSec,
    previousMeasuredSpeedRadPerSec: rotorSpeedRadPerSec, integralWindMps: initialWind, estimatedWindMps: initialWind };
}

/** Preserve wind output on gain changes, including entering/leaving Ki=0.
 * With Ki=0, clear the integral and transfer its output into speed-observer
 * error [rad/s]. With Ki>0, match the integral contribution as before.
 */
export function retuneWindEstimator(state: WindEstimatorState, config: WindEstimatorConfig): WindEstimatorState {
  validateGains(config);
  if (config.kiMPerRadSec === 0) {
    return { ...state, integralWindMps: 0, estimatedRotorSpeedRadPerSec:
      state.previousMeasuredSpeedRadPerSec - state.estimatedWindMps / config.kpMPerRad };
  }
  return { ...state, integralWindMps: state.estimatedWindMps - config.kpMPerRad *
    (state.previousMeasuredSpeedRadPerSec - state.estimatedRotorSpeedRadPerSec) };
}

/** Call once AFTER a completed physics interval with its applied pitch/torque
 * and the newly measured speed. Predict over that interval using the previous
 * measured speed, then correct wind using the new speed error (first-order
 * discrete observer). Never read a wind/torque truth signal for correction.
 */
export function stepWindEstimator(state: WindEstimatorState, measurements: {
  rotorSpeedRadPerSec: number; pitchRad: number; generatorTorqueNm: number;
  generating: boolean;
}, config: WindEstimatorConfig, table: AeroPerformanceTable, dtS: number): {
  state: WindEstimatorState; diagnostics: WindEstimatorDiagnostics;
} {
  const { rotorSpeedRadPerSec: omega, pitchRad: beta, generatorTorqueNm: qg } = measurements;
  validateGains(config);
  if (!Object.values(state).every(Number.isFinite) || !Object.values(config).every(Number.isFinite) ||
    ![omega, beta, qg, dtS].every(Number.isFinite) || omega < 0 || qg < 0 || dtS <= 0 ||
    config.inertiaKgM2 <= 0 ||
    config.airDensityKgPerM3 <= 0 || config.rotorRadiusM <= 0) throw new Error("Invalid wind estimator input/configuration.");
  const inSpeedRange = (speed: number) => speed >= table.rotorSpeedRadPerSec[0] &&
    speed <= table.rotorSpeedRadPerSec[table.nOmega - 1];
  if (!measurements.generating || !inSpeedRange(omega) || !inSpeedRange(state.previousMeasuredSpeedRadPerSec) ||
    beta < table.pitchRad[0] || beta > table.pitchRad[table.nPitch - 1]) {
    // Cp/omega is unsupported at standstill/feather. Hold the last wind estimate
    // and recenter the speed observer. In proportional-only mode, preserve the
    // required speed error instead of introducing a frozen integral/bias.
    const error = config.kiMPerRadSec === 0 ? state.estimatedWindMps / config.kpMPerRad : 0;
    const next = { ...state, previousMeasuredSpeedRadPerSec: omega, estimatedRotorSpeedRadPerSec: omega - error,
      integralWindMps: config.kiMPerRadSec === 0 ? 0 : state.estimatedWindMps };
    return { state: next, diagnostics: { estimatedWindMps: next.estimatedWindMps,
      estimatedRotorSpeedRadPerSec: next.estimatedRotorSpeedRadPerSec, speedErrorRadPerSec: error, status: "held", integralHeld: true,
      reason: "Waiting for generating operation within the speed/pitch table" } };
  }
  const cp = getAeroCoefficients(table, { rotorSpeedRadPerSec: state.previousMeasuredSpeedRadPerSec,
    pitchRad: beta, windSpeedMps: state.estimatedWindMps }).cp;
  // Use Cp as specified in Eq. (10), not the plant's independently interpolated
  // Cq. Their interpolation mismatch can create a small, measurable bias.
  const predictedTorque = .5 * config.airDensityKgPerM3 * Math.PI * config.rotorRadiusM ** 2 *
    state.estimatedWindMps ** 3 * cp / state.previousMeasuredSpeedRadPerSec;
  const predictedSpeed = state.estimatedRotorSpeedRadPerSec + dtS * (predictedTorque - qg) / config.inertiaKgM2;
  const error = omega - predictedSpeed;
  const proportional = config.kpMPerRad * error;
  const candidateIntegral = config.kiMPerRadSec === 0 ? 0 : state.integralWindMps + dtS * config.kiMPerRadSec * error;
  const minimum = table.windSpeedMps[0], maximum = table.windSpeedMps[table.nWind - 1];
  const candidateWind = proportional + candidateIntegral;
  // Conditional integration prevents further windup at the table's wind bounds.
  const held = config.kiMPerRadSec > 0 && ((candidateWind < minimum && error < 0) || (candidateWind > maximum && error > 0));
  const integral = held ? state.integralWindMps : candidateIntegral;
  const demand = proportional + integral;
  const estimate = clamp(demand, minimum, maximum);
  const next = { estimatedRotorSpeedRadPerSec: predictedSpeed, previousMeasuredSpeedRadPerSec: omega,
    integralWindMps: integral, estimatedWindMps: estimate };
  const limited = held || demand <= minimum || demand >= maximum;
  return { state: next, diagnostics: { estimatedWindMps: estimate, estimatedRotorSpeedRadPerSec: predictedSpeed,
    speedErrorRadPerSec: error, status: limited ? "limited" : "tracking", integralHeld: held || config.kiMPerRadSec === 0,
    reason: limited ? "Wind estimate at aerodynamic-table bound" : "Observer updating" } };
}
