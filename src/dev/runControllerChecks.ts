import {
  createPitchControllerConfig,
  createPitchControllerState,
  stepPitchController,
  type PitchControllerConfig,
} from "../sim/controller";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";

const DEG_TO_RAD = Math.PI / 180;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Controller validation failed: ${message}`);
  }
}

function assertFinite(name: string, value: number): void {
  assert(Number.isFinite(value), `${name} is not finite: ${value}`);
}

export function runControllerChecks(): void {
  console.group("Controller Step 5.1/5.2 validation");

  const baseConfig = createPitchControllerConfig(DEFAULT_TUNABLE_PARAMETERS);

  const zeroErrorState = createPitchControllerState(baseConfig);
  const zeroErrorStep = stepPitchController(
    zeroErrorState,
    {
      rotorSpeedRadPerSec: baseConfig.rotorSpeedRefRadPerSec,
      platformPitchRateRadPerSec: 0,
    },
    baseConfig,
    0.25,
  );

  assertFinite(
    "zeroErrorStep.control.collectivePitchRad",
    zeroErrorStep.control.collectivePitchRad,
  );
  assertFinite(
    "zeroErrorStep.control.generatorTorqueNm",
    zeroErrorStep.control.generatorTorqueNm,
  );
  assertFinite(
    "zeroErrorStep.state.integralErrorRad",
    zeroErrorStep.state.integralErrorRad,
  );

  assert(
    Math.abs(zeroErrorStep.control.collectivePitchRad - baseConfig.trimPitchRad) <
      1e-12,
    "zero speed error keeps collective pitch at the trim value",
  );

  const positiveErrorStep = stepPitchController(
    createPitchControllerState(baseConfig),
    {
      rotorSpeedRadPerSec: baseConfig.rotorSpeedRefRadPerSec + 0.05,
      platformPitchRateRadPerSec: 0,
    },
    baseConfig,
    0.25,
  );

  assert(
    positiveErrorStep.control.collectivePitchRad > baseConfig.trimPitchRad,
    "positive rotor-speed error increases collective pitch",
  );

  const negativeErrorStep = stepPitchController(
    createPitchControllerState(baseConfig),
    {
      rotorSpeedRadPerSec: baseConfig.rotorSpeedRefRadPerSec - 0.05,
      platformPitchRateRadPerSec: 0,
    },
    baseConfig,
    0.25,
  );

  assert(
    negativeErrorStep.control.collectivePitchRad < baseConfig.trimPitchRad,
    "negative rotor-speed error decreases collective pitch",
  );

  const noRateLimitConfig: PitchControllerConfig = {
    ...baseConfig,
    maxPitchRateRadPerSec: 1e6,
  };

  const minSaturationStep = stepPitchController(
    createPitchControllerState(noRateLimitConfig),
    {
      rotorSpeedRadPerSec: noRateLimitConfig.rotorSpeedRefRadPerSec - 10,
      platformPitchRateRadPerSec: 0,
    },
    noRateLimitConfig,
    0.1,
  );

  assert(
    minSaturationStep.control.collectivePitchRad === noRateLimitConfig.minPitchRad,
    "minimum pitch saturation works",
  );
  assert(
    minSaturationStep.diagnostics.wasSaturated,
    "minimum pitch saturation is reported by diagnostics",
  );

  const maxSaturationStep = stepPitchController(
    createPitchControllerState(noRateLimitConfig),
    {
      rotorSpeedRadPerSec: noRateLimitConfig.rotorSpeedRefRadPerSec + 10,
      platformPitchRateRadPerSec: 0,
    },
    noRateLimitConfig,
    0.1,
  );

  assert(
    maxSaturationStep.control.collectivePitchRad === noRateLimitConfig.maxPitchRad,
    "maximum pitch saturation works",
  );
  assert(
    maxSaturationStep.diagnostics.wasSaturated,
    "maximum pitch saturation is reported by diagnostics",
  );

  const rateLimitConfig: PitchControllerConfig = {
    ...baseConfig,
    maxPitchRateRadPerSec: 0.5 * DEG_TO_RAD,
  };
  const rateLimitDtS = 0.2;
  const rateLimitStep = stepPitchController(
    createPitchControllerState(rateLimitConfig),
    {
      rotorSpeedRadPerSec: rateLimitConfig.rotorSpeedRefRadPerSec + 1,
      platformPitchRateRadPerSec: 0,
    },
    rateLimitConfig,
    rateLimitDtS,
  );
  const pitchChangeRad = Math.abs(
    rateLimitStep.control.collectivePitchRad - rateLimitConfig.trimPitchRad,
  );
  const maximumAllowedPitchChangeRad =
    rateLimitConfig.maxPitchRateRadPerSec * rateLimitDtS;

  assert(
    pitchChangeRad <= maximumAllowedPitchChangeRad + 1e-12,
    "pitch-rate limit works",
  );
  assert(
    rateLimitStep.diagnostics.wasRateLimited,
    "pitch-rate limiting is reported by diagnostics",
  );

  const antiWindupConfig: PitchControllerConfig = {
    ...baseConfig,
    maxPitchRad: baseConfig.trimPitchRad + 0.5 * DEG_TO_RAD,
    maxPitchRateRadPerSec: 1e6,
    enableAntiWindup: true,
  };

  let antiWindupState = createPitchControllerState(antiWindupConfig);
  let lastPitchRad = antiWindupState.previousPitchRad;

  for (let i = 0; i < 400; i += 1) {
    const result = stepPitchController(
      antiWindupState,
      {
        rotorSpeedRadPerSec: antiWindupConfig.rotorSpeedRefRadPerSec + 2,
        platformPitchRateRadPerSec: 0,
      },
      antiWindupConfig,
      0.1,
    );
    antiWindupState = result.state;
    lastPitchRad = result.control.collectivePitchRad;
  }

  assert(
    Math.abs(antiWindupState.integralErrorRad) < 1e-10,
    "anti-windup prevents runaway integral growth during saturation",
  );
  assert(
    lastPitchRad <= antiWindupConfig.maxPitchRad + 1e-12,
    "anti-windup saturation test keeps pitch within the maximum limit",
  );

  console.log("Controller Step 5.1/5.2 validation passed.", {
    zeroErrorPitchRad: zeroErrorStep.control.collectivePitchRad,
    positiveErrorPitchRad: positiveErrorStep.control.collectivePitchRad,
    negativeErrorPitchRad: negativeErrorStep.control.collectivePitchRad,
    minSaturationPitchRad: minSaturationStep.control.collectivePitchRad,
    maxSaturationPitchRad: maxSaturationStep.control.collectivePitchRad,
    rateLimitedPitchChangeRad: pitchChangeRad,
    antiWindupIntegralErrorRad: antiWindupState.integralErrorRad,
  });

  console.groupEnd();
}