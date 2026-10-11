# COFLEX wind estimator

The initial comparison stage is now extended with a selectable control input.
See [closed-loop validation and usage](estimated-wind-control.md).

The observer follows [Lazzerini et al. (2025), Section 5.1, Eq. (10)](https://wes.copernicus.org/articles/10/1303/2025/index.html#section5).
It estimates **rotor-effective wind**, using the existing three-dimensional
`Cp(rotor speed, wind speed, pitch)` table. This implements the estimator equations;
it does not import the paper's HAWCStab2 tables or reproduce its flexible-turbine validation.

## Equations and signals

```text
Q_a_hat = rho * pi * R² * V_hat³ * Cp(omega, V_hat, beta) / (2 * omega)
d(omega_hat)/dt = (Q_a_hat - Q_g) / J
e = omega - omega_hat
V_hat = Kp * e + xi
d(xi)/dt = Ki * e
```

`omega` is measured rotor speed [rad/s], `beta` applied collective pitch [rad],
`Q_g` applied generator torque [N m], positive when braking. All torque and inertia
are rotor-side. The paper's mechanical-efficiency factor is 1 here, consistent
with the plant's lossless drivetrain. The Cp lookup and denominator use **measured**
speed, not estimated speed. No actual wind, aerodynamic torque or differentiated
rotor acceleration enters the observer.

Each completed physics interval supplies its applied pitch/torque and new speed.
The observer predicts speed using the preceding measured speed and estimated wind,
then updates the PI estimate with the new speed error. This first-order discrete
scheme is shared by worker and offline runner. Default dt is 0.02 s.

With Ki > 0, Reset initializes predicted speed to measured speed and the wind integral to an
independent 8 m/s guess. Fixed suggested gains are Kp = 100 m/rad and
Ki = 5 m/(rad s), selected for this demonstrator, **not reported COFLEX paper gains**.
The user can change both: **Kp > 0, Ki >= 0** (UI Kp minimum 0.01 m/rad).
With positive Ki, live gain changes shift the integral contribution to preserve
the current estimate before the next step.

With **Ki = 0**, the integral contribution is exactly zero and the output is
`V_hat = clamp(Kp * (omega - omega_hat), 2, 27)`. On Reset, entering Ki = 0,
changing Kp while Ki = 0, or holding outside supported operation, the speed
observer is initialized/recentered as `omega_hat = omega - V_hat / Kp`. This
preserves the wind guess or current output without a residual integral bias.
Re-enabling Ki matches the integral contribution to the current output. The
rotor-speed observer still integrates its torque-balance equation in both modes;
its predicted speed need not equal measured speed at steady state with Ki = 0.

## Scope and guards

- Simulated free-stream wind remains the default controller input. Coordinated
  generating control can instead use the COFLEX estimate through the same 5 s
  filter. Controller gains, startup/loading, torque supervision and storm
  protection are unchanged. Selection applies live without resets. Held/limited
  estimates stay selected; unavailable/nonfinite selected inputs stop the run.
- Estimated wind is bounded to the table's 2–27 m/s domain. Conditional integration
  prevents the PI integral from pushing farther into a bound. `limited` includes
  rejected integral updates at a bound; it does not diagnose the cause.
- Outside generating operation or the table's 2–17 rpm / −5–30° pitch domain,
  the observer holds its last wind estimate and recenters predicted speed.
  These samples show `held` and gaps in the estimate trace. This avoids Cp/omega
  at standstill and avoids pretending the feather approximation is valid Cp data.
- `tracking` means the observer is updating, not that its estimate is accurate.
  There is no guaranteed convergence for arbitrary gains or initial guesses.
  A known example is 3 m/s operation initialized with a 20 m/s wind guess:
  the estimate remains near the lower bound after 300 s. Reset with the default
  guess recovers in the tested case. No hidden truth-based reset is applied.
- The plant interpolates Cq for torque independently of Cp. The observer uses Cp
  as in the paper, so interpolation creates a small steady bias. Using essentially
  the same aerodynamic model for plant and observer also makes this an optimistic
  validation. Sensor noise, parameter uncertainty and flexible-rotor dynamics
  have not been validated. Transient-approximation operation outside the plant's
  generating table is not validated for wind estimation.
- The observer stores four scalars. Plots use the existing bounded 600-sample
  history and are rendered only when diagnostics are open.

## Comparison-mode checks

Run `npm run check:wind-estimator`, or all suites with `npm run check:all`.

With the fixed reference controller gains and estimator defaults:

| Test | Result |
|---|---|
| Constant 3, 5, 8, 10.5, 12, 18, 25 m/s; 300 s each | Final-100-s REWS RMSE below 0.008 m/s |
| 2 m/s, 100 s gust at 8 / 18 m/s | RMSE 0.017 / 0.018 m/s after initial 100 s |
| Turbulence at 8 / 18 m/s; TI 6%, seed 12345, 2.5 s disturbance filter | RMSE 0.235 / 0.467 m/s after initial 100 s |
| Observer enabled/disabled in dynamic cases | Every physical/controller/disturbance sample identical |
| Initial guesses 12 → 3 and 3 → 25 m/s, dt 0.01 / 0.02 s | Final error below 0.03 m/s at 300 s |

Additional checks cover equation signs, bounds and recovery, integral handling,
invalid inputs, live gain changes without wind resets, Reset-only initial guess,
exact worker/offline agreement, startup hold and generating resumption.
These are automated model/worker/markup checks, not interactive Chrome tests.

## Browser review

1. Run `npm run dev` and open the printed local URL. Choose **Coordinated TSR PI**,
   apply **Fixed reference** suggested controller gains, and leave startup/shutdown
   off for the first comparison.
2. Select Constant wind at 5 m/s. Keep the estimator's initial guess at 8 m/s.
   **Reset → Start → Show diagnostics**. Observe the estimate converge toward
   **Actual rotor-effective wind**. Repeat at 18 m/s; allow 300 simulated seconds.
3. At 8 or 18 m/s, select Random wind with TI 0.06, then Reset and Start.
   Compare the three traces: the estimate should follow rotor-effective wind
   with dynamic lag. Platform motion can separate it from free-stream wind.
4. Change estimator Kp/Ki in **Gains** while running. The wind realization and
   turbine control continue. In simulated-wind mode only the observer response
   changes; with estimated wind selected, gains also affect the control loop. Try Kp 50 / Ki 2
   against the defaults using Reset for repeatable comparisons. These are experiments,
   not guaranteed optimal gains.
5. Change **Initial wind estimate** while running: it takes effect only after
   Reset. Restore 8 m/s before other tests. Use 3 m/s wind and a 20 m/s guess to
   reproduce the documented limiting case.
6. Enable simple startup/shutdown and Reset. Start the turbine: the observer
   shows `held` through startup, resumes after generating handover, and holds
   again during shutdown. Expand/collapse diagnostics and check Stop/Start resume.

Interactive browser review remains outstanding because the browser automation
connection failed in this environment. In particular, the earlier Chrome memory
issue still warrants an extended run with diagnostics open.

Further validation could add sensor noise and aerodynamic/inertia uncertainty;
those are not modeled by the current tests.

## Changed files

| Files | Change |
|---|---|
| `src/sim/windEstimator.ts` | New shared observer and diagnostic types |
| `src/sim/simulation.ts`, `src/sim/simulationWorker.ts` | Offline opt-in and browser comparison stepping |
| `src/sim/workerMessages.ts`, `src/sim/settingRanges.ts` | Estimator settings, defaults and shared bounds |
| `src/ui/ControlsPanel.tsx`, `src/ui/ControllerDiagnostics.tsx` | Manual estimator gains, initial guess, comparison plot and status |
| `scripts/check-wind-estimator.mjs` | New estimator validation suite |
| `scripts/check-browser-range.mjs`, `scripts/check-live-settings.mjs`, `scripts/check-diagnostics.mjs` | Worker parity, live edits, startup hold and display coverage |
| `package.json` | New check command included in check:all |
| `README.md`, `docs/coflex-wind-estimator.md` | User instructions, equations, evidence and limitations |
