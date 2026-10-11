import { computeAerodynamicOutputs, loadAeroTable } from "../sim/aero";
import { assessBelowRatedOperatingPoint, createBelowRatedControllerConfig, createBelowRatedScenario } from "../sim/belowRated";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import { runSimulationScenario, type SimulationScenarioResult } from "../sim/simulation";
import { createTorqueControllerState, stepTorqueController, torqueSpeedReference } from "../sim/torqueController";
import { belowRatedPitchDemand, iea15LowWindPitchRad, IEA15_LOW_WIND_PITCH, stepBelowRatedPitch } from "../sim/belowRatedPitch";
import { createTurbineControllerState, stepTurbineController } from "../sim/turbineController";

const RPM = 2 * Math.PI / 60;
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Below-rated validation: ${message}`);
}

export async function runTorqueControllerChecks(): Promise<void> {
  const params = DEFAULT_TUNABLE_PARAMETERS;
  const table = await loadAeroTable(params.aero.filePath);
  const config = createBelowRatedControllerConfig(params);
  const torque = config.torque;
  const dt = 0.02;
  assert(Math.abs(torque.minimumRotorSpeedRadPerSec / RPM - 5) < 1e-12, "IEA minimum reference is 5 rpm");
  for (const [wind, pitch] of IEA15_LOW_WIND_PITCH) {
    assert(Math.abs(iea15LowWindPitchRad(wind) - pitch) < 1e-14, "published schedule knots [rad]");
  }
  assert(iea15LowWindPitchRad(2) === 0.06 && iea15LowWindPitchRad(12) === 0, "endpoint holding excludes peak shaving");
  assert(Math.abs(iea15LowWindPitchRad((5.1352 + 5.4021) / 2) - (0.0472 + 0.0415) / 2) < 1e-14,
    "linear interpolation between published knots");
  const limitedPitch = belowRatedPitchDemand(3, { ...config.pitch, maxPitchRad: 0.03 });
  assert(limitedPitch.wasSaturated && limitedPitch.targetPitchRad === 0.03, "pitch amplitude limit applied and reported");
  assert(belowRatedPitchDemand(8, { ...config.pitch, minPitchRad: 0.01 }).targetPitchRad === 0.01, "lower pitch bound");
  for (const [previous, wind] of [[0, 3], [0.06, 8]]) {
    const step = stepBelowRatedPitch(previous, wind, config.pitch, dt);
    assert(step.diagnostics.wasRateLimited && Math.abs(Math.abs(step.pitchRad - previous) - config.pitch.maxPitchRateRadPerSec * dt) < 1e-14,
      "pitch slew limit exercised in both directions");
  }
  const pitchState = createTurbineControllerState(config, { initialWindMps: 3, initialRotorSpeedRadPerSec: 5 * RPM, initialTorqueNm: 0 });
  const pitchStep = stepTurbineController(pitchState, { rotorSpeedRadPerSec: 5 * RPM,
    platformPitchRateRadPerSec: 0, controlWindMps: 8 }, config, 1);
  assert(pitchStep.diagnostics.strategy === "below-rated-tsr-pi" &&
    pitchStep.diagnostics.pitch.scheduledPitchRad === iea15LowWindPitchRad(pitchStep.diagnostics.torque.filteredWindMps),
    "pitch uses the same filtered simulated wind as torque");
  const ref = torqueSpeedReference(6, torque);
  const initial = createTorqueControllerState(torque, 6, ref, 5e6);
  const measure = (speed: number, wind = 6) => ({ rotorSpeedRadPerSec: speed, controlWindMps: wind });
  const up = stepTorqueController(initial, measure(ref + 0.02), torque, dt);
  const down = stepTorqueController(initial, measure(ref - 0.02), torque, dt);
  assert(up.torqueNm > initial.previousTorqueNm && down.torqueNm < initial.previousTorqueNm,
    "overspeed must increase braking torque; underspeed must decrease it");
  assert(up.diagnostics.wasRateLimited && down.diagnostics.wasRateLimited, "both slew directions exercised");
  const filtered = stepTorqueController(initial, measure(ref, 8), torque, 1);
  assert(Math.abs(filtered.state.filteredWindMps - (8 - 2 * Math.exp(-1 / 5))) < 1e-12, "5 s filter response");
  assert(filtered.diagnostics.controlWindMps === 8 && filtered.diagnostics.windInputSource === "simulated-free-stream", "raw input and source identified");

  // Sustained infeasible errors must not accumulate integral state at either cap.
  for (const speed of [0, 2]) {
    let state = { ...initial };
    for (let i = 0; i < 2000; i++) {
      const step = stepTorqueController(state, measure(speed), torque, dt);
      assert(step.torqueNm >= torque.minTorqueNm && step.torqueNm <= torque.maxTorqueNm, "torque amplitude bounds");
      assert(Math.abs(step.torqueNm - state.previousTorqueNm) <= torque.maxTorqueRateNmPerSec * dt + 1e-8, "torque slew bound");
      assert(step.state.integralTorqueNm === initial.integralTorqueNm, "integrator held under sustained limiting");
      state = step.state;
    }
    assert(Math.abs(state.previousTorqueNm - (speed === 0 ? torque.minTorqueNm : torque.maxTorqueNm)) < 1e-8, "reaches appropriate bound");
    const recovery = stepTorqueController(state, measure(ref), torque, dt);
    assert(speed === 0 ? recovery.torqueNm > state.previousTorqueNm : recovery.torqueNm < state.previousTorqueNm,
      "recovers from both bounds without accumulated windup");
  }
  const pOnly = stepTorqueController(initial, measure(ref), { ...torque, kiNmPerRad: 0 }, dt);
  assert(pOnly.state.integralTorqueNm === 0, "zero Ki explicitly clears stored integral");

  function checkActuator(result: SimulationScenarioResult, maxTorque = torque.maxTorqueNm): void {
    for (let i = 0; i < result.samples.length; i++) {
      const sample = result.samples[i];
      for (const value of Object.values(sample)) {
        if (typeof value === "number") assert(Number.isFinite(value), "finite scenario outputs");
      }
      assert(sample.collectivePitchRad >= config.pitch.minPitchRad && sample.collectivePitchRad <= config.pitch.maxPitchRad, "pitch within actuator bounds");
      assert(sample.generatorTorqueNm >= 0 && sample.generatorTorqueNm <= maxTorque + 1e-8, "positive braking torque within cap");
      if (i > 0) {
        const previous = result.samples[i - 1];
        assert(Math.abs(sample.collectivePitchRad - previous.collectivePitchRad) <= config.pitch.maxPitchRateRadPerSec * result.scenario.dtS + 1e-12, "scenario pitch slew bound");
        assert(Math.abs(sample.generatorTorqueNm - previous.generatorTorqueNm) <= torque.maxTorqueRateNmPerSec * result.scenario.dtS + 1e-8, "scenario slew bound");
        const diagnostics = sample.controllerDiagnostics;
        assert(diagnostics?.strategy === "below-rated-tsr-pi", "development strategy diagnostics");
        assert(Object.values(diagnostics.torque).every(v => typeof v !== "number" || Number.isFinite(v)), "finite torque diagnostics");
        assert(Object.values(diagnostics.pitch).every(v => typeof v !== "number" || Number.isFinite(v)), "finite pitch diagnostics");
        assert(diagnostics.torque.speedRefRadPerSec >= torque.minimumRotorSpeedRadPerSec &&
          diagnostics.torque.speedRefRadPerSec <= torque.ratedRotorSpeedRadPerSec, "reference speed limits");
      }
    }
  }

  const rows = [];
  let maximumTrackingErrorRpm = 0;
  for (const wind of [3, 4, 5, 6, 7, 8, 9, 10]) {
    const point = assessBelowRatedOperatingPoint(table, params, wind, config);
    assert(point.feasible, `expected generating equilibrium at ${wind} m/s`);
    // Compare with the best pitch at the SAME constrained speed. At low winds
    // the 5 rpm floor prevents the unconstrained optimum TSR being reached.
    let peakCp = 0;
    for (let pitchDeg = 0; pitchDeg <= 30; pitchDeg += 0.1) {
      const aero = computeAerodynamicOutputs(table, {
        rotorSpeedRadPerSec: point.rotorSpeedRadPerSec, pitchRad: pitchDeg * Math.PI / 180,
        windSpeedMps: point.effectiveWindSpeedMps,
      }, { airDensityKgPerM3: params.airDensityKgPerM3, rotorRadiusM: params.rotorRadiusM });
      peakCp = Math.max(peakCp, aero.cp);
    }
    assert(point.aero.cp / peakCp > 0.95, `published schedule retains >95% of scanned Cp at constrained speed at ${wind} m/s`);
    for (const speedFactor of [1, 0.9, 1.1]) {
      const { scenario } = createBelowRatedScenario({
        name: `${wind} m/s, speed factor ${speedFactor}`, totalTimeS: 600, dtS: dt,
        wind: { mode: "constant", meanWindSpeedMps: wind }, params, aeroTable: table, config,
        initialRotorSpeedRadPerSec: point.rotorSpeedRadPerSec * speedFactor,
      });
      const result = runSimulationScenario({ scenario, params, aeroTable: table });
      checkActuator(result);
      const diagnostic = result.samples[1].controllerDiagnostics;
      assert(diagnostic?.strategy === "below-rated-tsr-pi", "torque diagnostics available");
      if (wind === 3) assert(diagnostic.torque.minimumSpeedActive, "minimum-reference clamp reported");
      if (wind === 10) assert(diagnostic.torque.ratedSpeedActive, "rated-reference clamp reported");
      const tail = result.samples.filter(sample => sample.timeS >= 500);
      const errorRpm = Math.max(...tail.map(sample => Math.abs(sample.rotorSpeedRadPerSec - point.rotorSpeedRadPerSec) / RPM));
      maximumTrackingErrorRpm = Math.max(maximumTrackingErrorRpm, errorRpm);
      assert(errorRpm < 1e-4, `steady reference tracking after perturbation at ${wind} m/s`);
      assert(tail.every(sample => Math.abs(sample.aerodynamicTorqueNm - sample.generatorTorqueNm) < 100), "steady torque balance [N m]");
      assert(tail.every(sample => Math.abs(sample.platformPitchRateRadPerSec) < 1e-5), "platform converges");
      if (speedFactor === 1) assert(result.samples.every(sample => Math.abs(sample.rotorSpeedRadPerSec - point.rotorSpeedRadPerSec) < 1e-10), "equilibrium initialization stays stationary");
      if (wind === 3 && speedFactor === 0.9) assert(result.samples[1].rotorSpeedRadPerSec < torque.minimumRotorSpeedRadPerSec, "minimum is a reference constraint, not a physical speed clamp");
    }
    rows.push({ windMps: wind, speedRpm: point.rotorSpeedRadPerSec / RPM,
      pitchDeg: point.collectivePitchRad * 180 / Math.PI,
      torqueMNm: point.aero.torqueNm / 1e6, generatorMechanicalPowerKW: point.aero.torqueNm * point.rotorSpeedRadPerSec / 1000,
      cp: point.aero.cp, fractionOfConstrainedPeakCp: point.aero.cp / peakCp });
  }

  // Fixed 0 degrees was the cause of the previous 5 rpm / 3 m/s infeasibility.
  // Keep this counterexample beside the now-feasible published pitch schedule.
  const highFloor = { ...config, pitch: { ...config.pitch, mode: "fixed" as const, fixedPitchRad: 0 } };
  const infeasible = createBelowRatedScenario({ name: "fixed-zero pitch at 5 rpm and 3 m/s", totalTimeS: 120, dtS: dt,
    wind: { mode: "constant", meanWindSpeedMps: 3 }, params, aeroTable: table, config: highFloor });
  assert(!infeasible.operatingPoint.feasible && infeasible.operatingPoint.reason === "no-positive-generating-torque", "zero-generation floor identified");
  const coast = runSimulationScenario({ scenario: infeasible.scenario, params, aeroTable: table });
  assert(coast.samples.every(sample => sample.generatorTorqueNm === 0), "coasting at the requested speed is not positive generation");

  const insufficient = createBelowRatedScenario({ name: "fixed-pitch torque cap at 11 m/s", totalTimeS: 120, dtS: dt,
    wind: { mode: "constant", meanWindSpeedMps: 11 }, params, aeroTable: table, config });
  assert(insufficient.operatingPoint.reason === "required-torque-outside-limits", "infeasible torque target identified");
  const capped = runSimulationScenario({ scenario: insufficient.scenario, params, aeroTable: table });
  checkActuator(capped);
  assert(capped.finalState.rotorSpeedRadPerSec > torque.ratedRotorSpeedRadPerSec + 0.05, "no artificial rated-speed clamp masks missing pitch regulation");
  assert(capped.samples.some(sample => sample.controllerDiagnostics?.strategy === "below-rated-tsr-pi" && sample.controllerDiagnostics.torque.wasSaturated), "torque cap reported");

  // Traverse the complete low-wind pitch branch in both directions, then allow
  // the low-power 3 m/s point to recover. Actual speed may dip below 5 rpm.
  const gust = createBelowRatedScenario({ name: "pitch schedule 3 to 8 to 3 m/s", totalTimeS: 800, dtS: dt,
    wind: { mode: "gust", meanWindSpeedMps: 3, gustStartTimeSec: 20, gustDurationSec: 200, gustAmplitudeMps: 5 },
    params, aeroTable: table, config });
  const gustResult = runSimulationScenario({ scenario: gust.scenario, params, aeroTable: table });
  checkActuator(gustResult);
  assert(gustResult.samples.some(sample => sample.collectivePitchRad === 0), "gust reaches fine pitch");
  assert(Math.abs(gustResult.samples.at(-1)!.collectivePitchRad - 0.06) < 1e-12, "pitch returns to low-wind plateau");
  assert(gustResult.samples.filter(sample => sample.timeS > 700).every(sample =>
    Math.abs(sample.rotorSpeedRadPerSec / RPM - 5) < 1e-4 && sample.generatorTorqueNm > 0), "recovers positive generation at 5 rpm after gust");

  // Repeatable disturbances within the development envelope; no rated crossing.
  const disturbed = createBelowRatedScenario({ name: "below-rated turbulence", totalTimeS: 120, dtS: dt,
    wind: { mode: "turbulent", meanWindSpeedMps: 5, turbulenceIntensity: 0.06, lowPassTimeConstantSec: 4, seed: 12345 },
    params, aeroTable: table, config });
  const first = runSimulationScenario({ scenario: disturbed.scenario, params, aeroTable: table });
  const repeat = runSimulationScenario({ scenario: disturbed.scenario, params, aeroTable: table });
  checkActuator(first);
  assert(first.samples.some(sample => Math.abs(sample.collectivePitchRad - first.samples[0].collectivePitchRad) > 0.001), "pitch responds to low-wind turbulence");
  assert(JSON.stringify(first.samples) === JSON.stringify(repeat.samples), "repeatable disturbance and controller response");
  console.table(rows);
  console.log("Below-rated torque PI validation passed.", {
    steadyScenarios: 24, maximumTrackingErrorRpm,
    fixedZeroPitchInfeasibility: infeasible.operatingPoint.reason,
    nearRatedInfeasibility: insufficient.operatingPoint.reason,
    nearRatedRequiredTorqueMNm: insufficient.operatingPoint.aero.torqueNm / 1e6,
  });
}
