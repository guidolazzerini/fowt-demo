import type { AeroPerformanceTable } from "./aero";
import type { TunableParameters } from "./params";
import type { SimulationScenarioConfig } from "./simulation";
import { createWindDisturbance, getWindDisturbanceSample, type WindDisturbanceConfig } from "./wind";
import { createTurbineControllerState, type BelowRatedTurbineControllerConfig } from "./turbineController";
import { torqueSpeedReference } from "./torqueController";
import { solveFixedPitchOperatingPoint } from "./operatingPoint";
import { belowRatedPitchDemand } from "./belowRatedPitch";

export function createBelowRatedControllerConfig(params: TunableParameters): BelowRatedTurbineControllerConfig {
  // Retain the table-checked TSR target; use the published IEA low-wind pitch
  // schedule to permit positive generating torque at the 5 rpm speed floor.
  const naturalFrequencyRadPerSec = 0.08;
  const dampingRatio = 0.9;
  return { strategy: "below-rated-tsr-pi", pitch: {
    mode: "iea15-low-wind", minPitchRad: params.minPitchRad,
    maxPitchRad: params.maxPitchRad, maxPitchRateRadPerSec: params.maxPitchRateRadPerSec,
  }, torque: {
    targetTsr: 9.5, rotorRadiusM: params.rotorRadiusM,
    minimumRotorSpeedRadPerSec: 5 * (2 * Math.PI / 60),
    ratedRotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec,
    windFilterTimeConstantS: 5,
    // Initial PI tuning from J*dOmega/dt = Taero - Tgen, neglecting aero slope.
    kpNmsPerRad: 2 * dampingRatio * naturalFrequencyRadPerSec * params.rotorInertiaKgM2,
    kiNmPerRad: naturalFrequencyRadPerSec ** 2 * params.rotorInertiaKgM2,
    minTorqueNm: params.minGeneratorTorqueNm,
    // Normal generating cap is rated torque (~18.97 MN m); the existing
    // absolute actuator ceiling is 20 MN m. Respect whichever is smaller.
    maxTorqueNm: Math.min(params.ratedGeneratorTorqueNm, params.maxGeneratorTorqueNm),
    maxTorqueRateNmPerSec: 2e6,
  } };
}

export function assessBelowRatedOperatingPoint(table: AeroPerformanceTable, params: TunableParameters,
  windMps: number, config: BelowRatedTurbineControllerConfig) {
  const rotorSpeedRadPerSec = torqueSpeedReference(windMps, config.torque);
  const collectivePitchRad = belowRatedPitchDemand(windMps, config.pitch).targetPitchRad;
  const point = solveFixedPitchOperatingPoint(table, params, windMps, rotorSpeedRadPerSec, collectivePitchRad);
  // Treat <= 1 N m as no useful generation (a numerical feasibility tolerance).
  const reason = !point.withinAeroTable ? "outside-aerodynamic-table" :
    point.aero.torqueNm <= 1 ? "no-positive-generating-torque" :
    point.aero.torqueNm < config.torque.minTorqueNm || point.aero.torqueNm > config.torque.maxTorqueNm
      ? "required-torque-outside-limits" : "feasible";
  return { ...point, rotorSpeedRadPerSec, collectivePitchRad, feasible: reason === "feasible", reason };
}

/** Initialize a generating operating point, not a startup simulation. Infeasible
 * targets remain inspectable: torque is bounded, but rotor speed is never forced
 * to the reference or minimum speed. Consult operatingPoint before claiming success.
 */
export function createBelowRatedScenario(args: {
  name: string; totalTimeS: number; dtS: number; wind: WindDisturbanceConfig;
  params: TunableParameters; aeroTable: AeroPerformanceTable;
  config?: BelowRatedTurbineControllerConfig; initialRotorSpeedRadPerSec?: number;
}): { scenario: SimulationScenarioConfig; operatingPoint: ReturnType<typeof assessBelowRatedOperatingPoint> } {
  const config = args.config ?? createBelowRatedControllerConfig(args.params);
  // Match the runner's initial wind exactly, including any caller-supplied clamps.
  const windMps = getWindDisturbanceSample(createWindDisturbance(args.wind)).windSpeedMps;
  const operatingPoint = assessBelowRatedOperatingPoint(args.aeroTable, args.params, windMps, config);
  const initialSpeed = args.initialRotorSpeedRadPerSec ?? operatingPoint.rotorSpeedRadPerSec;
  const initial = solveFixedPitchOperatingPoint(args.aeroTable, args.params, windMps, initialSpeed, operatingPoint.collectivePitchRad);
  const controllerState = createTurbineControllerState(config, {
    initialWindMps: windMps, initialRotorSpeedRadPerSec: initialSpeed, initialTorqueNm: initial.aero.torqueNm,
  });
  return { operatingPoint, scenario: {
    name: args.name, totalTimeS: args.totalTimeS, dtS: args.dtS, wind: args.wind,
    initialState: { rotorSpeedRadPerSec: initialSpeed, platformPitchRad: initial.platformPitchRad, platformPitchRateRadPerSec: 0 },
    controller: { mode: "below-rated-tsr-pi", config, initialControllerState: controllerState },
  } };
}
