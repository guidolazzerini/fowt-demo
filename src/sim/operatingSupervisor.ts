/** Supervisory decisions use simulated rotor-side torque [N m], positive when
 * driving the rotor. These teaching thresholds are not OEM/IEA specifications. */
export const TORQUE_WINDOW_S = 20;
export const START_TORQUE_NM = 80_000;
export const STOP_TORQUE_NM = 40_000;
export const STORM_FILTER_S = 100;

/** Exact time-weighted trailing window, including partial oldest timesteps.
 * Owned by the runner, never copied into plot samples or worker messages. */
export class TorqueWindow {
  private samples: { value: number; duration: number }[] = [];
  private head = 0;
  private duration = 0;
  private integral = 0;

  push(value: number, dtS: number) {
    if (!Number.isFinite(value) || !Number.isFinite(dtS) || dtS <= 0) throw new Error("Invalid torque averaging input");
    const duration = Math.min(dtS, TORQUE_WINDOW_S);
    this.samples.push({ value, duration });
    this.duration += duration;
    this.integral += value * duration;
    let excess = this.duration - TORQUE_WINDOW_S;
    while (excess > 1e-10) {
      const oldest = this.samples[this.head];
      const removed = Math.min(excess, oldest.duration);
      this.integral -= oldest.value * removed;
      this.duration -= removed;
      oldest.duration -= removed;
      excess -= removed;
      if (oldest.duration < 1e-10) this.head++;
    }
    // Amortized compaction keeps storage bounded in long browser runs.
    if (this.head >= 4096) { this.samples = this.samples.slice(this.head); this.head = 0; }
    return { meanNm: this.integral / this.duration, observedS: Math.min(TORQUE_WINDOW_S, this.duration) };
  }
}

export interface SupervisorDiagnostics {
  availableTorqueMeanNm: number;
  availableObservedS: number;
  aerodynamicTorqueMeanNm: number;
  generatingObservedS: number;
  stormWindMps: number;
  stormBlocked: boolean;
}

export class OperatingSupervisor {
  private available = new TorqueWindow();
  private actual = new TorqueWindow();
  private stormWind: number | undefined;
  private stormBlocked = false;

  step(actualTorqueNm: number, availableTorqueNm: number, generating: boolean,
    windMps: number, cutOutMps: number, dtS: number): SupervisorDiagnostics {
    const available = this.available.push(availableTorqueNm, dtS);
    // A fresh full 20 seconds of generating data is required after each handover.
    if (!generating) this.actual = new TorqueWindow();
    const actual = generating ? this.actual.push(actualTorqueNm, dtS) : { meanNm: 0, observedS: 0 };
    this.stormWind = this.stormWind === undefined ? windMps :
      this.stormWind + (-Math.expm1(-dtS / STORM_FILTER_S)) * (windMps - this.stormWind);
    // Separate storm protection: regulated torque cannot identify excessive wind.
    // Vestas-inspired 100 s exponential filter and 2 m/s restart hysteresis.
    if (this.stormWind > cutOutMps) this.stormBlocked = true;
    else if (this.stormWind <= cutOutMps - 2) this.stormBlocked = false;
    return { availableTorqueMeanNm: available.meanNm, availableObservedS: available.observedS,
      aerodynamicTorqueMeanNm: actual.meanNm, generatingObservedS: actual.observedS,
      stormWindMps: this.stormWind, stormBlocked: this.stormBlocked };
  }
}
