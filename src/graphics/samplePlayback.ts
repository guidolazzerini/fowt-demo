import type { SimulationRunState } from "../app/useSimulation";
import type { SimulationScenarioSample } from "../sim/simulation";

export type DisplayPose = Pick<SimulationScenarioSample, "timeS" | "rotorAzimuthRad" |
  "rotorSpeedRadPerSec" | "collectivePitchRad" | "platformPitchRad" | "windSpeedMps">;
const TAU = 2 * Math.PI;
const GAP_MS = 500;
const MAX_BLEND_MS = 250;
const mix = (a: number, b: number, fraction: number) => a + (b - a) * fraction;

function poseOf(sample: DisplayPose): DisplayPose {
  const { timeS, rotorAzimuthRad, rotorSpeedRadPerSec, collectivePitchRad, platformPitchRad, windSpeedMps } = sample;
  const pose = { timeS, rotorAzimuthRad, rotorSpeedRadPerSec, collectivePitchRad, platformPitchRad, windSpeedMps };
  if (!Object.values(pose).every(Number.isFinite)) throw new Error("Non-finite 3D sample.");
  return pose;
}

// Display interpolation only. Two poses are retained, never a growing history.
// Simulation timestamps establish relative timing; arrival intervals measure the
// actual playback rate (normally ~3.2x, but not assumed). No physical integration.
export class SamplePlayback {
  private from?: DisplayPose;
  private to?: DisplayPose;
  private receivedMs = 0;
  private blendStartMs = 0;
  private blendDurationMs = 0;
  private runState: SimulationRunState = "loading";

  accept(sample: DisplayPose | undefined, runState: SimulationRunState, nowMs: number): void {
    const previousRunState = this.runState;
    this.runState = runState;
    if (sample === undefined) { this.from = this.to = undefined; return; }
    const next = poseOf(sample);
    // Reset/backward timestamps, first mount, Stop/error and resume all discard
    // interpolation history. Stop settles to the last RECEIVED physical pose.
    if (!this.to || runState !== "running" || previousRunState !== "running" ||
      next.timeS < this.to.timeS || nowMs - this.receivedMs > GAP_MS) {
      this.snap(next, nowMs);
      return;
    }
    if (next.timeS === this.to.timeS) {
      // Live settings/status can republish the same instant. Update its values
      // without inventing a time interval or resetting the measured cadence.
      next.rotorAzimuthRad += TAU * Math.round((this.to.rotorAzimuthRad - next.rotorAzimuthRad) / TAU);
      this.to = next;
      if (this.blendDurationMs === 0) this.from = next;
      return;
    }
    const simDeltaS = next.timeS - this.to.timeS;
    const arrivalDeltaMs = Math.max(1, nowMs - this.receivedMs);
    const displayed = this.read(nowMs)!;
    // The physical rotor cannot reverse. Endpoint speed * time is used ONLY to
    // disambiguate wrapped turns (large dt/steps settings can exceed pi or 2pi),
    // never to extrapolate rotation beyond the supplied endpoint azimuth.
    let wrappedDelta = ((next.rotorAzimuthRad - this.to.rotorAzimuthRad) % TAU + TAU) % TAU;
    // Round-off at a parked rotor after many turns must not invent a full turn.
    if (Math.min(wrappedDelta, TAU - wrappedDelta) < 1e-10) wrappedDelta = 0;
    const expectedDelta = Math.max(0, (next.rotorSpeedRadPerSec + this.to.rotorSpeedRadPerSec) / 2 * simDeltaS);
    const turns = Math.max(0, Math.round((expectedDelta - wrappedDelta) / TAU));
    next.rotorAzimuthRad = this.to.rotorAzimuthRad + wrappedDelta + turns * TAU;
    this.from = displayed;
    this.to = next;
    const measuredSimSPerMs = simDeltaS / arrivalDeltaMs;
    this.blendDurationMs = Math.min(MAX_BLEND_MS, Math.max(1, (next.timeS - displayed.timeS) / measuredSimSPerMs));
    this.blendStartMs = this.receivedMs = nowMs;
  }

  private snap(pose: DisplayPose, nowMs: number): void {
    this.from = this.to = pose;
    this.blendStartMs = this.receivedMs = nowMs;
    this.blendDurationMs = 0;
  }

  read(nowMs: number): DisplayPose | undefined {
    if (!this.from || !this.to) return undefined;
    const t = this.blendDurationMs === 0 ? 1 : Math.min(1, Math.max(0, (nowMs - this.blendStartMs) / this.blendDurationMs));
    return {
      timeS: mix(this.from.timeS, this.to.timeS, t),
      rotorAzimuthRad: mix(this.from.rotorAzimuthRad, this.to.rotorAzimuthRad, t),
      rotorSpeedRadPerSec: mix(this.from.rotorSpeedRadPerSec, this.to.rotorSpeedRadPerSec, t),
      collectivePitchRad: mix(this.from.collectivePitchRad, this.to.collectivePitchRad, t),
      platformPitchRad: mix(this.from.platformPitchRad, this.to.platformPitchRad, t),
      windSpeedMps: mix(this.from.windSpeedMps, this.to.windSpeedMps, t),
    };
  }

  isBlending(nowMs: number): boolean {
    return this.runState === "running" && nowMs < this.blendStartMs + this.blendDurationMs;
  }
}
