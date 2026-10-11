import type { TurbinePhase } from "./operatingSequence";
export type BrowserStrategy = "legacy-above-rated" | "coordinated-tsr-pi";
export interface BrowserOperation {
  activeStrategy: BrowserStrategy;
  region: string;
  message: string;
  canStart: boolean;
  requiresReset: boolean;
  turbinePhase?: TurbinePhase;
  canStartTurbine?: boolean;
  canShutDown?: boolean;
}

/** Wind [m/s]. A trip freezes the model; it does not simulate feathering or
 * startup. Re-entry needs an explicit Reset with a 0.2 m/s inward margin.
 */
export function generatingWindBounds(strategy: BrowserStrategy, cutInMps: number, cutOutMps: number) {
  return strategy === "coordinated-tsr-pi" ? { min: cutInMps, max: cutOutMps } : { min: 10, max: 20 };
}
export const REENTRY_WIND_MARGIN_MPS = 0.2;
export function windIsSupported(windMps: number, bounds: { min: number; max: number }, reentry = false): boolean {
  const margin = reentry ? REENTRY_WIND_MARGIN_MPS : 0;
  return Number.isFinite(windMps) && windMps >= bounds.min + margin && windMps <= bounds.max - margin;
}
