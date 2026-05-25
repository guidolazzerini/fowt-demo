import { getPublicAssetPath } from "../app/paths";
import type { TunableParameters } from "./params";

const DEG_TO_RAD = Math.PI / 180;
const RPM_TO_RAD_PER_SEC = (2 * Math.PI) / 60;

const hubHeightM = 150;
const platformPitchAxisHeightM = 0;
const platformPitchLeverArmM = hubHeightM - platformPitchAxisHeightM;
const ratedRotorSpeedRadPerSec = 7.56 * RPM_TO_RAD_PER_SEC;
const ratedGeneratorTorqueNm = 15e6 / ratedRotorSpeedRadPerSec;
const trimPitchRad = 7.5 * DEG_TO_RAD;

export const DEMO_FLOATING_15MW: TunableParameters = {
  name: "Demo floating 15 MW",

  aero: {
    source: "embedded-json",
    id: "iea15mw-aero-v1",
    filePath: getPublicAssetPath("iea15mw-aero-v1.json")
  },
  airDensityKgPerM3: 1.225,

  rotorRadiusM: 120,
  ratedPowerW: 15e6,
  ratedRotorSpeedRadPerSec,

  cutInWindSpeedMps: 3,
  ratedWindSpeedMps: 11,
  cutOutWindSpeedMps: 25,

  rotorInertiaKgM2: 3.5e8,
  shaftTiltRad: 0 * DEG_TO_RAD,
  
  platformPitchInertiaKgM2: 8.0e10,
  platformPitchDampingNms: 1.5e9,
  platformPitchStiffnessNm: 4.0e9,

  thrustToPitchMomentArmM: platformPitchLeverArmM,
  pitchToWindCouplingMpsPerRadPerSec: platformPitchLeverArmM,
  waveToPitchMomentGain: 0.0,

  trimPitchRad,
  minPitchRad: 0,
  maxPitchRad: 30 * DEG_TO_RAD,
  maxPitchRateRadPerSec: 5 * DEG_TO_RAD,
  pitchActuatorTimeConstantS: 0,

  ratedGeneratorTorqueNm,
  minGeneratorTorqueNm: 0,
  maxGeneratorTorqueNm: 2.0e7,
  generatorTorqueTimeConstantS: 0.05,

  rotorSpeedRefRadPerSec: ratedRotorSpeedRadPerSec,
  speedControllerKp: 0.9,
  speedControllerKi: 0.01,
  enablePitchControllerAntiWindup: true,
  floatingFeedbackPitchRateLowPassCutoffHz: 0.2,
};

export const DEFAULT_TUNABLE_PARAMETERS = DEMO_FLOATING_15MW;