export interface EnvironmentInputs {
  windSpeedMps: number;

  // Start simple: represent wave forcing directly as a pitch moment.
  wavePitchMomentNm: number;
}

export interface ControlInputs {
  collectivePitchRad: number;

  // Keep this even if simplified later.
  generatorTorqueNm: number;
}