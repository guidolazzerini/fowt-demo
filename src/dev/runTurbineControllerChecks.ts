import { loadAeroTable } from "../sim/aero";
import {
  createPitchControllerConfig,
  createPitchControllerState,
  retunePitchControllerState,
  stepPitchController,
} from "../sim/controller";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import { stepSimulation } from "../sim/model";
import { createClosedLoopScenario, createDefaultInitialState, runSimulationScenario } from "../sim/simulation";
import {
  createLegacyTurbineControllerConfig,
  createTurbineControllerState,
  retuneTurbineControllerState,
  stepTurbineController,
} from "../sim/turbineController";
import { createWindDisturbance, getWindDisturbanceSample, stepWindDisturbance } from "../sim/wind";

const TOLERANCE = 1e-12;

export async function runTurbineControllerChecks(): Promise<void> {
  let maximumDifference = 0;
  // Compare every legacy field, including integral/filter states and limit flags.
  // Extra strategy/reference diagnostics are intentionally additive.
  function compare(actual: unknown, expected: unknown, path = "result"): void {
    if (typeof expected === "number" && typeof actual === "number") {
      const difference = Math.abs(actual - expected);
      if (!Number.isFinite(difference) || difference > TOLERANCE) {
        throw new Error(`${path}: ${actual} differs from legacy ${expected}`);
      }
      maximumDifference = Math.max(maximumDifference, difference);
    } else if (typeof expected === "object" && expected !== null) {
      if (typeof actual !== "object" || actual === null) throw new Error(`${path}: missing object`);
      for (const [key, value] of Object.entries(expected)) {
        compare((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
      }
    } else if (actual !== expected) {
      throw new Error(`${path}: values differ`);
    }
  }

  const params = DEFAULT_TUNABLE_PARAMETERS;
  let pitchConfig = { ...createPitchControllerConfig(params), floatingFeedbackEnabled: true, platformPitchRateGainS: 5 };
  let config = createLegacyTurbineControllerConfig(pitchConfig);
  let legacy = createPitchControllerState(pitchConfig);
  let shared = createTurbineControllerState(config);
  let sawSaturation = false;
  let sawRateLimit = false;
  let sawIntegralHeld = false;
  for (let i = 0; i < 4000; i++) {
    const measurements = {
      rotorSpeedRadPerSec: pitchConfig.rotorSpeedRefRadPerSec + 0.7 * Math.sin(i / 180),
      platformPitchRateRadPerSec: 0.01 * Math.sin(i / 35),
    };
    if (i === 1000 || i === 2000 || i === 3000) {
      pitchConfig = { ...pitchConfig, pitchKp: 0.8, pitchKi: i === 2000 ? 0 : 0.02 };
      config = createLegacyTurbineControllerConfig(pitchConfig);
      legacy = retunePitchControllerState(legacy, measurements.rotorSpeedRadPerSec, pitchConfig);
      shared = retuneTurbineControllerState(shared, measurements.rotorSpeedRadPerSec, config);
      compare(shared.pitch, legacy);
    }
    const reference = stepPitchController(legacy, measurements, pitchConfig, 0.02);
    const result = stepTurbineController(shared, measurements, config, 0.02);
    compare(result.state.pitch, reference.state);
    compare(result.control, reference.control);
    compare(result.diagnostics, reference.diagnostics);
    compare(result.diagnostics.strategy, "legacy-above-rated");
    compare(result.diagnostics.pitchSpeedRefRadPerSec, pitchConfig.rotorSpeedRefRadPerSec);
    legacy = reference.state;
    shared = result.state;
    sawSaturation ||= result.diagnostics.wasSaturated;
    sawRateLimit ||= result.diagnostics.wasRateLimited;
    sawIntegralHeld ||= result.diagnostics.integralWasHeld;
  }
  if (!sawSaturation || !sawRateLimit || !sawIntegralHeld) {
    throw new Error("Regression trace did not exercise all pitch limit/anti-windup branches");
  }

  const aeroTable = await loadAeroTable(params.aero.filePath);
  const winds = [
    { mode: "constant" as const, meanWindSpeedMps: 14 },
    { mode: "gust" as const, meanWindSpeedMps: 18, gustAmplitudeMps: 3, gustStartTimeSec: 20, gustDurationSec: 15 },
    { mode: "turbulent" as const, meanWindSpeedMps: 16, turbulenceIntensity: 0.1, seed: 12345, lowPassTimeConstantSec: 2.5 },
  ];
  for (const windConfig of winds) {
    const pitch = {
      ...createPitchControllerConfig(params),
      floatingFeedbackEnabled: windConfig.mode !== "constant",
      platformPitchRateGainS: 5,
    };
    const initialPitch = windConfig.mode === "gust" ? 0.2 : pitch.trimPitchRad;
    const scenario = createClosedLoopScenario({
      name: `legacy regression ${windConfig.mode}`, totalTimeS: 120, dtS: 0.02,
      wind: windConfig, params, controllerConfig: pitch,
      initialPitchRad: initialPitch,
    });
    // Check the existing optional restart state without changing its meaning.
    let referenceController = createPitchControllerState(pitch, initialPitch);
    if (windConfig.mode === "turbulent" && scenario.controller.mode === "closed-loop-pitch-pi") {
      referenceController = { ...referenceController, timeS: 7, integralErrorRad: 0.3, filteredPlatformPitchRateRadPerSec: 0.004 };
      scenario.controller.initialControllerState = referenceController;
    }
    const savedInitialController = { ...referenceController };
    const result = runSimulationScenario({ scenario, params, aeroTable });

    // Reference the pre-refactor order directly: pitch PI, wind, then physics.
    // This is intentionally independent of stepTurbineController.
    let state = createDefaultInitialState(params, aeroTable, {
      equilibriumWindSpeedMps: windConfig.meanWindSpeedMps, equilibriumPitchRad: initialPitch,
    });
    const wind = createWindDisturbance(windConfig);
    let windSample = getWindDisturbanceSample(wind);
    let control = { collectivePitchRad: referenceController.previousPitchRad, generatorTorqueNm: pitch.generatorTorqueNm };
    for (let i = 0; i < result.samples.length; i++) {
      const sample = result.samples[i];
      compare(sample, state, `${windConfig.mode}[${i}].state`);
      compare(sample, control, `${windConfig.mode}[${i}].control`);
      compare(sample.windSpeedMps, windSample.windSpeedMps);
      if (i === result.samples.length - 1) break;
      const step = stepPitchController(referenceController, state, pitch, scenario.dtS);
      referenceController = step.state;
      control = step.control;
      compare(result.samples[i + 1].controllerDiagnostics, step.diagnostics);
      windSample = stepWindDisturbance(wind, scenario.dtS);
      state = stepSimulation(state, windSample.environment, control, params, aeroTable, { dtS: scenario.dtS }).state;
    }
    compare(result.finalState, state);
    if (scenario.controller.mode === "closed-loop-pitch-pi" && scenario.controller.initialControllerState) {
      compare(scenario.controller.initialControllerState, savedInitialController);
    }
  }
  console.log("Shared turbine controller regression passed.", {
    controllerSteps: 4000, scenarioSteps: 18000, tolerance: TOLERANCE, maximumDifference,
  });
}
