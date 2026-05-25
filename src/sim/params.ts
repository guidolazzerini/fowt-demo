export interface AeroPerformanceTable {
  // Grid axes
  rotorSpeedRadPerSec: number[];
  pitchRad: number[];
  windSpeedMps: number[];

  // Flattened 3D arrays in row-major order:
  // index = iOmega * (nPitch * nWind) + iPitch * nWind + iWind
  cp: number[];
  ct: number[];

  // Optional in v1
  cq?: number[];
}

export interface AeroTableConfig {
  source: "embedded-json";
  id: string;
  filePath: string;
}

export interface TunableParameters {
  name: string;

  // Aerodynamic data source
  aero: AeroTableConfig;

  // Physical constants
  airDensityKgPerM3: number;

  // Rotor / turbine
  rotorRadiusM: number;
  ratedPowerW: number;
  ratedRotorSpeedRadPerSec: number;
  cutInWindSpeedMps: number;
  ratedWindSpeedMps: number;
  cutOutWindSpeedMps: number;

  // Rotor dynamics
  rotorInertiaKgM2: number;

  // Geometry for rotor-relative wind calculation
  shaftTiltRad: number;

  // Platform dynamics
  platformPitchInertiaKgM2: number;
  platformPitchDampingNms: number;
  platformPitchStiffnessNm: number;

  // Coupling
  thrustToPitchMomentArmM: number;
  pitchToWindCouplingMpsPerRadPerSec: number;
  waveToPitchMomentGain: number;

  // Pitch actuator / limits
  trimPitchRad: number;
  minPitchRad: number;
  maxPitchRad: number;
  maxPitchRateRadPerSec: number;
  pitchActuatorTimeConstantS: number;

  // Generator / torque actuator
  ratedGeneratorTorqueNm: number;
  minGeneratorTorqueNm: number;
  maxGeneratorTorqueNm: number;
  generatorTorqueTimeConstantS: number;

  // Baseline controller
  rotorSpeedRefRadPerSec: number;
  speedControllerKp: number;
  speedControllerKi: number;
  enablePitchControllerAntiWindup: boolean;
  floatingFeedbackPitchRateLowPassCutoffHz: number;
}