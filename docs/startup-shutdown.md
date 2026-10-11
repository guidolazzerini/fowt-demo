# Simple startup and shutdown

## Choice and research

Implemented as an optional coordinated-mode teaching sequence, preserving the
existing generating-only mode and all manually selected PI gains.

The [ROSCO startup example](https://rosco.readthedocs.io/en/latest/source/examples.html#startup)
uses unloaded free-wheeling followed by staged generator loading. Its
[shutdown example](https://rosco.readthedocs.io/en/latest/source/examples.html#shutdown)
uses prescribed pitch and torque rates. These motivate the sequence here, not
its numerical parameters. NREL's controller guidance also describes ordinary
[startup by pitching into the run position and shutdown by feathering](https://forums.nlr.gov/t/nrel-5mw-control-design-power-deviation/1905).

The supplied table covers 2–17 rpm and −5° to 30° pitch. It cannot validate
standstill torque, 90° feather drag, or shutdown loads. Increasing pitch can
help at low speed, but increasing it toward full feather eventually removes
driving torque. Startup therefore searches the supplied torque surface rather
than imposing a universally higher pitch.

The chosen sequence is a **simplified adaptation**, not the ROSCO implementation
or an IEA-certified startup/shutdown model. The model-based speed-capture phase
is our addition: an initial maximum-torque/free-wheel experiment oversped at
higher wind during PI handover. The capture phase resolves that in the tested
cases without changing the student's gains.

## Averaged operating supervision

The first version stopped immediately at 3/25 m/s. That caused nuisance stops
in below-rated turbulence. The revised supervisor uses an exact, time-weighted
trailing 20 s window (not an exponential torque filter):

- Start when mean **available** aerodynamic torque is at least 80 kN m.
  Evaluate capability at the 5 rpm minimum and scheduled generating pitch using
  simulated rotor-effective wind. Actual parked torque is zero and cannot be
  used to qualify a start. No wind estimator is claimed.
- In generation, stop when mean **actual signed** aerodynamic torque is below
  40 kN m. Require 20 s of generating observations first. During startup, use
  the available-torque mean for resource-loss aborts instead.
- A start request enters Waiting, automatically proceeding when qualified.
  Waiting can be cancelled with Shut down turbine. There is no spontaneous
  restart after a completed shutdown; the user must arm a new request.
- Preserve histories through live wind/gain changes and clock pauses; clear on
  Reset. Accumulators stay in runner-owned bounded buffers, never in plot history.

These torque thresholds provide hysteresis and allow the tested 3 m/s point;
they are teaching assumptions, not an OEM torque policy. There is no friction,
auxiliary power or economic minimum-output model to calibrate a real cut-in.

[Vestas' Extended Cut Out technical description, pp. 12–13](https://www.vestas.com/content/dam/vestas-com/global/en/brochures/product-improvements/ECO_case_study.pdf.coredownload.inline.pdf)
describes 100 s exponentially averaged wind and separate cut-out/re-cut-in
thresholds. Inspired by that approach, a separate storm interlock trips above
25 m/s filtered wind and clears at 23 m/s. The filter initializes at the first
observed wind (not fictitious calm). This remains necessary: regulated torque
alone cannot detect high-wind exposure. Overspeed and model-validity protection
remain immediate. This is not a full manufacturer protection system.

## Browser operation

The current production preview is **http://127.0.0.1:4174/** (the earlier Step 9
preview on 4173 is a separate, older build). To recreate this preview:

```bash
npm run build -- --outDir .startup-preview.local
npm run preview -- --outDir .startup-preview.local --host 127.0.0.1 --port 4174 --strictPort
```

1. Select **Coordinated TSR PI** and apply the SUGGESTED fixed reference, or choose
   your own gains. Select **Simple startup / shutdown · Reset to parked**.
2. Set Constant wind, initially 8 m/s, and **Reset**. Expect 0 rpm, 90° pitch and
   zero generator torque. This replaces equilibrium initialization only while
   the option is enabled.
3. Click **Start turbine**. The clock resumes automatically. Observe Waiting (20 s on a fresh Reset) → Starting:
   free-wheel → Starting: load ramp → the generating operating region.
4. Click **Shut down turbine**. Pitch moves toward 90°, generator torque unloads,
   then speed decays and the rotor parks. The clock keeps running, allowing wind
   and platform motion to continue. The parking brake is shown in diagnostics.
5. Use **Start turbine** again to restart without resetting time or wind.
   The request waits if torque is insufficient or the storm interlock is active.
   Diagnostics show the torque means, thresholds, observed durations and storm filter.
6. **Stop** still pauses the simulation clock and **Start** resumes it. These
   buttons do not feather, brake, or start the physical rotor.
7. Disable the option and Reset to restore the previous equilibrium initialization
   and generating-envelope pause behavior. Strategy/option/pitch-limit changes
   require Reset; gains remain student-owned.

During startup/shutdown the pitch can exceed the user-selected **generating**
limit, up to the fixed 90° feather angle. Startup respects the selected pitch slew
limit. Shutdown uses the smaller of that rate and 2°/s. This distinction appears
in the controls' information disclosure. The schematic gauge now includes 90°.

## Sequence and units

All torque is rotor-side [N m]. Positive generator and mechanical-brake torque
oppose positive rotor speed [rad/s]. Positive pitch is toward feather.

| State | Rule |
|---|---|
| Parked | Pitch 90°, generator torque 0; no automatic start |
| Waiting | Armed request, feathered rotor; full 20 s available-torque history and start threshold required |
| Starting/free-wheel | Generator unloaded; a 16-point search from the scheduled floor to the generating pitch limit finds maximum driving torque; applied pitch remains slew-limited |
| Loading/capture | Begins after speed ≥95% of the 5 rpm minimum reference for 0.5 s; a 20 s cubic ramp loads the generator; pitch captures the generating reference |
| Generating | Begins after loading completes and speed stays within 1% of reference for 2 s, with pitch inside generating bounds; existing shared PI controller takes over |
| Shutting down | Pitch toward 90° at ≤2°/s; generator unloads at ≤2 MN m/s; park once rotor is stopped, pitch is feathered and generator torque is zero |

The load target is the smaller of normal operating torque and nonnegative
aerodynamic torque at the reference speed and scheduled pitch floor. It uses the
current rotor-effective wind, with actuator slew still enforced. For ramp fraction
`x = clamp(elapsed / 20 s, 0, 1)`, load fraction is `x²(3 − 2x)`.

During capture, demand aerodynamic torque is

`Qa_requested = Q_generator + J * (Omega_reference - Omega) / 10 s`.

Pitch is found by bisection on the feather side of the torque peak. Unachievable
torque saturates at the available pitch range; there is no imposed acceleration
or artificial speed reset. The speed reference retains the existing 5 s filtered
simulated free-stream wind and 5–7.55 rpm clamp. The actual aero calculation uses
rotor-effective wind. Handover initializes the PI/filter states from the actual
commands and current motion. PI contributions remain unavailable during the
temporary sequence; the gains are used after handover, not automatically tuned.

Each of the two startup stages times out after 1,200 simulated seconds and
initiates shutdown. Other triggers are manual request, averaged low torque,
filtered storm wind, or speed above 120% rated. A trigger latches the stopping sequence, even if the wind subsequently
recovers. This is a normal controlled stop, not an emergency/grid-loss model.

Below 0.2 rpm and above 85° pitch, a parking brake supplies up to 0.5 MN m. Its
torque is capped at that needed to stop within the current step; it cannot drive
reverse rotation. The shared rotor equation becomes

`J * dOmega/dt = Qa - Q_generator - Q_parking_brake`.

The parking brake is distinct from generator torque and contributes no generator
mechanical power. Brake heat, wear, static-friction release and drivetrain
flexibility are not modeled.

## Explicit aerodynamic assumptions

`transientAerodynamics.ts` applies while waiting, starting, loading, stopping or
parked, and during generating excursions outside the lookup wind/speed bounds.
Diagnostics flag the approximation; in-table generation retains the original model.

- **Standstill:** evaluate the lowest-speed table slice (2 rpm) and multiply
  driving torque by `0.3 + 0.7 * clamp(Omega / Omega_table_min, 0, 1)`. The 30%
  standstill factor is an uncalibrated assumption; startup times depend on it.
- **Wind:** bound only the coefficient-lookup wind to the table, then scale loads
  with the square of actual wind. The approximation is explicitly restricted to
  0–30 m/s free-stream and rotor-effective wind, and rotor speed no higher than
  the table maximum. Exceeding these limits stops with a model-validity error.
- **Feather extension:** above the table's 30° endpoint use
  `f = smoothstep((pitch - 30°) / 60°)`, bounded to 0–1. Driving torque and table
  thrust fade with `1-f`. Add aerodynamic drag `-f * J * Omega / 20 s`, and blend
  thrust toward `Ct_parked = 0.02`. The 20 s viscous coasting time and residual Ct
  are phenomenological assumptions, not fitted IEA data.
- **Energy:** transient aerodynamic power is `Qa * Omega`, so torque can start
  a stationary rotor while power is zero at rest. Feather drag produces negative
  aerodynamic power. Generator mechanical power remains `Q_generator * Omega`.
  The normal table's independently interpolated power can differ slightly at
  handover. Neither trace is electrical power.

The model remains one platform-pitch DOF plus a rigid rotor. It is suitable for
sequence demonstrations, not validating shutdown loads, fatigue, extreme-storm
survival or turbine safety. Slow pitch rates, infeasible limits and arbitrary
student gains need not produce a successful startup or stable generation.

## Verification

Run `npm run check:startup-shutdown` for the shared sequence and
`npm run check:browser-range` for the actual worker message path. `check:all`
includes both, plus the earlier controller and UI regression checks.

Constant-wind checks use the fixed suggested gains, default limits and dt=0.02 s:

| Wind [m/s] | Startup to generating [s] | Shutdown to parked [s] |
|---:|---:|---:|
| 3 | 384.5 | 103.6 |
| 3.2 | 308.8 | 103.7 |
| 5 | 109.9 | 104.3 |
| 8 | 97.3 | 110.4 |
| 12 | 76.7 | 106.5 |
| 18 | 68.8 | 101.7 |
| 24.8 | 68.5 | 103.4 |

Every case also runs 300 s in generating mode before shutdown. These times are
outputs of this surrogate, not predictions for an actual IEA turbine.

Checks cover finite/nonnegative rotor speed; torque/pitch/slew bounds; brake
engagement only at low speed; exact partial-window/time-weighted averages;
bounded history at 0.005 s; waiting/cancellation; 10 s calm ride-through and
recovery; sustained calm shutdown; storm filtering/hysteresis; physical 24→26 m/s
short crossing and sustained-storm stop/restart blocking; overspeed;
zero power at rest; negative braking power; and a halved-step comparison.
Seeded turbulent startups followed by 300 s generation pass at 3.2, 8 and
18 m/s (TI 12%) and 24 m/s (TI 4%), seed 12345, disturbance filter 2.5 s.
Startup times including initial qualification are 299.2, 125.6, 67.5 and
66.7 s, respectively. A 24 m/s, TI 12% exploratory run exceeded the 30 m/s
model boundary; severe storms remain unsupported rather than wind-clipped.

The worker integration check compares 1,000 posted samples exactly to the shared
sequence, then exercises pause, physical shutdown/resume, parking, restart without
resetting time, preservation of averaging through live wind changes, waiting
and cancellation at zero wind, and restoring generating-only mode.
Static UI checks verify the physical action buttons and 90° schematic readout.

All seven suites in `npm run check:all`, lint, TypeScript and the production build
pass. The production HTTP smoke check passes for the HTML, app bundle, CSS,
worker bundle, favicon and complete aerodynamic table at port 4174. Build output
was written to ignored `.startup-preview.local`; existing `dist` was untouched.

Interactive browser inspection remains unverified: the browser-control setup
still fails. The previously reported Chrome diagnostic-panel memory problem
also remains unconfirmed as resolved. Use the browser procedure above to review.

## Files and scope

- `src/sim/operatingSupervisor.ts`, `operatingSequence.ts`, `transientAerodynamics.ts`: shared sequence and
  explicitly approximate transient loads.
- `src/sim/model.ts`: optional aerodynamic override and separate brake torque.
- `src/sim/simulationWorker.ts`, `workerMessages.ts`, `generatingEnvelope.ts`,
  `simulation.ts`, `src/app/useSimulation.ts`: sequence state, requests and samples.
- `src/ui/ControlsPanel.tsx`, `SimulationToolbar.tsx`, `ControllerDiagnostics.tsx`,
  `PlotPanel.tsx`, `FowtSchematic.tsx`: opt-in controls, status, brake/model label,
  power explanation and feathered pitch display.
- `scripts/check-startup-shutdown.mjs`, `check-browser-range.mjs`,
  `check-controls.mjs`, `package.json`: new sequence checks and integration coverage.
- `README.md` and this document: operation, research and limitations.

No dependency, gain-scheduling system, commit, push or deployment was added.
Netlify remains a separately authorized next action after review.
