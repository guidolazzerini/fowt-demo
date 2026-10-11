/** Abbas et al. (2022), Section 5.2, Eqs. (48)-(49).
 * https://wes.copernicus.org/articles/7/53/2022/
 * All speeds are rotor-side [rad/s], torques [N m], and pitches [rad].
 */
export interface SetpointSmootherConfig {
  enabled: boolean;
  torqueReferenceShiftGain: number; // k_vs, dimensionless; paper default 1.
  pitchReferenceShiftGain: number; // k_pc, dimensionless; paper default 0.001.
  pitchAtCutOutRad: number; // beta_max: operating pitch at cut-out, NOT actuator limit.
}

export interface SetpointSmootherInputs {
  baseTorqueSpeedRefRadPerSec: number;
  ratedSpeedRadPerSec: number;
  pitchRad: number;
  minimumPitchRad: number;
  generatorTorqueNm: number;
  normalTorqueCapNm: number; // tau_g,max: constant-torque operating cap, NOT emergency ceiling.
}

export function smoothSetpoints(input: SetpointSmootherInputs, config: SetpointSmootherConfig) {
  if (!Object.values(input).every(Number.isFinite) ||
    ![config.torqueReferenceShiftGain, config.pitchReferenceShiftGain, config.pitchAtCutOutRad].every(Number.isFinite) ||
    input.ratedSpeedRadPerSec <= 0 || input.normalTorqueCapNm <= 0 || config.pitchAtCutOutRad <= 0 ||
    config.torqueReferenceShiftGain < 0 || config.pitchReferenceShiftGain < 0) {
    throw new Error("Invalid set-point smoother gains, measurements, or normalization.");
  }
  const normalizedPitch = (input.pitchRad - input.minimumPitchRad) / config.pitchAtCutOutRad;
  const normalizedTorqueHeadroom = (input.normalTorqueCapNm - input.generatorTorqueNm) / input.normalTorqueCapNm;
  const rawOffsetRadPerSec = (normalizedPitch * config.torqueReferenceShiftGain -
    normalizedTorqueHeadroom * config.pitchReferenceShiftGain) * input.ratedSpeedRadPerSec;
  const offsetRadPerSec = config.enabled ? rawOffsetRadPerSec : 0;
  // Do not re-clamp shifted references: that would undo the coordination.
  const torqueSpeedRefRadPerSec = input.baseTorqueSpeedRefRadPerSec - Math.max(0, offsetRadPerSec);
  const pitchSpeedRefRadPerSec = input.ratedSpeedRadPerSec - Math.min(0, offsetRadPerSec);
  return { normalizedPitch, normalizedTorqueHeadroom, rawOffsetRadPerSec, offsetRadPerSec,
    torqueSpeedRefRadPerSec, pitchSpeedRefRadPerSec };
}
