import type { AeroPerformanceTable } from "./aero";
import { computeAerodynamicOutputs } from "./aero";
import type { ControlInputs, EnvironmentInputs } from "./inputs";
import type { SimulationOutputSnapshot } from "./outputs";
import type { TunableParameters } from "./params";
import type { TurbineState } from "./state";

export interface SimulationStepOptions {
  dtS: number;
}

export interface RelativeWindComputation {
  freeStreamWindSpeedMps: number;
  rotorTiltRad: number;
  rotorNormalProjectionFactor: number;
  projectedWindSpeedMps: number;
  platformVelocityWindCorrectionMps: number;
  effectiveWindSpeedMps: number;
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number. Received ${value}.`);
  }
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite. Received ${value}.`);
  }
}

function wrapAngleRad(angleRad: number): number {
  const twoPi = 2 * Math.PI;
  return ((angleRad % twoPi) + twoPi) % twoPi;
}

export function computeRelativeWind(
  state: TurbineState,
  environment: EnvironmentInputs,
  params: TunableParameters,
): RelativeWindComputation {
  assertFinite("state.platformPitchRad", state.platformPitchRad);
  assertFinite("state.platformPitchRateRadPerSec", state.platformPitchRateRadPerSec);
  assertFinite("environment.windSpeedMps", environment.windSpeedMps);
  assertFinite("shaftTiltRad", params.shaftTiltRad);
  assertFinite(
    "pitchToWindCouplingMpsPerRadPerSec",
    params.pitchToWindCouplingMpsPerRadPerSec,
  );

  const freeStreamWindSpeedMps = Math.max(0, environment.windSpeedMps);

  const rotorTiltRad = params.shaftTiltRad + state.platformPitchRad;

  const rotorNormalProjectionFactor = Math.max(0, Math.cos(rotorTiltRad));

  const projectedWindSpeedMps =
    freeStreamWindSpeedMps * rotorNormalProjectionFactor;

  const platformVelocityWindCorrectionMps =
    params.pitchToWindCouplingMpsPerRadPerSec *
    state.platformPitchRateRadPerSec;

  const effectiveWindSpeedMps = Math.max(
    0,
    projectedWindSpeedMps - platformVelocityWindCorrectionMps,
  );

  return {
    freeStreamWindSpeedMps,
    rotorTiltRad,
    rotorNormalProjectionFactor,
    projectedWindSpeedMps,
    platformVelocityWindCorrectionMps,
    effectiveWindSpeedMps,
  };
}

export function stepSimulation(
  state: TurbineState,
  environment: EnvironmentInputs,
  control: ControlInputs,
  params: TunableParameters,
  aeroTable: AeroPerformanceTable,
  options: SimulationStepOptions,
): SimulationOutputSnapshot {
  const { dtS } = options;

  assertPositiveFinite("dtS", dtS);
  assertPositiveFinite("rotorInertiaKgM2", params.rotorInertiaKgM2);
  assertPositiveFinite("platformPitchInertiaKgM2", params.platformPitchInertiaKgM2);

  assertFinite("state.rotorSpeedRadPerSec", state.rotorSpeedRadPerSec);
  assertFinite("state.platformPitchRad", state.platformPitchRad);
  assertFinite("state.platformPitchRateRadPerSec", state.platformPitchRateRadPerSec);
  assertFinite("environment.windSpeedMps", environment.windSpeedMps);
  assertFinite("environment.wavePitchMomentNm", environment.wavePitchMomentNm);
  assertFinite("control.collectivePitchRad", control.collectivePitchRad);
  assertFinite("control.generatorTorqueNm", control.generatorTorqueNm);

const relativeWind = computeRelativeWind(state, environment, params);

const aero = computeAerodynamicOutputs(
  aeroTable,
  {
    rotorSpeedRadPerSec: state.rotorSpeedRadPerSec,
    pitchRad: control.collectivePitchRad,
    windSpeedMps: relativeWind.effectiveWindSpeedMps,
  },
  {
    airDensityKgPerM3: params.airDensityKgPerM3,
    rotorRadiusM: params.rotorRadiusM,
  },
);

  const rotorAccelerationRadPerSec2 =
    (aero.torqueNm - control.generatorTorqueNm) / params.rotorInertiaKgM2;

  const nextRotorSpeedRadPerSec = Math.max(
    0,
    state.rotorSpeedRadPerSec + dtS * rotorAccelerationRadPerSec2,
  );

  const nextRotorAzimuthRad = wrapAngleRad(
    state.rotorAzimuthRad + dtS * nextRotorSpeedRadPerSec,
  );

  const aerodynamicPitchMomentNm =
    params.thrustToPitchMomentArmM * aero.thrustN;

  const wavePitchMomentNm =
    params.waveToPitchMomentGain * environment.wavePitchMomentNm;

  const platformPitchAccelerationRadPerSec2 =
    (
      aerodynamicPitchMomentNm +
      wavePitchMomentNm -
      params.platformPitchDampingNms * state.platformPitchRateRadPerSec -
      params.platformPitchStiffnessNm * state.platformPitchRad
    ) / params.platformPitchInertiaKgM2;

  const nextPlatformPitchRateRadPerSec =
    state.platformPitchRateRadPerSec +
    dtS * platformPitchAccelerationRadPerSec2;

  const nextPlatformPitchRad =
    state.platformPitchRad +
    dtS * nextPlatformPitchRateRadPerSec;

  const nextState: TurbineState = {
    timeS: state.timeS + dtS,
    rotorSpeedRadPerSec: nextRotorSpeedRadPerSec,
    rotorAzimuthRad: nextRotorAzimuthRad,
    platformPitchRad: nextPlatformPitchRad,
    platformPitchRateRadPerSec: nextPlatformPitchRateRadPerSec,
  };

  return {
    timeS: nextState.timeS,
    state: nextState,
    control,
    environment,
    outputs: {
      effectiveWindSpeedMps: relativeWind.effectiveWindSpeedMps,
      projectedWindSpeedMps: relativeWind.projectedWindSpeedMps,
      platformVelocityWindCorrectionMps:
        relativeWind.platformVelocityWindCorrectionMps,
      rotorTiltRad: relativeWind.rotorTiltRad,
      rotorNormalProjectionFactor: relativeWind.rotorNormalProjectionFactor,      aerodynamicPowerW: aero.powerW,
      aerodynamicTorqueNm: aero.torqueNm,
      thrustN: aero.thrustN,
      cp: aero.cp,
      ct: aero.ct,
    },
  };
}