import { SUGGESTED_REFERENCE_GAINS, type FixedControllerGains } from "./suggestedGains";

/** Demo-specific pitch PI suggestions, with wind-dependent platform-rate
 * feedback inspired by Guo & Schlipf (2023), Table 4, MVFB (no lidar).
 * https://doi.org/10.5194/wes-8-1299-2023
 * Their 24 s near-rated feedback is capped at our existing 20 s limit. This
 * mixed schedule is NOT the ROSCO reference schedule or a reproduced optimum.
 * Positive platform pitch rate [rad/s] adds positive blade pitch [rad].
 */
export const DEMO_GAIN_SCHEDULE = [
  { windMps: 3, pitchKpS: .6, pitchKi: .015, floatingGainS: 0 },
  { windMps: 8, pitchKpS: .6, pitchKi: .015, floatingGainS: 0 },
  { windMps: 10, pitchKpS: .8, pitchKi: .02, floatingGainS: 20 },
  { windMps: 12, pitchKpS: .8, pitchKi: .02, floatingGainS: 20 },
  { windMps: 14, pitchKpS: .9333333333333333, pitchKi: .02666666666666667, floatingGainS: 12 },
  { windMps: 16, pitchKpS: 1.1666666666666667, pitchKi: .03666666666666667, floatingGainS: 12 },
  { windMps: 18, pitchKpS: 1.5, pitchKi: .05, floatingGainS: 10 },
  { windMps: 25, pitchKpS: 1.5, pitchKi: .05, floatingGainS: 10 },
] as const;

/** Piecewise-linear interpolation; clamp at endpoints, never extrapolate.
 * Use the SAME 5 s filtered selected wind as torque reference/pitch floor.
 * Torque gains remain the constant reference values throughout this schedule.
 */
export function suggestedGainsAtWind(windMps: number): FixedControllerGains {
  if (!Number.isFinite(windMps)) throw new Error("Gain scheduling requires finite filtered wind [m/s].");
  const wind = Math.max(3, Math.min(25, windMps));
  const upper = DEMO_GAIN_SCHEDULE.findIndex(row => row.windMps >= wind);
  const b = DEMO_GAIN_SCHEDULE[upper], a = DEMO_GAIN_SCHEDULE[Math.max(0, upper - 1)];
  const fraction = a === b ? 0 : (wind - a.windMps) / (b.windMps - a.windMps);
  const blend = (key: "pitchKpS" | "pitchKi" | "floatingGainS") => a[key] + fraction * (b[key] - a[key]);
  const platformPitchRateGainS = blend("floatingGainS");
  return { ...SUGGESTED_REFERENCE_GAINS, pitchKpS: blend("pitchKpS"), pitchKi: blend("pitchKi"),
    platformPitchRateGainS, floatingFeedbackEnabled: platformPitchRateGainS > 0 };
}
