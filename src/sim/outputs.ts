import type { ControlInputs, EnvironmentInputs } from "./inputs";
import type { TurbineState } from "./state";

export interface DerivedOutputs {
  effectiveWindSpeedMps: number;
  projectedWindSpeedMps: number;
  platformVelocityWindCorrectionMps: number;
  rotorTiltRad: number;
  rotorNormalProjectionFactor: number;

  aerodynamicPowerW: number;
  aerodynamicTorqueNm: number;
  thrustN: number;

  cp: number;
  ct: number;
}

export interface SimulationOutputSnapshot {
  timeS: number;
  state: TurbineState;
  control: ControlInputs;
  environment: EnvironmentInputs;
  outputs: DerivedOutputs;
}