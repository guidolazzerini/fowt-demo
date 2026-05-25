import type { ControlInputs } from "./inputs";
import type { TunableParameters } from "./params";

export interface PitchControllerConfig {
  rotorSpeedRefRadPerSec: number;
  trimPitchRad: number;
  generatorTorqueNm: number;
  pitchKp: number;
  pitchKi: number;
  minPitchRad: number;
  maxPitchRad: number;
  maxPitchRateRadPerSec: number;
  enableAntiWindup: boolean;
  floatingFeedbackPitchRateLowPassCutoffHz: number;

  /**
   * Optional simplified floating-feedback loop.
   * Disabled by default to preserve the baseline Step 5 controller.
   */
  floatingFeedbackEnabled: boolean;

  /**
   * Gain from platform pitch angular velocity [rad/s] to blade pitch [rad].
   * Unit: seconds.
   */
  platformPitchRateGainS: number;
}

export interface PitchControllerMeasurements {
  rotorSpeedRadPerSec: number;
  platformPitchRateRadPerSec: number;
}

export interface PitchControllerState {
  timeS: number;
  integralErrorRad: number;
  previousPitchRad: number;
  filteredPlatformPitchRateRadPerSec: number;
}

export interface PitchControllerDiagnostics {
  rotorSpeedErrorRadPerSec: number;
  platformPitchRateRadPerSec: number;
  proportionalTermRad: number;
  integralTermRad: number;
  floatingPitchTermRad: number;
  unsaturatedPitchDemandRad: number;
  pitchBeforeSaturationRad: number;
  pitchAfterRateLimitRad: number;
  wasSaturated: boolean;
  wasRateLimited: boolean;
  integralWasHeld: boolean;
  filteredPlatformPitchRateRadPerSec: number;
}

export interface PitchControllerStepResult {
  state: PitchControllerState;
  control: ControlInputs;
  diagnostics: PitchControllerDiagnostics;
}

const LIMIT_TOLERANCE_RAD = 1e-12;

export function createPitchControllerConfig(
  params: TunableParameters,
): PitchControllerConfig {
  return {
    rotorSpeedRefRadPerSec: params.rotorSpeedRefRadPerSec,
    trimPitchRad: params.trimPitchRad,
    generatorTorqueNm: params.ratedGeneratorTorqueNm,
    pitchKp: params.speedControllerKp,
    pitchKi: params.speedControllerKi,
    minPitchRad: params.minPitchRad,
    maxPitchRad: params.maxPitchRad,
    maxPitchRateRadPerSec: params.maxPitchRateRadPerSec,
    enableAntiWindup: params.enablePitchControllerAntiWindup,
    floatingFeedbackEnabled: false,
    platformPitchRateGainS: 0,
    floatingFeedbackPitchRateLowPassCutoffHz: params.floatingFeedbackPitchRateLowPassCutoffHz,
  };
}

export function createPitchControllerState(
  config: PitchControllerConfig,
  initialPitchRad = config.trimPitchRad,
): PitchControllerState {
  validatePitchControllerConfig(config);

  return {
    timeS: 0,
    integralErrorRad: 0,
    previousPitchRad: clamp(
      initialPitchRad,
      config.minPitchRad,
      config.maxPitchRad,
    ),
    filteredPlatformPitchRateRadPerSec: 0,
  };
}

export function stepPitchController(
  state: PitchControllerState,
  measurements: PitchControllerMeasurements,
  config: PitchControllerConfig,
  dtS: number,
): PitchControllerStepResult {
  validatePitchControllerConfig(config);
  assertFinite("state.timeS", state.timeS);
  assertFinite("state.integralErrorRad", state.integralErrorRad);
  assertFinite("state.previousPitchRad", state.previousPitchRad);
  assertFinite("measurements.rotorSpeedRadPerSec", measurements.rotorSpeedRadPerSec);
  assertFinite(
    "measurements.platformPitchRateRadPerSec",
    measurements.platformPitchRateRadPerSec,
  );

  if (!Number.isFinite(dtS) || dtS <= 0) {
    throw new Error(`dtS must be a positive finite number. Received ${dtS}.`);
  }

  const previousPitchRad = clamp(
    state.previousPitchRad,
    config.minPitchRad,
    config.maxPitchRad,
  );

  const rotorSpeedErrorRadPerSec =
    measurements.rotorSpeedRadPerSec - config.rotorSpeedRefRadPerSec;
  const filteredPlatformPitchRateRadPerSec = lowPassFirstOrder({
  previousFilteredValue: state.filteredPlatformPitchRateRadPerSec,
  rawValue: measurements.platformPitchRateRadPerSec,
  cutoffHz: config.floatingFeedbackPitchRateLowPassCutoffHz,
  dtS,
  });
  const candidateIntegralErrorRad =
    state.integralErrorRad + rotorSpeedErrorRadPerSec * dtS;

  const candidateStep = calculateLimitedPitchStep({
    config,
    previousPitchRad,
    integralErrorRad: candidateIntegralErrorRad,
    rotorSpeedErrorRadPerSec,
    platformPitchRateRadPerSec: filteredPlatformPitchRateRadPerSec,
    dtS,
  });

  const holdIntegral =
    config.enableAntiWindup &&
    shouldHoldIntegral({
      rotorSpeedErrorRadPerSec,
      candidateStep,
      config,
    });

  const acceptedIntegralErrorRad = holdIntegral
    ? state.integralErrorRad
    : candidateIntegralErrorRad;

  const acceptedStep = holdIntegral
    ? calculateLimitedPitchStep({
        config,
        previousPitchRad,
        integralErrorRad: acceptedIntegralErrorRad,
        rotorSpeedErrorRadPerSec,
        platformPitchRateRadPerSec: filteredPlatformPitchRateRadPerSec,
        dtS,
      })
    : candidateStep;

  const nextPitchRad = acceptedStep.limitedPitchRad;

  return {
    state: {
      timeS: state.timeS + dtS,
      integralErrorRad: acceptedIntegralErrorRad,
      previousPitchRad: nextPitchRad,
      filteredPlatformPitchRateRadPerSec,
    },
    control: {
      collectivePitchRad: nextPitchRad,
      generatorTorqueNm: config.generatorTorqueNm,
    },
    diagnostics: {
      rotorSpeedErrorRadPerSec,
      platformPitchRateRadPerSec: measurements.platformPitchRateRadPerSec,
      proportionalTermRad: acceptedStep.proportionalTermRad,
      integralTermRad: acceptedStep.integralTermRad,
      floatingPitchTermRad: acceptedStep.floatingPitchTermRad,
      unsaturatedPitchDemandRad: acceptedStep.unsaturatedPitchDemandRad,
      pitchBeforeSaturationRad: acceptedStep.unsaturatedPitchDemandRad,
      pitchAfterRateLimitRad: acceptedStep.pitchAfterRateLimitRad,
      wasSaturated: acceptedStep.wasSaturated,
      wasRateLimited: acceptedStep.wasRateLimited,
      integralWasHeld: holdIntegral,
      filteredPlatformPitchRateRadPerSec,
    },
  };
}

interface LimitedPitchStepInput {
  config: PitchControllerConfig;
  previousPitchRad: number;
  integralErrorRad: number;
  rotorSpeedErrorRadPerSec: number;
  platformPitchRateRadPerSec: number;
  dtS: number;
}

interface LimitedPitchStepOutput {
  proportionalTermRad: number;
  integralTermRad: number;
  floatingPitchTermRad: number;
  unsaturatedPitchDemandRad: number;
  pitchAfterRateLimitRad: number;
  limitedPitchRad: number;
  wasSaturated: boolean;
  wasRateLimited: boolean;
  demandMinusPreviousPitchRad: number;
}

function calculateLimitedPitchStep(
  input: LimitedPitchStepInput,
): LimitedPitchStepOutput {
  const {
    config,
    previousPitchRad,
    integralErrorRad,
    rotorSpeedErrorRadPerSec,
    platformPitchRateRadPerSec,
    dtS,
  } = input;

  const proportionalTermRad = config.pitchKp * rotorSpeedErrorRadPerSec;
  const integralTermRad = config.pitchKi * integralErrorRad;
  const floatingPitchTermRad = config.floatingFeedbackEnabled
    ? config.platformPitchRateGainS * platformPitchRateRadPerSec
    : 0;

  const unsaturatedPitchDemandRad =
    config.trimPitchRad +
    proportionalTermRad +
    integralTermRad +
    floatingPitchTermRad;

  const maxPitchChangeRad = config.maxPitchRateRadPerSec * dtS;
  const demandMinusPreviousPitchRad =
    unsaturatedPitchDemandRad - previousPitchRad;

  const pitchAfterRateLimitRad =
    previousPitchRad +
    clamp(demandMinusPreviousPitchRad, -maxPitchChangeRad, maxPitchChangeRad);

  const limitedPitchRad = clamp(
    pitchAfterRateLimitRad,
    config.minPitchRad,
    config.maxPitchRad,
  );

  return {
    proportionalTermRad,
    integralTermRad,
    floatingPitchTermRad,
    unsaturatedPitchDemandRad,
    pitchAfterRateLimitRad,
    limitedPitchRad,
    wasSaturated:
      Math.abs(limitedPitchRad - pitchAfterRateLimitRad) >
      LIMIT_TOLERANCE_RAD,
    wasRateLimited:
      Math.abs(pitchAfterRateLimitRad - unsaturatedPitchDemandRad) >
      LIMIT_TOLERANCE_RAD,
    demandMinusPreviousPitchRad,
  };
}

function shouldHoldIntegral(input: {
  rotorSpeedErrorRadPerSec: number;
  candidateStep: LimitedPitchStepOutput;
  config: PitchControllerConfig;
}): boolean {
  const { rotorSpeedErrorRadPerSec, candidateStep, config } = input;

  const pushingTowardHigherPitch = rotorSpeedErrorRadPerSec > 0;
  const pushingTowardLowerPitch = rotorSpeedErrorRadPerSec < 0;

  const pushingPastUpperLimit =
    candidateStep.unsaturatedPitchDemandRad >=
      config.maxPitchRad - LIMIT_TOLERANCE_RAD &&
    pushingTowardHigherPitch;

  const pushingPastLowerLimit =
    candidateStep.unsaturatedPitchDemandRad <=
      config.minPitchRad + LIMIT_TOLERANCE_RAD &&
    pushingTowardLowerPitch;

  const pushingIntoRateLimit =
    candidateStep.wasRateLimited &&
    ((candidateStep.demandMinusPreviousPitchRad > 0 &&
      pushingTowardHigherPitch) ||
      (candidateStep.demandMinusPreviousPitchRad < 0 &&
        pushingTowardLowerPitch));

  return pushingPastUpperLimit || pushingPastLowerLimit || pushingIntoRateLimit;
}

function validatePitchControllerConfig(config: PitchControllerConfig): void {
  assertFinite("rotorSpeedRefRadPerSec", config.rotorSpeedRefRadPerSec);
  assertFinite("trimPitchRad", config.trimPitchRad);
  assertFinite("generatorTorqueNm", config.generatorTorqueNm);
  assertFinite("pitchKp", config.pitchKp);
  assertFinite("pitchKi", config.pitchKi);
  assertFinite("minPitchRad", config.minPitchRad);
  assertFinite("maxPitchRad", config.maxPitchRad);
  assertFinite("maxPitchRateRadPerSec", config.maxPitchRateRadPerSec);
  assertFinite("platformPitchRateGainS", config.platformPitchRateGainS);

  if (config.rotorSpeedRefRadPerSec <= 0) {
    throw new Error("rotorSpeedRefRadPerSec must be positive.");
  }

  if (config.generatorTorqueNm < 0) {
    throw new Error("generatorTorqueNm must be non-negative.");
  }

  if (config.maxPitchRad < config.minPitchRad) {
    throw new Error("maxPitchRad must be greater than or equal to minPitchRad.");
  }

  if (config.maxPitchRateRadPerSec <= 0) {
    throw new Error("maxPitchRateRadPerSec must be positive.");
  }

  if (
    config.trimPitchRad < config.minPitchRad ||
    config.trimPitchRad > config.maxPitchRad
  ) {
    throw new Error("trimPitchRad must lie within the pitch limits.");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite. Received ${value}.`);
  }
}

function lowPassFirstOrder(input: {
  previousFilteredValue: number;
  rawValue: number;
  cutoffHz: number;
  dtS: number;
}): number {
  const { previousFilteredValue, rawValue, cutoffHz, dtS } = input;

  if (cutoffHz <= 0) {
    return rawValue;
  }

  const omegaCutoffRadPerSec = 2 * Math.PI * cutoffHz;
  const alpha =
    (omegaCutoffRadPerSec * dtS) /
    (1 + omegaCutoffRadPerSec * dtS);

  return previousFilteredValue + alpha * (rawValue - previousFilteredValue);
}