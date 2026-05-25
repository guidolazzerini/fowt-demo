import {
  computeAerodynamicOutputs,
  loadAeroTable,
  type AeroPerformanceTable,
} from "../sim/aero";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import type { ControlInputs, EnvironmentInputs } from "../sim/inputs";
import { stepSimulation } from "../sim/model";
import type { TunableParameters } from "../sim/params";
import type { TurbineState } from "../sim/state";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const RPM_TO_RAD_PER_SEC = (2 * Math.PI) / 60;
const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);

interface SteadyStateCase {
  name: string;
  windSpeedMps: number;
  rotorSpeedRadPerSec: number;
  pitchRad: number;
}

interface SteadyStateDefinition {
  spec: SteadyStateCase;
  environment: EnvironmentInputs;
  control: ControlInputs;
  state: TurbineState;
  aerodynamicPowerW: number;
  aerodynamicTorqueNm: number;
  thrustN: number;
  platformPitchEqRad: number;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFinite(name: string, value: number): void {
  assert(Number.isFinite(value), `${name} is not finite: ${value}`);
}

function rpmToRadPerSec(rpm: number): number {
  return rpm * RPM_TO_RAD_PER_SEC;
}

function radPerSecToRpm(radPerSec: number): number {
  return radPerSec * RAD_PER_SEC_TO_RPM;
}

function evaluateAero(
  table: AeroPerformanceTable,
  params: TunableParameters,
  rotorSpeedRadPerSec: number,
  pitchRad: number,
  windSpeedMps: number,
) {
  return computeAerodynamicOutputs(
    table,
    {
      rotorSpeedRadPerSec,
      pitchRad,
      windSpeedMps,
    },
    {
      airDensityKgPerM3: params.airDensityKgPerM3,
      rotorRadiusM: params.rotorRadiusM,
    },
  );
}

function solvePitchForTargetPower(
  table: AeroPerformanceTable,
  params: TunableParameters,
  rotorSpeedRadPerSec: number,
  windSpeedMps: number,
  targetPowerW: number,
): number {
  let lo = params.minPitchRad;
  let hi = params.maxPitchRad;

  const powerLo = evaluateAero(
    table,
    params,
    rotorSpeedRadPerSec,
    lo,
    windSpeedMps,
  ).powerW;

  const powerHi = evaluateAero(
    table,
    params,
    rotorSpeedRadPerSec,
    hi,
    windSpeedMps,
  ).powerW;

  const minPower = Math.min(powerLo, powerHi);
  const maxPower = Math.max(powerLo, powerHi);

  assert(
    targetPowerW >= minPower && targetPowerW <= maxPower,
    `Cannot solve pitch for ${targetPowerW / 1e6} MW at V=${windSpeedMps} m/s. ` +
      `Available bracket is ${minPower / 1e6} to ${maxPower / 1e6} MW.`,
  );

  const decreasingWithPitch = powerLo > powerHi;

  for (let k = 0; k < 80; k += 1) {
    const mid = 0.5 * (lo + hi);

    const powerMid = evaluateAero(
      table,
      params,
      rotorSpeedRadPerSec,
      mid,
      windSpeedMps,
    ).powerW;

    if (decreasingWithPitch) {
      if (powerMid > targetPowerW) {
        lo = mid;
      } else {
        hi = mid;
      }
    } else if (powerMid > targetPowerW) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return 0.5 * (lo + hi);
}

function buildSteadyState(
  table: AeroPerformanceTable,
  params: TunableParameters,
  spec: SteadyStateCase,
): SteadyStateDefinition {
  const aero = evaluateAero(
    table,
    params,
    spec.rotorSpeedRadPerSec,
    spec.pitchRad,
    spec.windSpeedMps,
  );

  const platformPitchEqRad =
    (params.thrustToPitchMomentArmM * aero.thrustN) /
    params.platformPitchStiffnessNm;

  const environment: EnvironmentInputs = {
    windSpeedMps: spec.windSpeedMps,
    wavePitchMomentNm: 0,
  };

  const control: ControlInputs = {
    collectivePitchRad: spec.pitchRad,
    generatorTorqueNm: aero.torqueNm,
  };

  const state: TurbineState = {
    timeS: 0,
    rotorSpeedRadPerSec: spec.rotorSpeedRadPerSec,
    rotorAzimuthRad: 0,
    platformPitchRad: platformPitchEqRad,
    platformPitchRateRadPerSec: 0,
  };

  return {
    spec,
    environment,
    control,
    state,
    aerodynamicPowerW: aero.powerW,
    aerodynamicTorqueNm: aero.torqueNm,
    thrustN: aero.thrustN,
    platformPitchEqRad,
  };
}

function simulate(
  initialState: TurbineState,
  environment: EnvironmentInputs,
  control: ControlInputs,
  params: TunableParameters,
  table: AeroPerformanceTable,
  durationS: number,
  dtS: number,
): TurbineState {
  let state = initialState;
  const nSteps = Math.round(durationS / dtS);

  for (let k = 0; k < nSteps; k += 1) {
    const snapshot = stepSimulation(
      state,
      environment,
      control,
      params,
      table,
      { dtS },
    );

    state = snapshot.state;

    assertFinite("rotorSpeedRadPerSec", state.rotorSpeedRadPerSec);
    assertFinite("platformPitchRad", state.platformPitchRad);
    assertFinite("platformPitchRateRadPerSec", state.platformPitchRateRadPerSec);
  }

  return state;
}

function checkOneCase(
  ss: SteadyStateDefinition,
  params: TunableParameters,
  table: AeroPerformanceTable,
): Record<string, number | string> {
  const exactFinal = simulate(
    ss.state,
    ss.environment,
    ss.control,
    params,
    table,
    20,
    0.05,
  );

  const exactRotorDriftRpm =
    Math.abs(
      exactFinal.rotorSpeedRadPerSec - ss.state.rotorSpeedRadPerSec,
    ) * RAD_PER_SEC_TO_RPM;

  const exactPlatformDriftDeg =
    Math.abs(exactFinal.platformPitchRad - ss.state.platformPitchRad) *
    RAD_TO_DEG;

  assert(
    exactRotorDriftRpm < 1e-6,
    `${ss.spec.name}: exact steady-state rotor drift is too large.`,
  );

  assert(
    exactPlatformDriftDeg < 1e-6,
    `${ss.spec.name}: exact steady-state platform drift is too large.`,
  );

  const perturbedInitial: TurbineState = {
    ...ss.state,
    rotorSpeedRadPerSec: 1.05 * ss.state.rotorSpeedRadPerSec,
    platformPitchRad: ss.state.platformPitchRad + 2 * DEG_TO_RAD,
    platformPitchRateRadPerSec: 0,
  };

  const initialRotorError =
    Math.abs(
      perturbedInitial.rotorSpeedRadPerSec - ss.state.rotorSpeedRadPerSec,
    );

  const initialPlatformError =
    Math.abs(perturbedInitial.platformPitchRad - ss.state.platformPitchRad);

  const perturbedFinal = simulate(
    perturbedInitial,
    ss.environment,
    ss.control,
    params,
    table,
    300,
    0.05,
  );

  const finalRotorError =
    Math.abs(
      perturbedFinal.rotorSpeedRadPerSec - ss.state.rotorSpeedRadPerSec,
    );

  const finalPlatformError =
    Math.abs(perturbedFinal.platformPitchRad - ss.state.platformPitchRad);

  assert(
    finalRotorError < initialRotorError,
    `${ss.spec.name}: rotor speed did not move closer to the steady state.`,
  );

  assert(
    finalPlatformError < initialPlatformError,
    `${ss.spec.name}: platform pitch did not move closer to the steady state.`,
  );

  return {
    case: ss.spec.name,
    windSpeedMps: ss.spec.windSpeedMps,
    rotorSpeedRpm: radPerSecToRpm(ss.spec.rotorSpeedRadPerSec),
    pitchDeg: ss.spec.pitchRad * RAD_TO_DEG,
    generatorTorqueMNm: ss.control.generatorTorqueNm / 1e6,
    aeroPowerMW: ss.aerodynamicPowerW / 1e6,
    thrustMN: ss.thrustN / 1e6,
    platformPitchEqDeg: ss.platformPitchEqRad * RAD_TO_DEG,
    finalRotorErrorRpm: finalRotorError * RAD_PER_SEC_TO_RPM,
    finalPlatformErrorDeg: finalPlatformError * RAD_TO_DEG,
  };
}

async function runSteadyStateChecks(): Promise<void> {
  console.group("Steady-state validation");

  const params = DEFAULT_TUNABLE_PARAMETERS;
  const table = await loadAeroTable(params.aero.filePath);

  const ratedRotorSpeed = params.ratedRotorSpeedRadPerSec;

  const cases: SteadyStateCase[] = [
    {
      name: "below-rated operating point, V=8 m/s",
      windSpeedMps: 8,
      rotorSpeedRadPerSec: rpmToRadPerSec(6.0),
      pitchRad: 0,
    },
    {
      name: "near-rated operating point, V=12 m/s",
      windSpeedMps: 12,
      rotorSpeedRadPerSec: ratedRotorSpeed,
      pitchRad: solvePitchForTargetPower(
        table,
        params,
        ratedRotorSpeed,
        12,
        params.ratedPowerW,
      ),
    },
    {
      name: "above-rated operating point, V=18 m/s",
      windSpeedMps: 18,
      rotorSpeedRadPerSec: ratedRotorSpeed,
      pitchRad: solvePitchForTargetPower(
        table,
        params,
        ratedRotorSpeed,
        18,
        params.ratedPowerW,
      ),
    },
  ];

  const rows = cases.map((spec) => {
    const ss = buildSteadyState(table, params, spec);
    return checkOneCase(ss, params, table);
  });

  console.table(rows);
  console.log("Steady-state validation passed.");
  console.groupEnd();
}

if (import.meta.env.DEV) {
  void runSteadyStateChecks().catch((error: unknown) => {
    console.error("Steady-state validation failed:", error);
  });
}