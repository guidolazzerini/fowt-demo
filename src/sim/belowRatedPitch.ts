/** Low-wind Cp-maximizing branch of the IEA 15 MW / UMaineSemi schedule.
 * Source: IEA-15-240-RWT v1.1.17, PS_WindSpeeds / PS_BldPitchMin:
 * https://github.com/IEAWindSystems/IEA-15-240-RWT/blob/v1.1.17/OpenFAST/IEA-15-240-RWT-UMaineSemi/IEA-15-240-RWT-UMaineSemi_DISCON.IN
 * Pairs are [wind m/s, collective pitch rad], copied at published precision.
 * Positive pitch is toward feather. The near-rated peak-shaving branch is NOT
 * included. This branch is calibrated for the reference turbine's 5 rpm floor.
 */
export const IEA15_LOW_WIND_PITCH: readonly (readonly [number, number])[] = [
  [3.0000, 0.0600], [3.2669, 0.0600], [3.5338, 0.0600],
  [3.8007, 0.0600], [4.0676, 0.0600], [4.3345, 0.0600],
  [4.6014, 0.0562], [4.8683, 0.0521], [5.1352, 0.0472],
  [5.4021, 0.0415], [5.6690, 0.0355], [5.9359, 0.0290],
  [6.2028, 0.0221], [6.4697, 0.0152], [6.7366, 0.0081],
  [7.0034, 0.0010], [7.2703, 0.0000],
];

export type BelowRatedPitchConfig = {
  minPitchRad: number;
  maxPitchRad: number;
  maxPitchRateRadPerSec: number;
} & ({ mode: "iea15-low-wind" } | { mode: "fixed"; fixedPitchRad: number });

/** Linear interpolation, endpoint-held outside the low-wind branch. Holding an
 * endpoint does not authorize generating below cut-in or above rated operation.
 */
export function iea15LowWindPitchRad(windMps: number): number {
  if (!Number.isFinite(windMps) || windMps < 0) throw new Error("Pitch schedule wind must be finite and nonnegative [m/s].");
  const knots = IEA15_LOW_WIND_PITCH;
  if (windMps <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [upperWind, upperPitch] = knots[i];
    if (windMps <= upperWind) {
      const [lowerWind, lowerPitch] = knots[i - 1];
      return lowerPitch + (upperPitch - lowerPitch) * (windMps - lowerWind) / (upperWind - lowerWind);
    }
  }
  return knots[knots.length - 1][1];
}

export function belowRatedPitchDemand(filteredWindMps: number, config: BelowRatedPitchConfig) {
  if (![config.minPitchRad, config.maxPitchRad, config.maxPitchRateRadPerSec].every(Number.isFinite) ||
    config.minPitchRad > config.maxPitchRad || config.maxPitchRateRadPerSec <= 0) {
    throw new Error("Invalid below-rated pitch limits [rad, rad/s].");
  }
  const scheduledPitchRad = config.mode === "fixed" ? config.fixedPitchRad : iea15LowWindPitchRad(filteredWindMps);
  if (!Number.isFinite(scheduledPitchRad)) throw new Error("Pitch demand must be finite [rad].");
  const targetPitchRad = Math.max(config.minPitchRad, Math.min(config.maxPitchRad, scheduledPitchRad));
  return { scheduledPitchRad, targetPitchRad, wasSaturated: targetPitchRad !== scheduledPitchRad };
}

export function stepBelowRatedPitch(previousPitchRad: number, filteredWindMps: number,
  config: BelowRatedPitchConfig, dtS: number) {
  const demand = belowRatedPitchDemand(filteredWindMps, config);
  if (!Number.isFinite(previousPitchRad) || previousPitchRad < config.minPitchRad || previousPitchRad > config.maxPitchRad ||
    !Number.isFinite(dtS) || dtS <= 0) throw new Error("Invalid pitch state or time step.");
  const maxChangeRad = config.maxPitchRateRadPerSec * dtS;
  const difference = demand.targetPitchRad - previousPitchRad;
  const pitchRad = previousPitchRad + Math.max(-maxChangeRad, Math.min(maxChangeRad, difference));
  return { pitchRad, diagnostics: { ...demand, wasRateLimited: Math.abs(difference) > maxChangeRad } };
}
