import type { EnvironmentInputs } from "./types";

export type WindMode = "constant" | "gust" | "turbulent";

export interface WindClampConfig {
  minWindSpeedMps?: number;
  maxWindSpeedMps?: number;
}

export interface ConstantWindConfig extends WindClampConfig {
  mode: "constant";
  meanWindSpeedMps: number;
}

export interface GustWindConfig extends WindClampConfig {
  mode: "gust";
  meanWindSpeedMps: number;

  /**
   * Time at which the gust starts.
   */
  gustStartTimeSec: number;

  /**
   * Total gust duration.
   * The gust is zero at start and end, and reaches its maximum halfway through.
   */
  gustDurationSec: number;

  /**
   * Peak gust amplitude added to the mean wind speed.
   */
  gustAmplitudeMps: number;
}

export interface TurbulentWindConfig extends WindClampConfig {
  mode: "turbulent";
  meanWindSpeedMps: number;

  /**
   * Turbulence intensity:
   *
   *   TI = sigma / V_mean
   *
   * Example: 0.08 means 8%.
   */
  turbulenceIntensity: number;

  /**
   * Deterministic integer seed.
   */
  seed: number;

  /**
   * First-order filter time constant for the turbulent component.
   * Larger values give slower wind variations.
   */
  lowPassTimeConstantSec: number;

  /**
   * Optional initial wind speed.
   * If omitted, the turbulent component starts from zero.
   */
  initialWindSpeedMps?: number;
}

export type WindDisturbanceConfig =
  | ConstantWindConfig
  | GustWindConfig
  | TurbulentWindConfig;

export interface WindDisturbanceState {
  timeSec: number;
  windSpeedMps: number;
  gustMps: number;
  turbulentMps: number;
  rngStateUint32: number;
}

export interface WindDisturbance {
  readonly config: WindDisturbanceConfig;
  state: WindDisturbanceState;
}

export interface WindDisturbanceSample {
  timeSec: number;
  meanWindSpeedMps: number;
  gustMps: number;
  turbulentMps: number;
  windSpeedMps: number;

  /**
   * Directly compatible with the existing simulation EnvironmentInputs.
   * Waves remain disabled in Step 4.4a.
   */
  environment: EnvironmentInputs;
}

export function createWindDisturbance(
  config: WindDisturbanceConfig,
): WindDisturbance {
  validateWindConfig(config);

  const initialTurbulentMps =
    config.mode === "turbulent" && config.initialWindSpeedMps !== undefined
      ? config.initialWindSpeedMps - config.meanWindSpeedMps
      : 0;

  const initialWindSpeedMps = clampWindSpeed(
    config.meanWindSpeedMps + initialTurbulentMps,
    config,
  );

  return {
    config,
    state: {
      timeSec: 0,
      windSpeedMps: initialWindSpeedMps,
      gustMps: 0,
      turbulentMps: initialTurbulentMps,
      rngStateUint32:
        config.mode === "turbulent" ? normaliseSeed(config.seed) : 1,
    },
  };
}

export function getWindDisturbanceSample(
  disturbance: WindDisturbance,
): WindDisturbanceSample {
  return makeWindSample(disturbance.config, disturbance.state);
}

export function stepWindDisturbance(
  disturbance: WindDisturbance,
  dtSec: number,
): WindDisturbanceSample {
  if (!Number.isFinite(dtSec) || dtSec < 0) {
    throw new Error(`Invalid wind time step: ${dtSec}. Expected dtSec >= 0.`);
  }

  const { config } = disturbance;
  const nextTimeSec = disturbance.state.timeSec + dtSec;

  let gustMps = 0;
  let turbulentMps = 0;
  let rngStateUint32 = disturbance.state.rngStateUint32;

  if (config.mode === "gust") {
    gustMps = smoothCosineGustMps(nextTimeSec, config);
  }

  if (config.mode === "turbulent") {
    const turbulenceStep = stepTurbulentComponent(
      config,
      disturbance.state,
      dtSec,
    );

    turbulentMps = turbulenceStep.turbulentMps;
    rngStateUint32 = turbulenceStep.rngStateUint32;
  }

  const unclampedWindSpeedMps =
    config.meanWindSpeedMps + gustMps + turbulentMps;

  const windSpeedMps = clampWindSpeed(unclampedWindSpeedMps, config);

  disturbance.state = {
    timeSec: nextTimeSec,
    windSpeedMps,
    gustMps,
    turbulentMps,
    rngStateUint32,
  };

  return makeWindSample(config, disturbance.state);
}

function makeWindSample(
  config: WindDisturbanceConfig,
  state: WindDisturbanceState,
): WindDisturbanceSample {
  return {
    timeSec: state.timeSec,
    meanWindSpeedMps: config.meanWindSpeedMps,
    gustMps: state.gustMps,
    turbulentMps: state.turbulentMps,
    windSpeedMps: state.windSpeedMps,
    environment: {
      windSpeedMps: state.windSpeedMps,
      wavePitchMomentNm: 0,
    },
  };
}

function smoothCosineGustMps(
  timeSec: number,
  config: GustWindConfig,
): number {
  const elapsedSec = timeSec - config.gustStartTimeSec;

  if (elapsedSec < 0 || elapsedSec > config.gustDurationSec) {
    return 0;
  }

  const phase = elapsedSec / config.gustDurationSec;

  return 0.5 * config.gustAmplitudeMps * (1 - Math.cos(2 * Math.PI * phase));
}

function stepTurbulentComponent(
  config: TurbulentWindConfig,
  state: WindDisturbanceState,
  dtSec: number,
): Pick<WindDisturbanceState, "turbulentMps" | "rngStateUint32"> {
  if (dtSec === 0) {
    return {
      turbulentMps: state.turbulentMps,
      rngStateUint32: state.rngStateUint32,
    };
  }

  const sigmaMps = config.turbulenceIntensity * config.meanWindSpeedMps;

  /*
   * Discrete first-order filtered stochastic process:
   *
   *   v_turb[k+1] = a v_turb[k] + sqrt(1 - a^2) sigma n[k]
   *
   * with n[k] approximately standard normal.
   *
   * This gives a smooth turbulent component with stationary standard
   * deviation approximately equal to sigma = TI * V_mean.
   */
  const a = Math.exp(-dtSec / config.lowPassTimeConstantSec);
  const innovationStdMps = sigmaMps * Math.sqrt(Math.max(0, 1 - a * a));

  const normalSample = nextApproxStandardNormal(state.rngStateUint32);

  return {
    turbulentMps:
      a * state.turbulentMps + innovationStdMps * normalSample.value,
    rngStateUint32: normalSample.rngStateUint32,
  };
}

function nextApproxStandardNormal(rngStateUint32: number): {
  value: number;
  rngStateUint32: number;
} {
  /*
   * Sum-of-uniforms normal approximation.
   * This avoids Math.random and avoids Box-Muller spare-state bookkeeping.
   */
  let sum = 0;
  let nextState = rngStateUint32;

  for (let i = 0; i < 12; i += 1) {
    const uniformSample = nextUniform01(nextState);
    sum += uniformSample.value;
    nextState = uniformSample.rngStateUint32;
  }

  return {
    value: sum - 6,
    rngStateUint32: nextState,
  };
}

function nextUniform01(rngStateUint32: number): {
  value: number;
  rngStateUint32: number;
} {
  const nextState =
    (Math.imul(1664525, rngStateUint32) + 1013904223) >>> 0;

  return {
    value: (nextState + 0.5) / 4294967296,
    rngStateUint32: nextState,
  };
}

function normaliseSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    throw new Error(`Invalid wind seed: ${seed}. Expected a finite number.`);
  }

  const seedUint32 = Math.trunc(seed) >>> 0;

  return seedUint32 === 0 ? 0x6d2b79f5 : seedUint32;
}

function clampWindSpeed(
  windSpeedMps: number,
  config: WindDisturbanceConfig,
): number {
  const minWindSpeedMps = config.minWindSpeedMps ?? 0;
  const maxWindSpeedMps = config.maxWindSpeedMps;

  let clamped = Math.max(minWindSpeedMps, windSpeedMps);

  if (maxWindSpeedMps !== undefined) {
    clamped = Math.min(maxWindSpeedMps, clamped);
  }

  return clamped;
}

function validateWindConfig(config: WindDisturbanceConfig): void {
  assertFiniteNumber(config.meanWindSpeedMps, "meanWindSpeedMps");

  if (config.meanWindSpeedMps < 0) {
    throw new Error(
      `Invalid meanWindSpeedMps: ${config.meanWindSpeedMps}. Expected non-negative wind speed.`,
    );
  }

  if (config.minWindSpeedMps !== undefined) {
    assertFiniteNumber(config.minWindSpeedMps, "minWindSpeedMps");
  }

  if (config.maxWindSpeedMps !== undefined) {
    assertFiniteNumber(config.maxWindSpeedMps, "maxWindSpeedMps");
  }

  const minWindSpeedMps = config.minWindSpeedMps ?? 0;

  if (
    config.maxWindSpeedMps !== undefined &&
    config.maxWindSpeedMps < minWindSpeedMps
  ) {
    throw new Error(
      `Invalid wind clamp: maxWindSpeedMps (${config.maxWindSpeedMps}) is smaller than minWindSpeedMps (${minWindSpeedMps}).`,
    );
  }

  if (config.mode === "gust") {
    assertFiniteNumber(config.gustStartTimeSec, "gustStartTimeSec");
    assertFiniteNumber(config.gustDurationSec, "gustDurationSec");
    assertFiniteNumber(config.gustAmplitudeMps, "gustAmplitudeMps");

    if (config.gustDurationSec <= 0) {
      throw new Error(
        `Invalid gustDurationSec: ${config.gustDurationSec}. Expected a positive duration.`,
      );
    }
  }

  if (config.mode === "turbulent") {
    assertFiniteNumber(config.turbulenceIntensity, "turbulenceIntensity");
    assertFiniteNumber(
      config.lowPassTimeConstantSec,
      "lowPassTimeConstantSec",
    );

    if (config.meanWindSpeedMps <= 0) {
      throw new Error(
        "Turbulent wind requires meanWindSpeedMps > 0 because TI = sigma / V_mean.",
      );
    }

    if (config.turbulenceIntensity < 0) {
      throw new Error(
        `Invalid turbulenceIntensity: ${config.turbulenceIntensity}. Expected TI >= 0.`,
      );
    }

    if (config.lowPassTimeConstantSec <= 0) {
      throw new Error(
        `Invalid lowPassTimeConstantSec: ${config.lowPassTimeConstantSec}. Expected a positive time constant.`,
      );
    }

    if (config.initialWindSpeedMps !== undefined) {
      assertFiniteNumber(config.initialWindSpeedMps, "initialWindSpeedMps");
    }

    normaliseSeed(config.seed);
  }
}

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: ${value}. Expected a finite number.`);
  }
}