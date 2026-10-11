import type { CoordinatedControllerConfig } from "./coordinatedController";

/** Manually chosen constants for a user experiment. No wind lookup, runtime
 * interpolation, or automatic gain changes are performed by this module.
 */
export interface FixedControllerGains {
  torqueKpNmsPerRad: number; // Positive speed error increases braking torque.
  torqueKiNmPerRad: number;
  pitchKpS: number; // rad pitch / (rad/s speed error) = s.
  pitchKi: number; // rad pitch / rad integrated speed error, dimensionless.
  floatingFeedbackEnabled: boolean;
  platformPitchRateGainS: number; // rad pitch / (rad/s platform pitch rate) = s.
  torqueReferenceShiftGain: number; // k_vs, dimensionless.
  pitchReferenceShiftGain: number; // k_pc, dimensionless.
}

/** SUGGESTED conservative starting point for the current demo model. Gains stay
 * fixed at all winds. This is neither an optimum nor an operating restriction.
 */
export const SUGGESTED_REFERENCE_GAINS: Readonly<FixedControllerGains> = Object.freeze({
  torqueKpNmsPerRad: 50.4e6, torqueKiNmPerRad: 2.24e6,
  pitchKpS: 0.6, pitchKi: 0.015,
  floatingFeedbackEnabled: false, platformPitchRateGainS: 0,
  torqueReferenceShiftGain: 1, pitchReferenceShiftGain: 0.001,
});

export interface SuggestedGainExperiment {
  id: string;
  label: string;
  operatingWindMps: number; // Documentation/test condition only, NOT a switch threshold.
  gains: Readonly<FixedControllerGains>;
}

function suggestion(windMps: number, pitchKpS: number, pitchKi: number, feedbackS: number): SuggestedGainExperiment {
  return { id: `wind-${windMps}`, label: `SUGGESTED at ${windMps} m/s`, operatingWindMps: windMps,
    gains: Object.freeze({ ...SUGGESTED_REFERENCE_GAINS, pitchKpS, pitchKi,
      floatingFeedbackEnabled: feedbackS > 0, platformPitchRateGainS: feedbackS }) };
}

/** Advice at discrete tested points. Choosing a row is explicit; the selected
 * values remain fixed if wind moves to another point. Below rated, pitch PI is
 * normally at its scheduled floor, so pitch gains have little local authority.
 */
export const SUGGESTED_OPERATING_POINT_GAINS: readonly SuggestedGainExperiment[] = [
  suggestion(3, 0.6, 0.015, 0),
  suggestion(5, 0.6, 0.015, 0),
  suggestion(8, 0.6, 0.015, 0),
  suggestion(10.5, 0.8, 0.02, 10),
  suggestion(12, 0.8, 0.02, 10),
  suggestion(15, 1, 0.03, 10),
  suggestion(18, 1.5, 0.05, 10),
  suggestion(22, 1.5, 0.05, 10),
  suggestion(25, 1.5, 0.05, 10),
];

/** Explicit experiment setup; accepts arbitrary user gains, not just catalog
 * rows. Returns a fresh configuration and never touches running controller state.
 */
export function withFixedControllerGains(config: CoordinatedControllerConfig, gains: FixedControllerGains): CoordinatedControllerConfig {
  return { ...config,
    torque: { ...config.torque, kpNmsPerRad: gains.torqueKpNmsPerRad, kiNmPerRad: gains.torqueKiNmPerRad },
    pitch: { ...config.pitch, pitchKp: gains.pitchKpS, pitchKi: gains.pitchKi,
      floatingFeedbackEnabled: gains.floatingFeedbackEnabled, platformPitchRateGainS: gains.platformPitchRateGainS },
    smoother: { ...config.smoother, torqueReferenceShiftGain: gains.torqueReferenceShiftGain,
      pitchReferenceShiftGain: gains.pitchReferenceShiftGain } };
}
