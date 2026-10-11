import { computeAerodynamicOutputs, type AeroPerformanceTable } from "./aero";
import type { TunableParameters } from "./params";

/** Solve the generating (decreasing-torque) pitch branch, including static
 * platform deflection. Fail rather than silently use clamped aerodynamic data.
 */
export function solvePitchForTorque(table: AeroPerformanceTable, params: TunableParameters,
  windMps: number, rotorSpeedRadPerSec: number, torqueNm: number, minPitchRad: number, maxPitchRad: number) {
  let lo = minPitchRad;
  let hi = maxPitchRad;
  const evaluate = (pitch: number) => solveFixedPitchOperatingPoint(table, params, windMps, rotorSpeedRadPerSec, pitch);
  const lower = evaluate(lo);
  const upper = evaluate(hi);
  if (!Number.isFinite(torqueNm) || torqueNm <= 0 || lo >= hi || !lower.withinAeroTable || !upper.withinAeroTable ||
    lower.aero.torqueNm < torqueNm || upper.aero.torqueNm > torqueNm) {
    throw new Error("Cannot bracket generating pitch for requested torque within aerodynamic data.");
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (evaluate(mid).aero.torqueNm > torqueNm) lo = mid;
    else hi = mid;
  }
  const pitchRad = (lo + hi) / 2;
  const point = evaluate(pitchRad);
  if (!point.withinAeroTable || Math.abs(point.aero.torqueNm - torqueNm) > 1) throw new Error("Pitch/torque equilibrium did not converge.");
  return { ...point, pitchRad };
}

/** Static pitch balance at fixed wind, rotor speed, and blade pitch. This accounts
 * for rotor-normal wind projection; platform angular velocity is zero [rad/s].
 * It does not establish dynamic stability or guarantee generator feasibility.
 */
export function solveFixedPitchOperatingPoint(
  table: AeroPerformanceTable, params: TunableParameters,
  windSpeedMps: number, rotorSpeedRadPerSec: number, pitchRad: number,
) {
  if (![windSpeedMps, rotorSpeedRadPerSec, pitchRad].every(Number.isFinite) ||
    windSpeedMps < 0 || rotorSpeedRadPerSec <= 0 ||
    ![params.platformPitchStiffnessNm, params.thrustToPitchMomentArmM, params.shaftTiltRad].every(Number.isFinite) ||
    params.platformPitchStiffnessNm <= 0) {
    throw new Error("Invalid fixed-pitch operating point.");
  }
  const evaluate = (platformPitchRad: number) => {
    const effectiveWindSpeedMps = windSpeedMps * Math.max(0, Math.cos(params.shaftTiltRad + platformPitchRad));
    const aero = computeAerodynamicOutputs(table, { windSpeedMps: effectiveWindSpeedMps, rotorSpeedRadPerSec, pitchRad }, {
      airDensityKgPerM3: params.airDensityKgPerM3, rotorRadiusM: params.rotorRadiusM,
    });
    return { platformPitchRad, effectiveWindSpeedMps, aero,
      residual: params.platformPitchStiffnessNm * platformPitchRad - params.thrustToPitchMomentArmM * aero.thrustN };
  };
  let lo = -Math.PI / 2;
  let hi = Math.PI / 2;
  if (evaluate(lo).residual > 0 || evaluate(hi).residual < 0) throw new Error("Cannot bracket platform equilibrium.");
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (evaluate(mid).residual > 0) hi = mid;
    else lo = mid;
  }
  const result = evaluate((lo + hi) / 2);
  const withinAeroTable = rotorSpeedRadPerSec >= table.rotorSpeedRadPerSec[0] &&
    rotorSpeedRadPerSec <= table.rotorSpeedRadPerSec[table.nOmega - 1] &&
    pitchRad >= table.pitchRad[0] && pitchRad <= table.pitchRad[table.nPitch - 1] &&
    result.effectiveWindSpeedMps >= table.windSpeedMps[0] &&
    result.effectiveWindSpeedMps <= table.windSpeedMps[table.nWind - 1];
  return { ...result, withinAeroTable };
}
