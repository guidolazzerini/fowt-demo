import type { SimulationUiSettings } from "./workerMessages";

export type NumericSetting = {
  [Key in keyof SimulationUiSettings]: SimulationUiSettings[Key] extends number ? Key : never
}[keyof SimulationUiSettings];

/** Single source for input bounds and worker validation, in stored SI units
 * except the explicitly named degree inputs. Steps are UI increments only;
 * numeric entries may retain finer precision. Initial pitch also obeys the
 * currently selected actuator bounds. These are not generating wind limits.
 */
export const SETTING_RANGES = {
  windEstimatorKp: { min: 0.01, max: 1000, step: 0.01 },
  windEstimatorKi: { min: 0, max: 100, step: 0.01 },
  windEstimatorInitialMps: { min: 2, max: 27, step: 0.1 },
  dtS: { min: 0.005, max: 0.1, step: 0.005 },
  stepsPerWorkerTick: { min: 1, max: 20, step: 1 },
  meanWindSpeedMps: { min: 0, max: 30, step: 0.1 },
  turbulenceIntensity: { min: 0, max: 0.25, step: 0.01 },
  gustAmplitudeMps: { min: -10, max: 10, step: 0.5 },
  gustStartTimeS: { min: 0, max: 120, step: 0.5 },
  gustDurationS: { min: 0.5, max: 900, step: 0.5 },
  pitchKp: { min: 0, max: 2, step: 0.05 },
  pitchKi: { min: 0, max: 0.2, step: 0.001 },
  torqueKpNmsPerRad: { min: 0, max: 200e6, step: 0.1e6 },
  torqueKiNmPerRad: { min: 0, max: 20e6, step: 0.01e6 },
  torqueReferenceShiftGain: { min: 0, max: 2, step: 0.01 },
  pitchReferenceShiftGain: { min: 0, max: 0.1, step: 0.001 },
  initialCollectivePitchDeg: { min: 0, max: 30, step: 0.1 },
  minPitchDeg: { min: 0, max: 20, step: 0.1 },
  maxPitchDeg: { min: 5, max: 30, step: 0.1 },
  maxPitchRateDegPerSec: { min: 0.1, max: 20, step: 0.1 },
  platformPitchRateGainS: { min: 0, max: 20, step: 0.5 },
} satisfies Record<NumericSetting, { min: number; max: number; step: number }>;

export function clampSetting(key: NumericSetting, value: number): number {
  const { min, max } = SETTING_RANGES[key];
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
