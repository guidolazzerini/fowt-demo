import { loadAeroTable } from "../sim/aero";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import type { TunableParameters } from "../sim/params";
import {
  createClosedLoopScenario,
  createOpenLoopScenario,
  getExpectedSimulationSampleCount,
  runSimulationScenario,
  type SimulationScenarioResult,
  type SimulationScenarioSample,
} from "../sim/simulation";
import type { WindDisturbanceConfig } from "../sim/wind";

interface ScalarStats {
  mean: number;
  standardDeviation: number;
  min: number;
  max: number;
}

const INITIAL_WIND_SPEED_MPS = 18;
const DT_S = 0.05;

const CONSTANT_WIND: WindDisturbanceConfig = {
  mode: "constant",
  meanWindSpeedMps: INITIAL_WIND_SPEED_MPS,
  minWindSpeedMps: 0,
};

const GUST_WIND: WindDisturbanceConfig = {
  mode: "gust",
  meanWindSpeedMps: INITIAL_WIND_SPEED_MPS,
  gustStartTimeSec: 20,
  gustDurationSec: 20,
  gustAmplitudeMps: 3,
  minWindSpeedMps: 0,
};

const TURBULENT_WIND: WindDisturbanceConfig = {
  mode: "turbulent",
  meanWindSpeedMps: INITIAL_WIND_SPEED_MPS,
  turbulenceIntensity: 0.06,
  seed: 20260516,
  lowPassTimeConstantSec: 4,
  minWindSpeedMps: 0,
  maxWindSpeedMps: 40,
};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Simulation scenario validation failed: ${message}`);
  }
}

export async function runSimulationScenarioChecks(): Promise<void> {
  const params = DEFAULT_TUNABLE_PARAMETERS;
  const aeroTable = await loadAeroTable(params.aero.filePath);

  const constantOpenLoop = runSimulationScenario({
    params,
    aeroTable,
    scenario: createOpenLoopScenario({
      name: "open-loop constant",
      totalTimeS: 80,
      dtS: DT_S,
      wind: CONSTANT_WIND,
      params,
    }),
  });

  const constantClosedLoop = runSimulationScenario({
    params,
    aeroTable,
    scenario: createClosedLoopScenario({
      name: "closed-loop constant",
      totalTimeS: 80,
      dtS: DT_S,
      wind: CONSTANT_WIND,
      params,
    }),
  });

  const gustOpenLoop = runSimulationScenario({
    params,
    aeroTable,
    scenario: createOpenLoopScenario({
      name: "open-loop gust",
      totalTimeS: 100,
      dtS: DT_S,
      wind: GUST_WIND,
      params,
    }),
  });

  const gustClosedLoop = runSimulationScenario({
    params,
    aeroTable,
    scenario: createClosedLoopScenario({
      name: "closed-loop gust",
      totalTimeS: 100,
      dtS: DT_S,
      wind: GUST_WIND,
      params,
    }),
  });

  const turbulentClosedLoop = runSimulationScenario({
    params,
    aeroTable,
    scenario: createClosedLoopScenario({
      name: "closed-loop turbulent",
      totalTimeS: 180,
      dtS: DT_S,
      wind: TURBULENT_WIND,
      params,
    }),
  });

  const turbulentClosedLoopRepeat = runSimulationScenario({
    params,
    aeroTable,
    scenario: createClosedLoopScenario({
      name: "closed-loop turbulent repeat",
      totalTimeS: 180,
      dtS: DT_S,
      wind: TURBULENT_WIND,
      params,
    }),
  });

  const allResults = [
    constantOpenLoop,
    constantClosedLoop,
    gustOpenLoop,
    gustClosedLoop,
    turbulentClosedLoop,
    turbulentClosedLoopRepeat,
  ];

  const closedLoopResults = [
    constantClosedLoop,
    gustClosedLoop,
    turbulentClosedLoop,
    turbulentClosedLoopRepeat,
  ];

  const allSamples = allResults.flatMap((result) => result.samples);
  const closedLoopSamples = closedLoopResults.flatMap(
    (result) => result.samples,
  );

  assert(
    allSamples.every(sampleIsFinite),
    "all scenario signals are finite",
  );

  assert(
    allResults.every(timeVectorIsValid),
    "time vector has expected length and monotonic spacing",
  );

  assert(
    allSamples.every((sample) => sample.rotorSpeedRadPerSec > 0),
    "rotor speed remains positive",
  );

  assert(
    closedLoopSamples.every(
      (sample) =>
        sample.collectivePitchRad >= params.minPitchRad - 1e-12 &&
        sample.collectivePitchRad <= params.maxPitchRad + 1e-12,
    ),
    "closed-loop collective pitch remains within min/max limits",
  );

  assert(
    closedLoopResults.every((result) =>
      pitchRateLimitIsRespected(result, params),
    ),
    "closed-loop collective pitch rate respects the configured rate limit",
  );

  assert(
    allSamples.every((sample) => sample.wavePitchMomentNm === 0),
    "wavePitchMomentNm remains zero",
  );

  assert(
    sameResponseSequence(
      turbulentClosedLoop.samples,
      turbulentClosedLoopRepeat.samples,
    ),
    "turbulent scenario is exactly deterministic for the same seed",
  );

  const gustOpenLoopStats = calculateStats(
    selectWindow(gustOpenLoop.samples, 20, 70).map(
      (sample) => sample.rotorSpeedRadPerSec,
    ),
  );

  const gustClosedLoopStats = calculateStats(
    selectWindow(gustClosedLoop.samples, 20, 70).map(
      (sample) => sample.rotorSpeedRadPerSec,
    ),
  );

  assert(
    gustClosedLoopStats.standardDeviation <
      gustOpenLoopStats.standardDeviation,
    "closed-loop gust rotor-speed standard deviation is lower than open-loop gust rotor-speed standard deviation",
  );

  console.log("Simulation scenario Step 6 validation passed.", {
    gustOpenLoopStats,
    gustClosedLoopStats,
  });
}

function sampleIsFinite(sample: SimulationScenarioSample): boolean {
  return [
    sample.timeS,
    sample.windSpeedMps,
    sample.meanWindSpeedMps,
    sample.gustMps,
    sample.turbulentMps,
    sample.effectiveWindSpeedMps,
    sample.rotorSpeedRadPerSec,
    sample.rotorAzimuthRad,
    sample.collectivePitchRad,
    sample.generatorTorqueNm,
    sample.platformPitchRad,
    sample.platformPitchRateRadPerSec,
    sample.aerodynamicPowerW,
    sample.aerodynamicTorqueNm,
    sample.thrustN,
    sample.cp,
    sample.ct,
    sample.wavePitchMomentNm,
  ].every(Number.isFinite);
}

function timeVectorIsValid(result: SimulationScenarioResult): boolean {
  const { samples, scenario } = result;
  const expectedLength = getExpectedSimulationSampleCount(
    scenario.totalTimeS,
    scenario.dtS,
  );

  if (samples.length !== expectedLength) {
    return false;
  }

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];

    if (sample === undefined) {
      return false;
    }

    const expectedTimeS = i * scenario.dtS;

    if (Math.abs(sample.timeS - expectedTimeS) > 1e-9) {
      return false;
    }

    if (i > 0) {
      const previousSample = samples[i - 1];

      if (previousSample === undefined) {
        return false;
      }

      const dtS = sample.timeS - previousSample.timeS;

      if (dtS <= 0 || Math.abs(dtS - scenario.dtS) > 1e-9) {
        return false;
      }
    }
  }

  return true;
}

function pitchRateLimitIsRespected(
  result: SimulationScenarioResult,
  params: TunableParameters,
): boolean {
  let previousPitchRad: number | undefined;

  for (const sample of result.samples) {
    if (previousPitchRad !== undefined) {
      const pitchRateRadPerSec =
        Math.abs(sample.collectivePitchRad - previousPitchRad) /
        result.scenario.dtS;

      if (pitchRateRadPerSec > params.maxPitchRateRadPerSec + 1e-9) {
        return false;
      }
    }

    previousPitchRad = sample.collectivePitchRad;
  }

  return true;
}

function selectWindow(
  samples: SimulationScenarioSample[],
  startTimeS: number,
  endTimeS: number,
): SimulationScenarioSample[] {
  return samples.filter(
    (sample) => sample.timeS >= startTimeS && sample.timeS <= endTimeS,
  );
}

function calculateStats(values: number[]): ScalarStats {
  assert(values.length > 0, "cannot calculate statistics for an empty array");

  const mean =
    values.reduce((runningSum, value) => runningSum + value, 0) / values.length;

  const variance =
    values.reduce((runningSum, value) => {
      const error = value - mean;
      return runningSum + error * error;
    }, 0) / values.length;

  return {
    mean,
    standardDeviation: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function sameResponseSequence(
  samplesA: SimulationScenarioSample[],
  samplesB: SimulationScenarioSample[],
): boolean {
  if (samplesA.length !== samplesB.length) {
    return false;
  }

  for (let i = 0; i < samplesA.length; i += 1) {
    const sampleA = samplesA[i];
    const sampleB = samplesB[i];

    if (sampleA === undefined || sampleB === undefined) {
      return false;
    }

    if (
      sampleA.timeS !== sampleB.timeS ||
      sampleA.windSpeedMps !== sampleB.windSpeedMps ||
      sampleA.meanWindSpeedMps !== sampleB.meanWindSpeedMps ||
      sampleA.gustMps !== sampleB.gustMps ||
      sampleA.turbulentMps !== sampleB.turbulentMps ||
      sampleA.effectiveWindSpeedMps !== sampleB.effectiveWindSpeedMps ||
      sampleA.rotorSpeedRadPerSec !== sampleB.rotorSpeedRadPerSec ||
      sampleA.rotorAzimuthRad !== sampleB.rotorAzimuthRad ||
      sampleA.collectivePitchRad !== sampleB.collectivePitchRad ||
      sampleA.generatorTorqueNm !== sampleB.generatorTorqueNm ||
      sampleA.platformPitchRad !== sampleB.platformPitchRad ||
      sampleA.platformPitchRateRadPerSec !==
        sampleB.platformPitchRateRadPerSec ||
      sampleA.aerodynamicPowerW !== sampleB.aerodynamicPowerW ||
      sampleA.aerodynamicTorqueNm !== sampleB.aerodynamicTorqueNm ||
      sampleA.thrustN !== sampleB.thrustN ||
      sampleA.cp !== sampleB.cp ||
      sampleA.ct !== sampleB.ct ||
      sampleA.wavePitchMomentNm !== sampleB.wavePitchMomentNm
    ) {
      return false;
    }
  }

  return true;
}