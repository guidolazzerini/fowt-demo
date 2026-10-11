import type { AeroPerformanceTable } from "./aero";
import { createBelowRatedControllerConfig } from "./belowRated";
import { belowRatedPitchDemand } from "./belowRatedPitch";
import { createCoordinatedControllerState, type CoordinatedControllerConfig } from "./coordinatedController";
import { createPitchControllerConfig } from "./controller";
import { solveFixedPitchOperatingPoint, solvePitchForTorque } from "./operatingPoint";
import type { TunableParameters } from "./params";
import type { SimulationScenarioConfig } from "./simulation";
import { torqueSpeedReference } from "./torqueController";
import { SUGGESTED_REFERENCE_GAINS, withFixedControllerGains, type FixedControllerGains } from "./suggestedGains";
import { createWindDisturbance, getWindDisturbanceSample, type WindDisturbanceConfig } from "./wind";

export function createCoordinatedControllerConfig(params: TunableParameters, table: AeroPerformanceTable,
  gains: FixedControllerGains = SUGGESTED_REFERENCE_GAINS): CoordinatedControllerConfig {
  const below = createBelowRatedControllerConfig(params);
  // Eq. (48) beta_max is the operating pitch at cut-out (25 m/s here).
  // Solve against Cq / rotor torque, not independently interpolated Cp power.
  const cutOut = solvePitchForTorque(table, params, params.cutOutWindSpeedMps,
    params.ratedRotorSpeedRadPerSec, below.torque.maxTorqueNm, params.minPitchRad, params.maxPitchRad);
  // Gain selection is explicit and fixed; wind never selects a catalog row.
  return withFixedControllerGains({ strategy: "coordinated-tsr-pi", torque: below.torque,
    absoluteTorqueLimitNm: params.maxGeneratorTorqueNm, minimumPitch: below.pitch,
    // The coordinated PI uses fine pitch as bias; integral supplies above-rated
    // trim. The legacy strategy retains its original fixed 4.1 degree bias.
    pitch: { ...createPitchControllerConfig(params), trimPitchRad: params.minPitchRad },
    smoother: { enabled: true, torqueReferenceShiftGain: 1, pitchReferenceShiftGain: 0.001,
      pitchAtCutOutRad: cutOut.pitchRad } }, gains);
}

/** Shared generating equilibrium initialization. The browser enforces its wind
 * envelope separately; this does not model startup or shutdown. */
export function createCoordinatedScenario(args: {
  name: string; totalTimeS: number; dtS: number; wind: WindDisturbanceConfig;
  params: TunableParameters; aeroTable: AeroPerformanceTable; config?: CoordinatedControllerConfig;
}): { scenario: SimulationScenarioConfig; operatingPoint: ReturnType<typeof solveFixedPitchOperatingPoint> & {
  pitchRad: number; rotorSpeedRadPerSec: number;
} } {
  const config = args.config ?? createCoordinatedControllerConfig(args.params, args.aeroTable);
  const windMps = getWindDisturbanceSample(createWindDisturbance(args.wind)).windSpeedMps;
  const rotorSpeedRadPerSec = torqueSpeedReference(windMps, config.torque);
  let pitchRad = belowRatedPitchDemand(windMps, config.minimumPitch).targetPitchRad;
  let point = solveFixedPitchOperatingPoint(args.aeroTable, args.params, windMps, rotorSpeedRadPerSec, pitchRad);
  if (point.aero.torqueNm > config.torque.maxTorqueNm) {
    const solved = solvePitchForTorque(args.aeroTable, args.params, windMps, rotorSpeedRadPerSec,
      config.torque.maxTorqueNm, pitchRad, config.pitch.maxPitchRad);
    pitchRad = solved.pitchRad;
    point = solved;
  }
  if (!point.withinAeroTable || point.aero.torqueNm <= 1 || point.aero.torqueNm < config.torque.minTorqueNm) {
    throw new Error("No supported generating equilibrium for coordinated initialization.");
  }
  const initialControllerState = createCoordinatedControllerState(config,
    { windMps, rotorSpeedRadPerSec, pitchRad, torqueNm: point.aero.torqueNm });
  return { operatingPoint: { ...point, pitchRad, rotorSpeedRadPerSec }, scenario: {
    name: args.name, totalTimeS: args.totalTimeS, dtS: args.dtS, wind: args.wind,
    initialState: { rotorSpeedRadPerSec, platformPitchRad: point.platformPitchRad, platformPitchRateRadPerSec: 0 },
    controller: { mode: "coordinated-tsr-pi", config, initialControllerState },
  } };
}
