import { loadAeroTable } from "../sim/aero";
import { createCoordinatedControllerConfig, createCoordinatedScenario } from "../sim/coordinated";
import { createCoordinatedControllerState, stepCoordinatedController, type CoordinatedControllerConfig } from "../sim/coordinatedController";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import { smoothSetpoints } from "../sim/setpointSmoother";
import { runSimulationScenario, type SimulationScenarioResult } from "../sim/simulation";
import type { WindDisturbanceConfig } from "../sim/wind";
import { SUGGESTED_REFERENCE_GAINS } from "../sim/suggestedGains";

const RPM = Math.PI / 30;
const DEG = Math.PI / 180;
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Set-point smoother: ${message}`);
}
function close(actual: number, expected: number, tolerance = 1e-12) {
  assert(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

export async function runSetpointSmootherChecks(): Promise<void> {
  const params = DEFAULT_TUNABLE_PARAMETERS;
  const table = await loadAeroTable(params.aero.filePath);
  // Preserve the original Step 5 comparison, including its known oscillation.
  // New suggested fixed gains are checked separately by check:suggested-gains.
  const config = createCoordinatedControllerConfig(params, table,
    { ...SUGGESTED_REFERENCE_GAINS, pitchKpS: 1.5, pitchKi: 0.05 });
  const input = { baseTorqueSpeedRefRadPerSec: 0.75, ratedSpeedRadPerSec: 0.8,
    pitchRad: 0.1, minimumPitchRad: 0.02, generatorTorqueNm: 10e6, normalTorqueCapNm: 20e6 };
  const gains = { enabled: true, torqueReferenceShiftGain: 1, pitchReferenceShiftGain: 0.1, pitchAtCutOutRad: 0.4 };
  const positive = smoothSetpoints(input, gains);
  close(positive.offsetRadPerSec, 0.12);
  close(positive.torqueSpeedRefRadPerSec, 0.63);
  close(positive.pitchSpeedRefRadPerSec, 0.8);
  const negative = smoothSetpoints({ ...input, pitchRad: input.minimumPitchRad }, gains);
  close(negative.offsetRadPerSec, -0.04);
  close(negative.pitchSpeedRefRadPerSec, 0.84);
  close(negative.torqueSpeedRefRadPerSec, 0.75);
  const zero = smoothSetpoints({ ...input, pitchRad: input.minimumPitchRad, generatorTorqueNm: input.normalTorqueCapNm }, gains);
  close(zero.offsetRadPerSec, 0);
  const disabled = smoothSetpoints(input, { ...gains, enabled: false });
  close(disabled.offsetRadPerSec, 0);
  close(disabled.rawOffsetRadPerSec, positive.rawOffsetRadPerSec);
  close(disabled.torqueSpeedRefRadPerSec, input.baseTorqueSpeedRefRadPerSec);
  close(disabled.pitchSpeedRefRadPerSec, input.ratedSpeedRadPerSec);

  // Changing spare actuator authority must not change Eq. (48) normalization.
  const changedActuator = createCoordinatedControllerConfig({ ...params, maxGeneratorTorqueNm: 25e6, maxPitchRad: 28 * DEG }, table);
  close(changedActuator.smoother.pitchAtCutOutRad, config.smoother.pitchAtCutOutRad);
  close(changedActuator.torque.maxTorqueNm, config.torque.maxTorqueNm);
  assert(config.smoother.pitchAtCutOutRad < config.pitch.maxPitchRad, "cut-out pitch differs from actuator maximum");

  function run(name: string, wind: WindDisturbanceConfig, totalTimeS: number, cfg = config, dtS = 0.02) {
    const { scenario } = createCoordinatedScenario({ name, totalTimeS, dtS, wind, params, aeroTable: table, config: cfg });
    return runSimulationScenario({ scenario, params, aeroTable: table });
  }

  function check(result: SimulationScenarioResult, cfg: CoordinatedControllerConfig) {
    let overlapS = 0, torqueTravelMNm = 0, pitchTravelDeg = 0, maxOverspeedRpm = 0;
    let positiveOffsets = 0, negativeOffsets = 0, capSamples = 0, floorSamples = 0, windCrossings = 0;
    let tailErrorRpm = 0;
    for (let i = 1; i < result.samples.length; i++) {
      const a = result.samples[i], b = result.samples[i - 1];
      const d = a.controllerDiagnostics;
      assert(d?.strategy === "coordinated-tsr-pi", "coordinated diagnostics available");
      for (const group of [a, d.pitch, d.torque, d.smoother]) {
        assert(Object.values(group).every(v => typeof v !== "number" || Number.isFinite(v)), "finite outputs and diagnostics");
      }
      assert(a.generatorTorqueNm >= cfg.torque.minTorqueNm && a.generatorTorqueNm <= cfg.torque.maxTorqueNm + 1e-8, "normal torque bounds");
      assert(a.generatorTorqueNm <= cfg.absoluteTorqueLimitNm, "absolute torque bound");
      assert(a.collectivePitchRad >= d.minimumPitchRad - 1e-12 && a.collectivePitchRad <= cfg.pitch.maxPitchRad, "pitch bounds");
      assert(Math.abs(a.generatorTorqueNm - b.generatorTorqueNm) <= cfg.torque.maxTorqueRateNmPerSec * result.scenario.dtS + 1e-7, "torque rate bound");
      assert(Math.abs(a.collectivePitchRad - b.collectivePitchRad) <= cfg.pitch.maxPitchRateRadPerSec * result.scenario.dtS + 1e-12, "pitch rate bound");
      close(d.torque.speedRefRadPerSec, d.smoother.torqueSpeedRefRadPerSec);
      close(d.pitch.rotorSpeedErrorRadPerSec, b.rotorSpeedRadPerSec - d.smoother.pitchSpeedRefRadPerSec);
      // Reconstruct Eq. (48) from PREVIOUS applied commands, not new demands.
      const previousFloor = b.controllerDiagnostics?.strategy === "coordinated-tsr-pi" ? b.controllerDiagnostics.minimumPitchRad :
        result.scenario.controller.mode === "coordinated-tsr-pi" ? result.scenario.controller.initialControllerState.minimumPitchRad : NaN;
      close(d.smoother.rawOffsetRadPerSec, ((b.collectivePitchRad - previousFloor) / cfg.smoother.pitchAtCutOutRad * cfg.smoother.torqueReferenceShiftGain -
        (cfg.torque.maxTorqueNm - b.generatorTorqueNm) / cfg.torque.maxTorqueNm * cfg.smoother.pitchReferenceShiftGain) * cfg.torque.ratedRotorSpeedRadPerSec);
      if (!cfg.smoother.enabled) close(d.smoother.offsetRadPerSec, 0);
      if (d.smoother.offsetRadPerSec > 1e-8) positiveOffsets++;
      if (d.smoother.offsetRadPerSec < -1e-8) negativeOffsets++;
      if (d.torqueAtOperatingCap) capSamples++;
      if (d.pitchAtMinimum) floorSamples++;
      // Explicit practical overlap metric: torque >1% below cap while pitch
      // exceeds its floor by >0.1 degree. It is not a physical operating region.
      if (a.generatorTorqueNm < 0.99 * cfg.torque.maxTorqueNm && a.collectivePitchRad > d.minimumPitchRad + 0.1 * DEG) overlapS += result.scenario.dtS;
      torqueTravelMNm += Math.abs(a.generatorTorqueNm - b.generatorTorqueNm) / 1e6;
      pitchTravelDeg += Math.abs(a.collectivePitchRad - b.collectivePitchRad) / DEG;
      maxOverspeedRpm = Math.max(maxOverspeedRpm, (a.rotorSpeedRadPerSec - cfg.torque.ratedRotorSpeedRadPerSec) / RPM);
      if ((a.windSpeedMps - 10.5) * (b.windSpeedMps - 10.5) < 0) windCrossings++;
      if (a.timeS > result.scenario.totalTimeS - 100) tailErrorRpm = Math.max(tailErrorRpm, Math.abs(a.rotorSpeedRadPerSec - d.smoother.baseTorqueSpeedRefRadPerSec) / RPM);
    }
    return { overlapS, torqueTravelMNm, pitchTravelDeg, maxOverspeedRpm, tailErrorRpm,
      positiveOffsets, negativeOffsets, capSamples, floorSamples, windCrossings };
  }

  // Initialized equilibria: schedule at low wind, constant normal torque above
  // rated, and no artificial speed clamp or switch based on wind speed.
  for (const wind of [3, 8, 10, 12, 18, 25]) {
    const result = run(`equilibrium ${wind}`, { mode: "constant", meanWindSpeedMps: wind }, 120);
    check(result, config);
    const first = result.samples[0];
    for (const sample of result.samples) {
      close(sample.rotorSpeedRadPerSec, first.rotorSpeedRadPerSec, 1e-8);
      if (wind >= 12) close(sample.generatorTorqueNm, config.torque.maxTorqueNm, 1e-5);
    }
  }

  // Smoother enable/disable must not reset either integrator or floating filter.
  // Verify each accepted integral update remains either the old value or the
  // ordinary error*dt update, including sustained saturation and recovery.
  let state = createCoordinatedControllerState(config, { windMps: 12, rotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec,
    pitchRad: 0.1, torqueNm: config.torque.maxTorqueNm });
  for (let i = 0; i < 1500; i++) {
    const cfg = { ...config, smoother: { ...config.smoother, enabled: i < 500 || i >= 1000 } };
    const step = stepCoordinatedController(state, { controlWindMps: 12,
      rotorSpeedRadPerSec: i < 500 ? 1 : i < 1000 ? 0.4 : params.ratedRotorSpeedRadPerSec,
      platformPitchRateRadPerSec: 0.002 }, cfg, 0.02);
    const pd = step.diagnostics.pitch, td = step.diagnostics.torque;
    close(step.state.pitch.integralErrorRad, state.pitch.integralErrorRad + (pd.integralWasHeld ? 0 : pd.rotorSpeedErrorRadPerSec * 0.02));
    close(step.state.torque.integralTorqueNm, state.torque.integralTorqueNm + (td.integralWasHeld ? 0 : td.speedErrorRadPerSec * cfg.torque.kiNmPerRad * 0.02), 1e-7);
    close(step.state.pitch.timeS, state.pitch.timeS + 0.02);
    state = step.state;
  }

  // A rapidly rising scheduled minimum must not bypass the pitch slew limiter.
  const fastWindConfig = { ...config, torque: { ...config.torque, windFilterTimeConstantS: 0 } };
  const lowPitch = createCoordinatedControllerState(fastWindConfig, { windMps: 8, rotorSpeedRadPerSec: 5 * RPM, pitchRad: 0, torqueNm: 0 });
  const fallingWind = stepCoordinatedController(lowPitch, { controlWindMps: 3,
    rotorSpeedRadPerSec: 5 * RPM, platformPitchRateRadPerSec: 0 }, fastWindConfig, 0.02);
  close(fallingWind.control.collectivePitchRad, config.pitch.maxPitchRateRadPerSec * 0.02);
  assert(fallingWind.diagnostics.minimumPitchRad < fallingWind.diagnostics.scheduledMinimumPitchRad,
    "moving pitch floor is limited to reachable actuator position");
  const zeroKi = { ...config, torque: { ...config.torque, kiNmPerRad: 0 }, pitch: { ...config.pitch, pitchKi: 0 } };
  const cleared = stepCoordinatedController(state, { controlWindMps: 12,
    rotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec, platformPitchRateRadPerSec: 0 }, zeroKi, 0.02);
  close(cleared.state.pitch.integralErrorRad, 0);
  close(cleared.state.torque.integralTorqueNm, 0);

  const cases: { name: string; wind: WindDisturbanceConfig; duration: number }[] = [
    { name: "slow 9-13-9", duration: 1600, wind: { mode: "gust", meanWindSpeedMps: 9, gustAmplitudeMps: 4, gustStartTimeSec: 100, gustDurationSec: 800 } },
    { name: "slow 13-9-13", duration: 1600, wind: { mode: "gust", meanWindSpeedMps: 13, gustAmplitudeMps: -4, gustStartTimeSec: 100, gustDurationSec: 800 } },
    { name: "repeated turbulent crossings", duration: 1200, wind: { mode: "turbulent", meanWindSpeedMps: 10.5, turbulenceIntensity: 0.08, lowPassTimeConstantSec: 20, seed: 12345 } },
  ];
  const rows = [];
  for (const floating of [false, true]) {
    for (const spec of cases) {
      const active = { ...config, pitch: { ...config.pitch, floatingFeedbackEnabled: floating, platformPitchRateGainS: floating ? 10 : 0 } };
      const inactive = { ...active, smoother: { ...active.smoother, enabled: false } };
      const off = run(spec.name, spec.wind, spec.duration, inactive);
      const on = run(spec.name, spec.wind, spec.duration, active);
      assert(off.samples.every((s, i) => s.windSpeedMps === on.samples[i].windSpeedMps), "identical disturbances with smoothing on/off");
      const offStats = check(off, inactive), onStats = check(on, active);
      assert(onStats.positiveOffsets > 0 && onStats.negativeOffsets > 0, "both offset signs exercised");
      assert(onStats.capSamples > 0 && onStats.floorSamples > 0, "both operating constraints exercised");
      assert(onStats.overlapS < offStats.overlapS, "smoother reduces simultaneous loop activity");
      if (spec.wind.mode === "turbulent") assert(onStats.windCrossings > 10, "repeated near-rated turbulent crossings");
      if (floating && spec.wind.mode === "gust") assert(onStats.tailErrorRpm < 1e-3, "returns to steady operation with floating feedback");
      if (!floating && spec.name === "slow 13-9-13") {
        const finer = run(spec.name, spec.wind, spec.duration, active, 0.01);
        const finerStats = check(finer, active);
        close(finerStats.tailErrorRpm, onStats.tailErrorRpm, 0.02);
        if (onStats.tailErrorRpm > 0.05) console.warn("HISTORICAL STEP 5: original pitch gains 1.50 / 0.05 with feedback off leave above-rated oscillation; these are not the new suggested defaults.",
          { tailErrorRpm: onStats.tailErrorRpm, halfTimeStepTailErrorRpm: finerStats.tailErrorRpm });
      }
      for (const [enabled, stats] of [[false, offStats], [true, onStats]] as const) {
        rows.push({ scenario: spec.name, floating, smoothing: enabled, overlapS: stats.overlapS,
          torqueTravelMNm: stats.torqueTravelMNm, pitchTravelDeg: stats.pitchTravelDeg,
          maxOverspeedRpm: stats.maxOverspeedRpm, tailErrorRpm: stats.tailErrorRpm });
      }
    }
  }
  console.table(rows);
  console.log("Set-point smoother checks passed.", { pitchAtCutOutDeg: config.smoother.pitchAtCutOutRad / DEG,
    normalTorqueCapMNm: config.torque.maxTorqueNm / 1e6, absoluteTorqueLimitMNm: config.absoluteTorqueLimitNm / 1e6 });
}
