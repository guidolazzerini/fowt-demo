import type { SimulationScenarioSample } from "../sim/simulation";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";

/** Rotor-side torque is positive when braking. T [N m] * omega [rad/s] is
 * generator-side mechanical power [W]; no efficiency/electrical model exists.
 * Use the two values from the same physical sample, including a frozen sample.
 */
export function generatorMechanicalPowerW(sample: SimulationScenarioSample): number {
  return sample.generatorTorqueNm * sample.rotorSpeedRadPerSec;
}

const RPM = 30 / Math.PI;
const DEG = 180 / Math.PI;
const radiusM = DEFAULT_TUNABLE_PARAMETERS.rotorRadiusM;
const unavailable = Number.NaN; // Plots leave a gap; readouts show "—".

export function diagnosticSignals(sample: SimulationScenarioSample) {
  const d = sample.controllerDiagnostics;
  const coordinated = d?.strategy === "coordinated-tsr-pi" ? d : undefined;
  const pitch = d?.strategy === "legacy-above-rated" ? d : coordinated?.pitch;
  const torque = d && d.strategy !== "legacy-above-rated" ? d.torque : undefined;
  const pitchRef = d?.strategy === "legacy-above-rated" ? d.pitchSpeedRefRadPerSec : coordinated?.smoother.pitchSpeedRefRadPerSec;
  const ratio = (wind: number | undefined) => wind !== undefined && wind > 1e-6 ?
    sample.rotorSpeedRadPerSec * radiusM / wind : unavailable;
  return {
    rotorRpm: sample.rotorSpeedRadPerSec * RPM,
    torqueRefRpm: torque ? torque.speedRefRadPerSec * RPM : unavailable,
    pitchRefRpm: pitchRef === undefined ? unavailable : pitchRef * RPM,
    // Compare TSR to its control target using the SAME filtered free-stream
    // signal as the torque loop. Aerodynamic TSR uses rotor-effective wind.
    controlTsr: ratio(torque?.filteredWindMps),
    aerodynamicTsr: ratio(sample.effectiveWindSpeedMps),
    targetTsr: torque?.targetTsr ?? unavailable,
    torqueMNm: sample.generatorTorqueNm / 1e6,
    pitchCommandDeg: sample.collectivePitchRad * DEG,
    pitchDemandDeg: pitch ? pitch.unsaturatedPitchDemandRad * DEG : unavailable,
    pitchPDeg: pitch ? pitch.proportionalTermRad * DEG : unavailable,
    pitchIDeg: pitch ? pitch.integralTermRad * DEG : unavailable,
    pitchFloatingDeg: pitch ? pitch.floatingPitchTermRad * DEG : unavailable,
    // Reconstruct the actual bias from the recorded demand, not current UI
    // settings (which may have changed since this historical sample).
    pitchBiasDeg: pitch ? (pitch.unsaturatedPitchDemandRad - pitch.proportionalTermRad -
      pitch.integralTermRad - pitch.floatingPitchTermRad) * DEG : unavailable,
    pitchFloorDeg: coordinated ? coordinated.minimumPitchRad * DEG : unavailable,
    smoothingOffsetRpm: coordinated ? coordinated.smoother.offsetRadPerSec * RPM : unavailable,
    rawSmoothingOffsetRpm: coordinated ? coordinated.smoother.rawOffsetRadPerSec * RPM : unavailable,
    pitchSaturated: pitch?.wasSaturated,
    pitchRateLimited: pitch?.wasRateLimited,
    pitchIntegralHeld: pitch?.integralWasHeld,
    torqueSaturated: torque?.wasSaturated,
    torqueRateLimited: torque?.wasRateLimited,
    torqueIntegralHeld: torque?.integralWasHeld,
    torqueAtCap: coordinated?.torqueAtOperatingCap,
    pitchAtFloor: coordinated?.pitchAtMinimum,
  };
}

export interface PlotPoint { timeS: number; value: number }

/** Missing diagnostics (Reset or an inactive loop) must break the line.
 * Keep every posted point: downsampling boolean events can hide brief limits.
 */
export function finitePlotSegments(points: PlotPoint[]): PlotPoint[][] {
  const segments: PlotPoint[][] = [];
  let segment: PlotPoint[] = [];
  for (const point of points) {
    if (Number.isFinite(point.timeS) && Number.isFinite(point.value)) segment.push(point);
    else if (segment.length) { segments.push(segment); segment = []; }
  }
  if (segment.length) segments.push(segment);
  return segments;
}
