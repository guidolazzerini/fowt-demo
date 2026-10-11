# Floating Offshore Wind Turbine Browser Demo

An educational simulator for exploring floating-wind turbine dynamics and manually
chosen controller gains. React and TypeScript provide the interface; a Web Worker
runs the same turbine controller used by the offline scenario checks.

The model combines steady aerodynamic lookup tables, rigid rotor-speed dynamics,
and one platform-pitch degree of freedom. It is not a high-fidelity
aero-hydro-servo-elastic solver or a validated physical-turbine controller.

## Run locally

Use Node.js 22.12+ (or another version supported by the installed Vite; this
checkout was checked with Node 24.14.1 and npm 11.11.0).

```bash
npm ci
npm run dev
```

Open the URL printed by Vite. Dependencies must be installed for the current
operating system; do not copy or commit `node_modules`.

To try coordinated generating operation:

1. In **Control strategy**, select **Coordinated TSR PI**.
2. In **Gains**, select **Fixed reference** and click **Apply SUGGESTED gains**.
   Merely selecting a suggestion does not apply it. Switching strategies retains
   the current gains, including the legacy defaults on a fresh page.
3. In **Environment**, choose Constant wind at 5 m/s. Click **Reset**, then **Start**.
4. Expect approximately 5 rpm, 2.994 MN m generator torque and 1.568 MW generator
   mechanical power at this equilibrium. Try 18 m/s after Reset: approximately
   7.55 rpm, 18.972 MN m and 15 MW mechanical power.
5. Open **Controller diagnostics** when needed. Use the information disclosures
   for explanations; the default dashboard stays compact.

To start from rest, select **Simple startup / shutdown · Reset to parked** in
Control strategy, then Reset and **Start turbine**. **Shut down turbine** runs
a physical stopping sequence. The original Start/Stop buttons still control
the simulation clock. This optional model is described [below](#simple-startup-and-shutdown).

## User review guide

Download the [three-page user checks and experiments](docs/fowt-user-checks.pdf):
startup, wind dips, turbulence, live gains, Chrome memory, smoothing and floating feedback.
Times are simulated seconds except the 20-minute browser memory check.

To regenerate the PDF with a Python environment containing matplotlib:
`python scripts/create-user-guide.py`. This is a documentation utility, not an app dependency.

## Controller modes and operating range

| Mode | Supported free-stream wind | Control behavior |
|---|---|---|
| Legacy above-rated (initial selection) | 10–20 m/s | Pitch PI, fixed 7.55 rpm reference and constant rated generator torque |
| Coordinated TSR PI | 3–25 m/s | TSR-tracking torque PI and pitch PI, IEA low-wind pitch floor, optional ROSCO set-point smoothing |

Both coordinated loops run through transition. Their references are coordinated
by the smoother rather than a hard wind-speed switch. Above rated, the operating
strategy is **constant torque**. Constant-power control and `K * Omega^2` torque
control are future stages.

The base torque speed reference is
`clamp(9.5 * filtered_wind / 120, 5 rpm, 7.55 rpm)`, evaluated in rad/s internally.
The default wind signal is **simulated free-stream wind**. In **Control strategy**,
you can instead select **COFLEX estimated rotor-effective wind** for coordinated
generating control. Both use the same first-order 5 s filter for the torque
reference and low-wind pitch floor. Aerodynamics use actual rotor-effective wind,
accounting for platform inclination and motion.

### COFLEX wind estimate and selectable control input

**Controller diagnostics** now compares a COFLEX estimate with actual rotor-effective
wind and simulated free-stream wind. The observer uses rotor speed, applied pitch
and rotor-side generator torque, with the existing 3D Cp table. It does not receive
the simulated wind or aerodynamic torque. Selecting it for control applies live,
preserving the wind realization, controller/filter states and all gains. Legacy
pitch control is unaffected. Startup/loading and protection retain their existing
simulated signals. Held/limited estimates remain selected, with no automatic
fallback to simulated wind; invalid/unavailable selected input stops with an error.

Generating Reset still uses the simulated equilibrium for the physical state and
controller preload, including the wind filter. Startup handover retains its
existing filtered wind. Afterward the filter follows the selected input; the
estimator itself always starts from its independent guess.

In **Gains**, estimator Kp/Ki apply live; **Initial wind estimate** applies on Reset.
Estimator Ki may be zero; Kp must remain positive (UI minimum 0.01 m/rad).
Ki = 0 removes the integral contribution. Switching to it adjusts the internal
speed estimate to preserve the current wind output, without keeping a hidden bias.
Defaults are fixed demonstrator suggestions: Kp = 100 m/rad, Ki = 5 m/(rad s),
initial guess = 8 m/s. There is no automatic gain scheduling. The estimate is held
during startup/shutdown and outside the table's speed/pitch range. Poor initial
guesses or gains can fail to converge; `tracking` is not an accuracy guarantee.
See [equations and limitations](docs/coflex-wind-estimator.md) and
[closed-loop results and browser checks](docs/estimated-wind-control.md).

The low-wind pitch floor uses the published IEA 15 MW schedule's low-wind branch;
near-rated thrust peak shaving is not included. It permits positive generating
torque at 3 m/s with the 5 rpm reference. The minimum is a **speed-reference
constraint**, not a clamp on physical rotor speed: transient speed can fall below
5 rpm, and target TSR is not achievable at every constrained operating point.
See [pitch-schedule provenance and checks](docs/step4-below-rated.md).

Coordinated Reset solves rotor speed, pitch, torque, platform static deflection,
and controller states together. Infeasible actuator limits block Start. Legacy
Reset uses rated speed and the selected initial collective pitch; its running
pitch bias remains the fixed 4.10 degrees, clamped to pitch limits.

### Boundaries

Wind input accepts 0–30 m/s to allow boundary experiments. This does not expand
the supported generating ranges. Wind fluctuations are not clipped at cut-in
or cut-out (the disturbance model retains a nonnegative-wind floor).

With the startup/shutdown option **off**, crossing the selected strategy's range pauses at the last supported physical
state and shows **Unsupported operation**. The displayed wind may be the
out-of-range value that triggered the pause. Start remains blocked until Reset
with wind at least 0.2 m/s inside the range: 3.2–24.8 m/s for coordinated mode,
10.2–19.8 m/s for legacy. A fresh, untripped run may initialize at the endpoints.
There is no automatic restart. Leaving the aerodynamic table also pauses the run.

The current table covers approximately 2–27 m/s, 2–17 rpm and −5 to 30 degrees
pitch. Pausing at a boundary is a model-validity guard, not simulated shutdown.
With the option **on**, averaged torque supervision and separate filtered storm protection control the approximate sequence below.

## Simple startup and shutdown

This is an optional **coordinated-mode** teaching model. Reset parks at 0 rpm,
90° pitch and zero generator torque. **Start turbine** arms a request and runs
the clock, waiting for a full 20 s torque assessment. There is no automatic
restart after shutdown unless you arm another request. **Shut down turbine**
also cancels a waiting request.

- **Torque supervision:** startup requires a 20 s mean available torque ≥0.080 MN m.
  This capability proxy uses simulated rotor-effective wind, 5 rpm and scheduled
  generating pitch: parked, feathered actual torque is zero. During generation,
  shutdown requires the signed actual aerodynamic torque mean <0.040 MN m over
  20 s. A full 20 seconds of generating data is required after handover. Startup
  aborts if available torque's 20-second mean falls below the same stop threshold.
  Short wind dips across 3 m/s no longer trigger a shutdown.
- **Free-wheel:** zero generator load; rate-limited pitch seeks driving torque
  within the table's generating pitch range. Higher pitch can help at low speed,
  but full feather removes driving torque.
- **Load and capture:** after 0.5 s above 4.75 rpm, apply generator load with a
  20 s smooth ramp. Model-based pitch control approaches the generating speed
  with a 10 s capture time constant. Within 1% speed error for 2 s, hand over to
  the student's PI gains with matched controller states. Each startup stage has
  a 1,200 s timeout; unfavorable limits/disturbances may prevent startup.
- **Shutdown:** slew pitch toward 90° at up to 2°/s (or a slower user rate limit),
  ramp generator torque to zero at up to 2 MN m/s, and coast down. Apply a
  0.5 MN m parking brake only below 0.2 rpm with pitch at least 85°. Brake torque
  is separate from generator torque and cannot reverse the rotor.
- **Other triggers:** manual Shut down turbine, speed exceeding 120% rated,
  startup timeout, or storm wind (100 s exponential average) above 25 m/s.
  Storm protection clears below or at 23 m/s. It is separate because controlled
  aerodynamic torque cannot identify high wind reliably.
  Start/Stop of the simulation clock remains separate from these physical actions.

The sequence follows the free-wheel/loading and pitch-to-feather ideas in the
[ROSCO examples](https://rosco.readthedocs.io/en/latest/source/examples.html).
Averaging and storm hysteresis are inspired by the
[Vestas Extended Cut Out technical description](https://www.vestas.com/content/dam/vestas-com/global/en/brochures/product-improvements/ECO_case_study.pdf.coredownload.inline.pdf).
The 20 s torque rule and 0.080/0.040 MN m thresholds are our demonstrator choices,
not a documented Vestas torque algorithm. Diagnostics show both torque means,
observed durations and storm-filter output. Averaging buffers remain private to
the simulation runner, with bounded storage; pauses preserve them and Reset clears them.
The low-speed/feather aerodynamics, capture law, rates, thresholds and brake
strength are explicit demonstrator assumptions, **not validated IEA 15 MW data**.
Below 2 rpm, driving torque scales from 30% of the lowest-speed table value at
rest to 100% at 2 rpm. Above 30° pitch it blends to zero driving torque, a 20 s
aerodynamic coasting time constant and residual parked Ct = 0.02. Transient
aerodynamic power is torque × speed: zero at rest, negative during braking.

The approximation is limited to 0–30 m/s free-stream **and rotor-effective** wind
and the table's maximum rotor speed. Short generating excursions outside the
lookup wind/speed bounds use the explicitly flagged transient approximation.
Exceeding the 30 m/s/model-speed limit stops with an error; it does
not support arbitrary extreme storms, grid-loss faults or emergency-stop load
prediction. Pitch may exceed the generating limit during startup/shutdown, up
to 90°. Motoring, electrical conversion, realistic friction and brake heating
are not modeled. See [research, equations and validation](docs/startup-shutdown.md).

## Student gains and live settings

**There is no automatic gain scheduling.** SUGGESTED values are optional starting
points, applied only by the student's explicit action. Wind and operating-region
changes never select or overwrite gains. Arbitrary combinations may oscillate or
become unstable; observing that behavior is part of the demonstrator.

The coordinated fixed reference uses:

| Setting | Value | Units shown in the UI |
|---|---:|---|
| Torque Kp | 50.4 | MN m s/rad |
| Torque Ki | 2.24 | MN m/rad |
| Pitch Kp | 0.60 | s |
| Pitch Ki | 0.015 | dimensionless |
| Torque-reference smoothing gain | 1 | dimensionless |
| Pitch-reference smoothing gain | 0.001 | dimensionless |
| Floating feedback | Off | gain 0 s |

Legacy starts with pitch gains 1.50 / 0.05. Suggestions for individual operating
points and their tracking/motion trade-offs are documented in
[the fixed-gain experiments](docs/step5a-suggested-gains.md).

| Change | When it applies |
|---|---|
| Pitch/torque gains, active smoothing settings, floating feedback | Live; wind realization and filter history are preserved |
| Active wind settings | Live; reconfigures the wind process at the current simulation time |
| Wind settings irrelevant to the selected wind mode | No effect on the current wind process |
| Strategy | Pauses; requires Reset; retains student gains |
| Startup/shutdown option | Pauses; requires Reset; enabled only for coordinated mode |
| Pitch limits or pitch rate limit | Coordinated: pauses and requires Reset. Legacy: live |
| Initial collective pitch | Legacy: next Reset only; inactive in coordinated mode |
| Tabs, information disclosures, diagnostics visibility | View only; preserve simulation and wind state |

For torque/pitch controllers with positive Ki, gain changes adjust integral state to preserve the current
command as far as practical. Ki = 0 explicitly clears the corresponding integral;
actuator rate limits constrain the resulting adjustment. Floating-feedback gain
has units of seconds; the platform-rate filter is fixed at 0.2 Hz.

The browser's random wind uses seed 12345 and a 2.5 s disturbance-filter time
constant. Reset repeats that realization with the same settings and timestep.
Gust start time is absolute simulation time; negative amplitude produces a dip.

## Units, limits and plots

Positive rotor-side generator torque brakes the rotor:
`J * dOmega/dt = aerodynamic_torque - generator_torque`.
Positive speed error increases braking torque or feathering pitch.

The normal operating torque cap is 18.972112 MN m; the separate absolute actuator
ceiling is 20 MN m. Coordinated torque slew is limited to 2 MN m/s. Default pitch
limits are 0–30 degrees and 5 degrees/s. Speed references, torque limits and filter
constants are read-only in the browser; pitch limits and gains are editable.
The smoother's pitch normalization is the reference cut-out operating pitch
(approximately 22.898 degrees), not the editable actuator limit. See
[the smoother implementation notes](docs/step5-setpoint-smoother.md).

The power plot distinguishes aerodynamic table power from generator mechanical
power `T_generator * Omega_rotor`, using rotor-side torque and speed from the same
sample. There is no efficiency model: **neither trace is electrical power**.
Rotor acceleration and independent table interpolation can make the traces differ.

Detailed diagnostics include both speed references, both TSR definitions, target
TSR, torque, pitch demand/contributions, smoothing offsets and limit indicators.
Unavailable signals show gaps/N/A. History is bounded to 90 simulated seconds and
600 posted samples. At default settings, each post spans 16 integration steps
(0.32 simulated seconds); brief limit events between posts can be missed.
See [diagnostic definitions and browser checks](docs/step8-diagnostics.md).

## Validation

```bash
npm run check:all
npm run lint
npm run build
npm run preview
```

`check:all` runs these commands sequentially and stops on failure:

| Command | Main coverage |
|---|---|
| `check:live-settings` | Wind continuity, retuning/zero Ki, legacy regression, worker/offline parity, six original simulation suites |
| `check:below-rated` | IEA pitch floor, torque PI, feasible equilibria and steady-state checks |
| `check:smoothing` | Smoother equations, slow/turbulent crossings, identical-disturbance comparisons |
| `check:suggested-gains` | 74 fixed-gain scenarios, recovery, gusts, turbulence, manual suggestions; optional `-- --sweep` adds comparisons |
| `check:browser-range` | Actual worker message handling, generating boundaries, initialization, 1600 s crossings, 1200 s turbulent smoothing comparisons, live edits and strategy changes |
| `check:controls` | React static markup, tab/input contracts, diagnostic conversions and compact SVG paths |
| `check:startup-shutdown` | Six startup/generating/shutdown cycles, actuator slew, parking brake, boundary aborts, power signs and timestep sensitivity |
| `check:wind-estimator` | COFLEX equations and comparison isolation; estimated-wind control at 3–25 m/s, transitions, turbulence, startup and timestep checks |

Worker tests use a deterministic manual clock. Static React tests verify markup;
they do **not** test browser clicks, rendering performance or Chrome memory.
The historical smoother suite deliberately retains a poorly damped old gain
combination and reports its oscillation; this is distinct from the suggested
fixed reference. Passing tests do not guarantee all student gains are stable.

`build` includes TypeScript checking and generates `dist`; preview normally serves
it at http://localhost:4173. To preserve an existing `dist`, use
`npm run build -- --outDir .step9-preview.local` and
`npm run preview -- --outDir .step9-preview.local --host 127.0.0.1` instead.
With preview running, use `npm run check:preview` in a second terminal to check
HTTP responses, MIME types, the bundled worker and aerodynamic JSON. An optional
URL can be supplied with `-- http://127.0.0.1:4173/`. This smoke check expects the
current root-hosted production build and does not execute the browser UI.

**Current validation status:** the automated suites, lint and production build
pass. Interactive production-browser review remains outstanding because the
available browser automation connection failed. Chrome previously ran out of
memory with diagnostics expanded. Compact SVG rendering has been applied, and
closed-panel runs were reported stable, but a successful long open-panel run has
not yet been confirmed. See [Step 9's review checklist](docs/step9-validation.md).

## Architecture

| Location | Responsibility |
|---|---|
| `src/main.tsx` → `src/App.tsx` → `src/ui/SimulationDashboard.tsx` | Active application entry and dashboard |
| `src/app/useSimulation.ts` | One worker, settings/status and bounded plot history |
| `src/sim/simulationWorker.ts` | Browser stepping, live changes, Reset and operating guards |
| `src/sim/turbineController.ts` | Shared entry point for worker and offline controller stepping |
| `src/sim/controller.ts`, `torqueController.ts`, `coordinatedController.ts`, `setpointSmoother.ts` | Pitch PI, torque PI and coordinated references |
| `src/sim/belowRatedPitch.ts`, `suggestedGains.ts` | Low-wind pitch schedule and manually applied gain catalog |
| `src/sim/model.ts`, `aero.ts`, `wind.ts` | Rotor/platform physics, aerodynamic interpolation and disturbances |
| `src/sim/windEstimator.ts` | Shared COFLEX observer and explicit control-input selection |
| `src/sim/simulation.ts`, `src/dev/`, `scripts/` | Offline scenarios and repeatable checks |
| `src/sim/settingRanges.ts` | Numeric ranges shared by controls and worker validation |
| `public/iea15mw-aero-v1.json` | Aerodynamic lookup data, copied into the build |

Stage documents record decisions at that stage; this README describes the current
integrated behavior. The model has no blade/tower flexibility, full hydrodynamics,
or electrical conversion model; default wave forcing is zero. The legacy
crossover estimate excludes platform coupling and is unavailable for coordinated
control. No automatic gain scheduling is planned.

## Deployment

Live simulator: **https://fowt-demo.netlify.app/**.

Netlify deploys pushes to `main` in `guidolazzerini/fowt-demo`. The existing
`netlify.toml` uses `npm run build`, publishes `dist`, and selects Node.js 22.
No repository relinking was needed for the reviewed release (`b613bc4`).
The live app, CSS, simulation worker and aerodynamic JSON were verified against
the locally validated production build. Interactive Chrome and long-run memory
checks remain the user-review procedure in the PDF guide.

Before later releases, run `npm run check:all`, `npm run lint` and the production
build. After deployment, run:

```bash
npm run check:preview -- https://fowt-demo.netlify.app/
```

This verifies assets and MIME types; it does not replace browser testing.

Future control stages may separately add `K * Omega^2` torque control,
constant-power above-rated operation or advanced control features.
