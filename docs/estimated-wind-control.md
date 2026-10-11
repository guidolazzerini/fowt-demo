# Selectable COFLEX wind input

In **Control strategy → Controller wind input**, choose simulated free-stream wind
(the existing default) or COFLEX estimated rotor-effective wind. Selection applies
live to **Coordinated TSR PI**. Legacy pitch control has no wind-dependent reference,
so the selector is disabled there; the observer still runs for comparison.

## Control behavior

The selected wind passes through the existing 5 s first-order filter and drives
the TSR torque-speed reference and IEA low-wind pitch floor. Smoothing and both
PIs retain their states. Changing source does not recreate the wind, reset the
filter or alter any user gains. The filter smooths the input change; normal
pitch and torque rate limits still apply. No gain scheduling has been added.

Estimated control uses the last completed physics step's wind estimate, then the
observer updates after the next physical step. This keeps the feedback causal.
The raw selected input and its source are recorded in torque diagnostics; the UI
shows the source actually used by the latest applied control step, plus the
filtered control wind alongside the estimate and both simulated wind signals.

Generating Reset retains the existing simulated equilibrium and controller
preload, including its initial wind-filter value. At startup handover, the filter
retains the simulated wind used during loading. Subsequent generating steps feed
the chosen source into it. The **estimator** always starts from the separate
user guess (default 8 m/s); it never receives actual wind or aerodynamic torque.
These tests therefore validate generating control with the existing initialization,
not a fully wind-independent physical startup system.

Startup/loading, torque supervision, storm protection and model-envelope guards
keep their existing simulated signals. The observer holds during unsupported
speed/pitch conditions and non-generating phases. A held or table-limited estimate
remains selected in generating control: there is **no automatic truth-wind fallback**.
Invalid or unavailable selected wind produces an error. Diagnostics identify held
and limited conditions; neither `tracking` nor remaining inside bounds guarantees
accuracy. Poor estimator gains or guesses can produce poor turbine control too.

## Automated results

Use `npm run check:wind-estimator` for observer and closed-loop scenarios;
`npm run check:all` also covers worker switching, startup, markup and regressions.
Tests use the existing **Fixed reference** controller gains (pitch 0.60 / 0.015,
torque 50.4 / 2.24 in the UI's units), smoothing on, floating feedback off,
estimator Kp 100 m/rad and Ki 5 m/(rad s), independent 8 m/s guess and dt 0.02 s.
Gains remain fixed throughout each run.

The same 12-case matrix, startup checks and half-timestep crossing also pass with
**estimator Ki = 0, Kp = 100**. The largest slow-crossing peak is 8.138 rpm and
near-rated turbulent peak is 8.403 rpm. Live checks cover Ki 8 → 0 → 5, including
a Kp change while Ki is zero, at 8 and 18 m/s. Integral output is zero in this
mode; gain transfer preserves wind output by adjusting the speed-observer state.
Kp = 0 is rejected by the observer and clamped to 0.01 m/rad by the shared UI/worker
range. These checks do not establish stability for arbitrary positive Kp values.

| Scenario | Duration | Estimated-wind control result |
|---|---|---|
| Constant 3, 5, 8, 10.5, 12, 18, 25 m/s | 600 s each | Settled tracking; final-100-s wind RMSE below 0.008 m/s |
| Slow 9 → 13 → 9 m/s | 1600 s | Both regions reached; peak 8.137 rpm; final speed error below 0.001 rpm |
| Slow 13 → 9 → 13 m/s | 1600 s | Both regions reached; peak 8.104 rpm; final speed error below 0.001 rpm |
| Turbulence at 8 m/s | 600 s | Peak 6.611 rpm; final-100-s speed-reference RMS error 0.067 rpm |
| Turbulence near rated, 10.5 m/s | 600 s | Peak 8.402 rpm; final-100-s speed-reference RMS error 0.297 rpm |
| Turbulence at 18 m/s | 600 s | Peak 8.176 rpm; final-100-s speed-reference RMS error 0.209 rpm |
| Half-step slow 9 → 13 → 9 crossing, dt 0.01 s | 1600 s | Peak 8.138 rpm, within 0.01 rpm of dt 0.02 s |
| Startup at 3 / 18 m/s, then generating on estimate | 300 s generation after handover | No unintended shutdown; generating peaks 5.000 / 7.588 rpm |

Turbulence uses TI 6%, seed 12345 and a 2.5 s disturbance filter. Wind-estimation
RMSE after 100 s is approximately 0.237 / 0.286 / 0.465 m/s at 8 / 10.5 / 18 m/s.
All main scenarios check finite outputs, nonnegative rotor-side torque, actuator
amplitude/rate bounds, and exact use of the previous estimate. Paired simulated-
and estimated-input runs use identical disturbances; their turbine responses
need not match because their control input differs.

Worker checks cover both sources against the offline runner (900 matching samples),
live source changes in both directions at 8 / 18 m/s without wind resets, estimator
gain edits while controlling, and startup/held-estimate handover. Existing physical
shutdown checks also pass with estimated wind selected.

The fixed reference gains worked in these cases; there is no evidence here that
automatic gain scheduling is needed. Near-rated turbulent speed excursions remain
visible rather than being clipped (rated speed is 7.55 rpm). Other gains, stronger
turbulence, sensor noise or aerodynamic/inertia mismatch can give different results.
The model and observer share their aerodynamic data, so these are optimistic
simulation checks, not field validation. The 5 rpm minimum is a reference constraint,
not a physical rotor-speed clamp.

## Browser checks

1. Open the local app, select **Coordinated TSR PI**, and apply **Fixed reference**
   suggested controller gains. Keep estimator Kp = 100, Ki = 5 and initial guess = 8.
2. Choose Constant wind at 5 m/s, select **COFLEX estimated rotor-effective wind**,
   then Reset and Start. Open diagnostics: verify **Latest controller wind input**
   and the **Filtered controller wind** trace. Repeat at 8 and 18 m/s.
3. For an upward/downward crossing, use Gust, mean 9 m/s, amplitude +4 m/s,
   start 100 s, duration 800 s. Reset/Start and run for 1600 simulated seconds.
   Repeat with mean 13 m/s and amplitude −4 m/s.
4. Use Random wind at 10.5 m/s and TI 0.06. Switch the source live in both directions.
   Time and wind realization should continue. Reset separately with each source
   for comparisons using identical seeded disturbances.
5. Try manual estimator-gain changes while estimated control is active. They now
   affect turbine control as well as the displayed estimate. Restore defaults
   before comparing the reported reference results.
   To test proportional-only estimation, set **Estimator Ki** to **0** while
   keeping **Estimator Kp** at **100**, then restore Ki to **5**. Reset is not required.

Interactive Chrome review and an extended run with diagnostics open remain manual;
automated worker/React checks do not establish browser rendering or memory behavior.
No deployment is part of this change.

## Files changed for this stage

- `src/sim/windEstimator.ts`: shared explicit source selection; source-neutral observer status.
- `src/sim/workerMessages.ts`, `simulationWorker.ts`, `simulation.ts`: setting, validation and causal routing.
- `src/sim/torqueController.ts`, `coordinatedController.ts`, `turbineController.ts`: generic wind-input naming and source diagnostics.
- `src/sim/operatingSequence.ts`: selected generating input, unchanged startup/protection signals.
- `src/ui/ControlsPanel.tsx`, `ControllerDiagnostics.tsx`, `diagnosticSignals.ts`: selector, labels, filter trace and help.
- `scripts/check-estimated-wind-control.mjs`, `check-wind-estimator.mjs`: closed-loop matrix, timestep and startup tests.
- `scripts/check-browser-range.mjs`, `check-controls.mjs`, `check-diagnostics.mjs`: integration and display checks.
- `src/dev/runTorqueControllerChecks.ts`, `runSetpointSmootherChecks.ts`: updated wind-input contract in existing checks.
- `README.md`, `docs/coflex-wind-estimator.md`, this document: current behavior and validation.
