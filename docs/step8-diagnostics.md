# Step 8 — controller diagnostics and power

The default page retains its compact summary, schematic and five plot cards.
The power card now compares aerodynamic power and generator mechanical power.
A separate **Controller diagnostics → Show diagnostics** panel is collapsed by
default and does not prepare its extra charts until opened. Opening/closing it
only changes view state; it does not send settings or reset simulation history.

## Signals and conventions

The detailed panel shows the active strategy, selected strategy and current
operating region, followed by:

- Rotor speed overlaid with the torque and pitch controller references, in rpm.
- TSR using the torque controller's 5 s filtered simulated free-stream wind,
  its target TSR, and aerodynamic TSR using rotor-effective wind. Both TSRs
  use the same sampled rotor speed and 120 m radius. They intentionally differ
  when filtering or platform motion changes the wind signal.
- Applied generator torque, the normal operating cap (18.972112 MN m), and the
  separate absolute actuator ceiling (20 MN m). All torques are rotor-side.
- Applied pitch command, unlimited pitch demand, and the coordinated pitch floor.
- Proportional, integral, floating-feedback and bias contributions to pitch demand.
- Applied smoother offset and raw offset before the smoother enable switch.
- Latest-step pitch/torque saturation, rate limiting, integral-held decisions,
  and coordinated pitch-at-floor/torque-at-cap indicators.

Pitch values are shown in degrees, speeds and smoothing offsets in rpm, and
torques in MN m. The plotted pitch bias is reconstructed from the recorded
unlimited demand minus P, I and floating contributions. No current UI gain or
bias setting is substituted into historical samples. The floor is a constraint,
not another additive pitch contribution.

The raw smoothing offset can be nonzero while smoothing is disabled; applied
offset is then zero. Positive applied offset lowers the torque-loop speed
reference; negative offset raises the pitch-loop speed reference. References
are not visually clipped at minimum/rated speeds.

Unavailable signals show gaps and N/A/-- rather than invented zeros. Legacy
mode has a pitch reference and pitch diagnostics but no torque PI reference,
TSR target or smoother. Immediately after Reset there has not yet been a
controller step, so references/contributions/limit flags remain unavailable.
At the minimum/rated speed constraints, the TSR target need not be achieved.

### Power

Generator-side mechanical power is computed once through a shared UI helper:

`P_generator_mechanical [W] = T_generator [N m] × Omega_rotor [rad/s]`

It preserves the sign and uses torque and speed from the same displayed
physical sample. The simulation uses positive generator torque for braking.
There is no gearbox conversion or electrical-efficiency model. The new signal
is **not electrical power**.

Aerodynamic power retains its existing aerodynamic-table definition. The two
powers can differ during rotor acceleration; independently interpolated table
power and aerodynamic torque also need not agree exactly. This display does
not impose a false equality or modify the physics. Both powers and generator
torque are also available in **All values and 30 s statistics**.

### Sampling and rendering

The existing browser history remains bounded to 90 s / 600 posted samples.
Multi-line plots use a common axis per card, labeled legends, different colors
and dash patterns, and current values. Missing points break curves. A lone
sample is drawn as a point, not stretched into a fictitious constant history.
All retained posted points are drawn; no extra downsampling hides them.

Diagnostics describe the controller evaluation just before a physics step;
physical outputs in the sample describe the state after that step. The usual
integration timestep is 0.02 s; the default browser post interval is 16 steps,
or 0.32 simulated seconds. Limit indicators describe only the last included
controller step. **Brief saturation/rate-limit events between posted samples
can be missed**; these are not event-latched indicators or full-resolution logs.
Boundary stops keep the last supported physical outputs and diagnostics while
the existing wind display shows the triggering disturbance.

## Browser review

Use the local development URL (normally http://127.0.0.1:5173 after
`npm run dev`). Refresh once to load the new version; this restarts the run.

1. Confirm the diagnostics panel starts closed. The default power card should
   have labeled **Aerodynamic** and **Generator mechanical** traces.
2. Select Coordinated TSR PI, explicitly apply the SUGGESTED fixed reference,
   choose Constant 5 m/s, Reset and Start. Open diagnostics. Expect about 5 rpm,
   2.994 MN m torque and 1.568 MW generator mechanical power. The filtered-wind
   TSR is about 12.57, above the 9.5 target because of the 5 rpm minimum reference.
3. Stop, choose Constant 18 m/s, Reset and Start. Expect about 7.55 rpm and
   18.972 MN m generator torque (15 MW mechanical power). Inspect the pitch
   contributions and the shifted torque reference.
4. For a rated crossing use Gust, mean 9 m/s, amplitude +4 m/s, start 10 s,
   duration 120 s. Reset and Start. Watch references, torque, pitch floor and
   smoothing offset. Repeat with smoothing disabled after Reset for the same
   wind; the applied offset should be zero while raw offset can still vary.
5. Change gains manually while running, including Ki = 0. Observe applied
   commands and limit indicators. Open/close diagnostics and switch settings
   tabs; time and wind must continue without a reset.
6. Switch to legacy mode and Reset. Torque reference, target TSR and smoothing
   should be unavailable, while the pitch reference appears after Start.
7. Check **All values and 30 s statistics**, plot legends at narrow width, and
   the existing boundary-pause behavior. Required boundary messages remain in
   the always-visible run bar.

## Verification and remaining limitations

- `npm run check:controls` now includes diagnostic checks over **600 actual
  controller samples** from coordinated 3, 10.5 and 18 m/s cases plus legacy
  14 m/s. Checks cover units, torque×speed power and sign, both TSR definitions,
  speed references, pitch contribution sum, limit flags, smoothing disabled,
  legacy/Reset unavailable values, finite SVG output, missing-data gaps, distinct
  line styles, and the collapsed default.
- `npm run check:browser-range` and `npm run check:live-settings` pass, including
  worker/offline parity, rated crossings, live tuning, boundary behavior, legacy
  regression and all six original simulation suites.
- TypeScript, lint and production build pass. Build used temporary
  `.step8-build`, then removed it; existing dist was untouched.
- Interactive browser inspection remains unverified because the browser-control
  runtime fails during setup. React rendering/worker tests are not a substitute
  for manual visual and interaction checks.

No controller equations, gains, wind generation, worker protocol or physical
state evolution were changed in this stage. Gains remain manually selected.
No commit, push, Netlify change or deployment was performed.

## Files changed

- src/ui/ControllerDiagnostics.tsx — optional detailed view and latest-step flags.
- src/ui/diagnosticSignals.ts — documented conversions, mechanical power and plot gaps.
- src/ui/PlotPanel.tsx — shared multi-line plotting and power comparison.
- src/ui/StatusPanel.tsx — mechanical power and torque in expanded values.
- src/ui/SimulationDashboard.tsx — mount the optional diagnostic panel.
- src/index.css — legends and compact diagnostic status styling.
- scripts/check-diagnostics.mjs — focused signal and rendering checks.
- scripts/check-controls.mjs — run diagnostic checks with the existing loader.
- This document — definitions, limitations and review procedure.

Proposed next step: **Step 9 — integrated validation and README update**, only
after explicit instruction. Deployment remains a separate user decision.

## Chrome out-of-memory follow-up

The local Chrome run reportedly crashed near 509.8 simulated seconds with
diagnostics expanded; runs with diagnostics closed have been stable so far.
That implicates the expanded view but does not establish a memory-leak cause.
The retained history is already bounded to 90 s and at most 600 samples.

Rendering mitigation in `src/ui/PlotPanel.tsx`:

- Use compact SVG paths instead of polyline point lists. Round only drawing
  coordinates to 0.01 SVG units; retain every physical sample and missing-data gap.
- Keep axis node keys stable as values change, avoiding axis-node replacement.
- Skip rolling-statistics calculations when they are not displayed and remove
  a redundant copy of the finite values used for axis bounds.

`scripts/check-diagnostics.mjs` verifies 600 retained points, a one-sample peak,
coordinate rounding within 0.005 SVG units, trace strings below 9,000 characters,
missing-data gaps and single-point rendering. `npm run check:controls`, lint,
TypeScript and production build passed. The build used `.step8-render-build`
(removed after validation); existing `dist` was untouched.

These checks do not measure Chrome heap/native memory or prove the crash fixed.
Interactive browser verification remains blocked by the browser connection.
Reload the local app, repeat the same settings with diagnostics open, and run
past 1,000 simulated seconds. In Chrome Task Manager (Shift+Esc), observe the
simulator tab's memory at several times, then hide/reopen diagnostics and check
Stop and Reset. Report any repeated crash or sustained memory growth. This
follow-up changes no worker/controller behavior and does not start Step 9.
