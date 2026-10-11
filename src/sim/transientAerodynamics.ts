import { computeAerodynamicOutputs, type AeroPerformanceTable } from "./aero";
import type { TunableParameters } from "./params";

export const FEATHER_PITCH_RAD = Math.PI / 2;
export const FEATHER_COAST_TIME_S = 20;

/** Educational extension for startup/stop/parked and temporary generating excursions outside the table. The supplied
 * table has no standstill or feather data; these are assumptions, not IEA data.
 * At <2 rpm retain 30% of the lowest-speed torque at rest, rising linearly to
 * the table value. Beyond 30 degrees smoothly blend to zero driving torque,
 * viscous aerodynamic braking -J*omega/20 s, and residual parked Ct=0.02.
 * Dynamic pressure uses the actual wind; only lookup coordinates are bounded.
 */
export function transientAerodynamics(table: AeroPerformanceTable, params: TunableParameters,
  omega: number, pitch: number, wind: number) {
  const minimumSpeed = table.rotorSpeedRadPerSec[0];
  const tablePitch = table.pitchRad[table.nPitch - 1];
  const lookupWind = Math.max(table.windSpeedMps[0], Math.min(table.windSpeedMps[table.nWind - 1], wind));
  const base = computeAerodynamicOutputs(table, {
    rotorSpeedRadPerSec: Math.max(minimumSpeed, omega), pitchRad: Math.min(tablePitch, pitch), windSpeedMps: lookupWind,
  }, { airDensityKgPerM3: params.airDensityKgPerM3, rotorRadiusM: params.rotorRadiusM });
  const pressureScale = (wind / lookupWind) ** 2;
  const lowSpeedScale = .3 + .7 * Math.min(1, Math.max(0, omega / minimumSpeed));
  const fraction = Math.max(0, Math.min(1, (pitch - tablePitch) / (FEATHER_PITCH_RAD - tablePitch)));
  const feather = fraction * fraction * (3 - 2 * fraction);
  const pressureArea = .5 * params.airDensityKgPerM3 * Math.PI * params.rotorRadiusM ** 2 * wind ** 2;
  const torqueNm = (1 - feather) * base.torqueNm * pressureScale * lowSpeedScale -
    feather * params.rotorInertiaKgM2 * omega / FEATHER_COAST_TIME_S;
  const thrustN = (1 - feather) * base.thrustN * pressureScale + feather * .02 * pressureArea;
  // Power must be zero at rest and negative during aerodynamic braking.
  const powerW = torqueNm * omega;
  return { ...base, torqueNm, thrustN, powerW,
    cp: pressureArea * wind > 0 ? powerW / (pressureArea * wind) : 0,
    cq: pressureArea > 0 ? torqueNm / (pressureArea * params.rotorRadiusM) : 0,
    ct: pressureArea > 0 ? thrustN / pressureArea : 0 };
}
