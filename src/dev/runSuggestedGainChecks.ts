import { loadAeroTable } from "../sim/aero";
import { createCoordinatedControllerConfig, createCoordinatedScenario } from "../sim/coordinated";
import type { CoordinatedControllerConfig } from "../sim/coordinatedController";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import { runSimulationScenario } from "../sim/simulation";
import { SUGGESTED_OPERATING_POINT_GAINS, SUGGESTED_REFERENCE_GAINS, withFixedControllerGains, type FixedControllerGains } from "../sim/suggestedGains";
import type { WindDisturbanceConfig } from "../sim/wind";

const RPM = Math.PI / 30;
const DEG = Math.PI / 180;
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Suggested gains: ${message}`);
}

/** A local-model experiment, not a certification of physical turbine stability.
 * Every run uses one fixed combination, even across multiple operating points.
 */
export async function runSuggestedGainChecks(sweep = false): Promise<void> {
  const params = DEFAULT_TUNABLE_PARAMETERS;
  const table = await loadAeroTable(params.aero.filePath);
  const reference = createCoordinatedControllerConfig(params, table);
  let scenarioCount = 0;

  function run(config: CoordinatedControllerConfig, name: string, wind: WindDisturbanceConfig,
    duration = 900, perturbation = 0, dtS = 0.02) {
    const { scenario, operatingPoint } = createCoordinatedScenario({ name, wind, totalTimeS: duration, dtS,
      params, aeroTable: table, config });
    if (perturbation !== 0) {
      // Disturb the physical state; retain the equilibrium controller states.
      scenario.initialState!.rotorSpeedRadPerSec = operatingPoint.rotorSpeedRadPerSec * (1 + perturbation * 0.05);
      scenario.initialState!.platformPitchRad = operatingPoint.platformPitchRad + perturbation * DEG;
    }
    const configBefore = JSON.stringify(config);
    const result = runSimulationScenario({ scenario, params, aeroTable: table });
    assert(JSON.stringify(config) === configBefore, "wind/region changes must never rewrite selected gains");
    let squareError = 0, maxErrorRpm = 0, tailErrorRpm = 0, tailPlatformRateDegS = 0;
    let maxPlatformDeviationDeg = 0, pitchTravelDeg = 0, torqueTravelMNm = 0;
    const winds: number[] = [];
    for (let i = 1; i < result.samples.length; i++) {
      const a = result.samples[i], b = result.samples[i - 1], d = a.controllerDiagnostics;
      assert(d?.strategy === "coordinated-tsr-pi", "coordinated diagnostics");
      for (const group of [a, d.pitch, d.torque, d.smoother]) {
        assert(Object.values(group).every(v => typeof v !== "number" || Number.isFinite(v)), "finite response");
      }
      const err = (a.rotorSpeedRadPerSec - d.smoother.baseTorqueSpeedRefRadPerSec) / RPM;
      squareError += err * err;
      maxErrorRpm = Math.max(maxErrorRpm, Math.abs(err));
      maxPlatformDeviationDeg = Math.max(maxPlatformDeviationDeg, Math.abs(a.platformPitchRad - operatingPoint.platformPitchRad) / DEG);
      if (a.timeS > duration - 100) {
        tailErrorRpm = Math.max(tailErrorRpm, Math.abs(err));
        tailPlatformRateDegS = Math.max(tailPlatformRateDegS, Math.abs(a.platformPitchRateRadPerSec) / DEG);
      }
      pitchTravelDeg += Math.abs(a.collectivePitchRad - b.collectivePitchRad) / DEG;
      torqueTravelMNm += Math.abs(a.generatorTorqueNm - b.generatorTorqueNm) / 1e6;
      assert(a.generatorTorqueNm >= config.torque.minTorqueNm && a.generatorTorqueNm <= config.torque.maxTorqueNm + 1e-8, "torque bounds");
      assert(Math.abs(a.generatorTorqueNm - b.generatorTorqueNm) <= config.torque.maxTorqueRateNmPerSec * dtS + 1e-7, "torque slew");
      assert(a.collectivePitchRad >= config.pitch.minPitchRad && a.collectivePitchRad <= config.pitch.maxPitchRad, "pitch bounds");
      assert(Math.abs(a.collectivePitchRad - b.collectivePitchRad) <= config.pitch.maxPitchRateRadPerSec * dtS + 1e-12, "pitch slew");
      // Observe applied P terms as well as unchanged config: a hidden schedule
      // must not substitute gains internally when the wind moves to another row.
      assert(Math.abs(d.pitch.proportionalTermRad - config.pitch.pitchKp * d.pitch.rotorSpeedErrorRadPerSec) < 1e-12, "pitch Kp stays selected");
      assert(Math.abs(d.torque.proportionalTorqueNm - config.torque.kpNmsPerRad * d.torque.speedErrorRadPerSec) < 1e-7, "torque Kp stays selected");
      const previousDiagnostics = b.controllerDiagnostics;
      if (previousDiagnostics?.strategy === "coordinated-tsr-pi") {
        const expectedPitchI = previousDiagnostics.pitch.integralTermRad +
          (d.pitch.integralWasHeld ? 0 : config.pitch.pitchKi * d.pitch.rotorSpeedErrorRadPerSec * dtS);
        const expectedTorqueI = previousDiagnostics.torque.integralTorqueNm +
          (d.torque.integralWasHeld ? 0 : config.torque.kiNmPerRad * d.torque.speedErrorRadPerSec * dtS);
        assert(Math.abs(d.pitch.integralTermRad - expectedPitchI) < 1e-12, "pitch Ki stays selected");
        assert(Math.abs(d.torque.integralTorqueNm - expectedTorqueI) < 1e-7, "torque Ki stays selected");
      }
      assert(a.windSpeedMps >= 3 && a.windSpeedMps <= 25, "test stays within generating wind envelope without clipping");
      winds.push(a.windSpeedMps);
    }
    scenarioCount++;
    return { name, maxErrorRpm, rmsErrorRpm: Math.sqrt(squareError / (result.samples.length - 1)),
      tailErrorRpm, tailPlatformRateDegS, maxPlatformDeviationDeg, pitchTravelDeg, torqueTravelMNm, winds };
  }

  function settled(result: ReturnType<typeof run>) {
    assert(result.tailErrorRpm < 0.005, `${result.name}: final-100-s speed error below 0.005 rpm (${result.tailErrorRpm})`);
    assert(result.tailPlatformRateDegS < 0.002, `${result.name}: final-100-s platform rate below 0.002 deg/s (${result.tailPlatformRateDegS})`);
  }

  const rows = [];
  for (const suggested of SUGGESTED_OPERATING_POINT_GAINS) {
    const wind = suggested.operatingWindMps;
    const config = withFixedControllerGains(reference, suggested.gains);
    const cases = [];
    for (const sign of [-1, 1]) {
      // Check both the conservative reference and the manually selected row.
      settled(run(reference, `reference ${wind}, perturbation ${sign}`, { mode: "constant", meanWindSpeedMps: wind }, 900, sign));
      const perturbed = run(config, `${suggested.label}, perturbation ${sign}`, { mode: "constant", meanWindSpeedMps: wind }, 900, sign);
      settled(perturbed);
      cases.push(perturbed);
      // Do not simulate unsupported wind beyond either generating boundary.
      if ((wind === 3 && sign < 0) || (wind === 25 && sign > 0)) continue;
      const gust = run(config, `${suggested.label}, gust ${sign}`, { mode: "gust", meanWindSpeedMps: wind,
        gustAmplitudeMps: sign, gustStartTimeSec: 50, gustDurationSec: 200 });
      settled(gust);
      cases.push(gust);
    }
    let turbulentRmsRpm: number | null = null; // Boundary points have no turbulence test.
    if (wind > 3 && wind < 25) {
      for (const seed of [12345, 67890]) {
        const noisy = run(config, `${suggested.label}, turbulence ${seed}`, { mode: "turbulent", meanWindSpeedMps: wind,
          turbulenceIntensity: 0.04, lowPassTimeConstantSec: 20, seed }, 600);
        // Sustained disturbance tracking is not a settling test.
        assert(noisy.maxErrorRpm < 1.5, `${suggested.label}: disturbance excursion below 1.5 rpm`);
        turbulentRmsRpm = Math.max(turbulentRmsRpm ?? 0, noisy.rmsErrorRpm);
      }
    }
    rows.push({ windMps: wind, pitchKpS: suggested.gains.pitchKpS, pitchKi: suggested.gains.pitchKi,
      floatingGainS: suggested.gains.platformPitchRateGainS,
      worstRecoveryErrorRpm: Math.max(...cases.map(c => c.tailErrorRpm)),
      maxTransientErrorRpm: Math.max(...cases.map(c => c.maxErrorRpm)),
      maxPlatformDeviationDeg: Math.max(...cases.map(c => c.maxPlatformDeviationDeg)), turbulentRmsRpm });
  }

  const crossing: WindDisturbanceConfig = { mode: "gust", meanWindSpeedMps: 13,
    gustAmplitudeMps: -4, gustStartTimeSec: 100, gustDurationSec: 800 };
  const old = run(withFixedControllerGains(reference, { ...SUGGESTED_REFERENCE_GAINS, pitchKpS: 1.5, pitchKi: 0.05 }), "previous reference", crossing, 1600);
  const improved = run(reference, "SUGGESTED fixed reference", crossing, 1600);
  settled(improved);
  assert(old.winds.every((v, i) => v === improved.winds[i]), "identical wind for reference comparison");
  assert(improved.tailErrorRpm < old.tailErrorRpm / 100 && improved.pitchTravelDeg < old.pitchTravelDeg,
    "fixed reference resolves previously observed growing oscillation");
  const fine = run(reference, "SUGGESTED reference half dt", crossing, 1600, 0, 0.01);
  settled(fine);
  assert(Math.abs(fine.maxErrorRpm - improved.maxErrorRpm) < 0.01, "time-step check for reference transient");
  const rise: WindDisturbanceConfig = { ...crossing, meanWindSpeedMps: 9, gustAmplitudeMps: 4 };
  settled(run(reference, "SUGGESTED reference upward crossing", rise, 1600));

  // A student's arbitrary combination is retained exactly; the catalog is not
  // a whitelist. This test crosses multiple listed wind points with that choice.
  const custom: FixedControllerGains = { ...SUGGESTED_REFERENCE_GAINS, pitchKpS: 0.73, pitchKi: 0.018,
    torqueKpNmsPerRad: 47e6, torqueKiNmPerRad: 2e6, torqueReferenceShiftGain: 0.7, pitchReferenceShiftGain: 0.002,
    floatingFeedbackEnabled: true, platformPitchRateGainS: 7 };
  const customConfig = withFixedControllerGains(reference, custom);
  assert(customConfig.pitch.pitchKp === custom.pitchKpS && reference.pitch.pitchKp === SUGGESTED_REFERENCE_GAINS.pitchKpS, "explicit selection does not mutate reference");
  run(customConfig, "student-selected constants", rise, 1600);

  const turbulentRows = [];
  let comparisonWind: number[] | undefined;
  for (const [name, kp, ki, fb] of [["SUGGESTED reference", 0.6, 0.015, 0],
    ["SUGGESTED near rated", 0.8, 0.02, 10], ["SUGGESTED at 15 m/s, tested near rated", 1, 0.03, 10]] as const) {
    const cfg = withFixedControllerGains(reference, { ...SUGGESTED_REFERENCE_GAINS,
      pitchKpS: kp, pitchKi: ki, floatingFeedbackEnabled: fb > 0, platformPitchRateGainS: fb });
    const r = run(cfg, name, { mode: "turbulent", meanWindSpeedMps: 10.5,
      turbulenceIntensity: 0.08, lowPassTimeConstantSec: 20, seed: 12345 }, 1200);
    assert(r.maxErrorRpm < 1.5, "bounded reference turbulent crossing response");
    if (comparisonWind) assert(r.winds.every((v, i) => v === comparisonWind![i]), "identical turbulence between chosen combinations");
    comparisonWind = r.winds;
    turbulentRows.push({ name, rmsErrorRpm: r.rmsErrorRpm, maxErrorRpm: r.maxErrorRpm,
      platformDeviationDeg: r.maxPlatformDeviationDeg, pitchTravelDeg: r.pitchTravelDeg, torqueTravelMNm: r.torqueTravelMNm });
  }

  console.table(rows);
  console.table([old, improved, fine].map(({ name, tailErrorRpm, maxErrorRpm, maxPlatformDeviationDeg, pitchTravelDeg }) =>
    ({ name, tailErrorRpm, maxErrorRpm, maxPlatformDeviationDeg, pitchTravelDeg })));
  console.table(turbulentRows);

  if (sweep) {
    // Reproducible optional exploration; prints trade-offs and never overwrites
    // the suggestion catalog or applies a winning row to the running app.
    const candidates = [[0.3, 0.005, 0], [0.5, 0.01, 0], [0.6, 0.015, 0], [0.8, 0.02, 0],
      [1, 0.03, 0], [0.8, 0.02, 10], [1, 0.03, 10], [1.5, 0.05, 5], [1.5, 0.05, 10]];
    const sweepRows = [];
    for (const [pitchKpS, pitchKi, fb] of candidates) {
      const cfg = withFixedControllerGains(reference, { ...SUGGESTED_REFERENCE_GAINS, pitchKpS, pitchKi,
        floatingFeedbackEnabled: fb > 0, platformPitchRateGainS: fb });
      for (const wind of [10.5, 12, 18, 25]) {
        const r = run(cfg, "manual fixed-gain sweep", { mode: "constant", meanWindSpeedMps: wind }, 900, 1);
        sweepRows.push({ wind, pitchKpS, pitchKi, floatingGainS: fb, tailErrorRpm: r.tailErrorRpm,
          maxErrorRpm: r.maxErrorRpm, platformDeviationDeg: r.maxPlatformDeviationDeg, pitchTravelDeg: r.pitchTravelDeg });
      }
    }
    console.table(sweepRows);
  }
  console.log("Suggested fixed-gain checks passed; no gain scheduling.", { scenarioCount });
}
