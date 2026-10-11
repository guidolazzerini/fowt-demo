# Step 6 — browser generating-range integration

The existing browser worker now offers **Coordinated TSR PI, 3–25 m/s**, alongside
**Legacy above-rated, 10–20 m/s**. The app still opens in legacy mode with its
original pitch gains. Selecting a strategy pauses and requires Reset, retaining
all user gain values. No gain scheduling or automatic selection of suggestions
has been added. Netlify configuration and deployment are unchanged.

## Try the local browser app

Run `npm run dev` in this repository and open the local URL printed by Vite
(normally http://localhost:5173). An existing server was responding at
http://127.0.0.1:5173 during implementation. A deployed Netlify URL will not show
these uncommitted local changes.

1. Choose **Coordinated TSR PI — 3–25 m/s** in Selected strategy.
2. Keep **SUGGESTED fixed reference** selected and press **Apply SUGGESTED gains**.
   This explicitly sets pitch Kp = 0.60 s, Ki = 0.015; torque Kp = 50.4 MN m s/rad,
   Ki = 2.24 MN m/rad; smoothing gains = 1 and 0.001; floating feedback off.
   Choosing a dropdown row alone does not apply it. Applying a row also sets its
   floating-feedback enable switch and gain; it does not enable/disable smoothing.
3. Choose Constant wind, set **5 m/s**, then **Reset**, then **Start**. Expect
   approximately 5 rpm, 2.847 degrees collective pitch, and 2.994 MN m generator
   torque. The region should show Below rated. Stop pauses time; Start resumes.
4. Stop, set **18 m/s**, Reset, Start. Expect about 7.55 rpm, 15.6 degrees pitch,
   and 18.972 MN m generator torque. The region should show Above rated.
   Reset is useful for comparing equilibria; live wind changes remain available
   for disturbance experiments.
5. Try Random wind at 12 m/s, TI = 0.06. Reset and Start, then edit pitch or torque
   gains, toggle smoothing, or apply another suggestion. Simulation time and the
   wind realization continue. Ki = 0 is allowed; a command adjustment can occur
   through the actuator rate limit when the integral is removed.
6. For a rated crossing, choose Gust, mean 9 m/s, amplitude +4 m/s, start 10 s,
   duration 120 s; Reset and Start. Repeat after Reset with smoothing disabled
   for the same wind history. Also try mean 13 m/s and amplitude −4 m/s. Gain
   values stay fixed through all region changes. The automated settling checks
   use slower 800 s gusts and run to 1600 s; a short gust is not a settling test.
7. For a boundary test, choose Gust, mean 24 m/s, amplitude +2 m/s, start 0 s,
   duration 10 s; Reset and Start. Wind crosses 25 m/s and the model pauses with
   **Unsupported operation**. Start remains blocked. Choose Constant wind at
   24.8 m/s and Reset to recover. The lower-bound counterpart is mean 4 m/s,
   amplitude −2 m/s; recover at Constant 3.2 m/s and Reset.

The current single controls panel is intentionally retained for this stage.
Tabs and additional diagnostic plots remain the subsequent steps.

## Behavior and model conventions

- Both torque and pitch loops run through the shared turbine-controller entry
  point. The set-point smoother coordinates them; region labels describe applied
  pitch/torque constraints and do not select a control loop.
- The torque reference uses simulated free-stream wind with a 5 s first-order
  filter, TSR target 9.5, and reference bounds of 5–7.55 rpm. This is not estimated
  wind. The aerodynamic model separately uses rotor-effective wind including
  platform motion and rotor tilt. Actual rotor speed can transiently dip below
  5 rpm; no artificial minimum-speed clamp is applied to the physical state.
- Reset solves rotor speed, scheduled or above-rated pitch, rotor-side generator
  torque, platform static deflection, and controller initial states together.
  The IEA low-wind pitch schedule makes positive generating torque possible at
  3 m/s with a 5 rpm reference. Legacy initial pitch is disabled in coordinated
  mode and affects neither live control nor coordinated Reset initialization.
- Positive generator torque brakes the rotor. Normal operating torque cap is
  18.972112 MN m, below the separate 20 MN m absolute actuator ceiling. The
  smoothing pitch normalization remains the reference cut-out operating pitch,
  approximately 22.898 degrees, independent of user pitch-limit edits.
- Live gain, smoothing and floating-feedback edits preserve the wind generator
  and filter histories. Positive-Ki retuning matches current actuator commands
  as far as practical. Setting Ki to zero explicitly clears that integral;
  subsequent commands remain rate limited. Only relevant active wind settings
  restart the wind process. Reset repeats the same seeded wind realization.
- Coordinated pitch-limit/rate-limit changes pause and require Reset so that a
  consistent generating equilibrium can be solved. An infeasible equilibrium
  blocks Start with an explanation. Legacy limit edits retain their live behavior.
- Mean wind input accepts 0–30 m/s for boundary experiments, but this is not an
  expanded operating envelope. Wind fluctuations are not clipped to 3 or 25 m/s
  (nor the legacy 10–20 range); the wind model retains its nonnegative-wind floor.
- Inclusive fresh initialization at 3 and 25 m/s is allowed. Crossing either limit
  latches a pause; explicit Reset then requires an inward 0.2 m/s margin
  (3.2–24.8 m/s, or 10.2–19.8 for legacy). There is no automatic restart/chatter.
  Rotor speed or rotor-effective wind leaving the aerodynamic table also stops
  the model. After a trip the display holds the last supported physical outputs
  and time, while exposing the triggering free-stream wind. Those frozen outputs
  are not a new aerodynamic solution at the out-of-range wind.
- Startup, motoring and feathered shutdown are unsupported. Arbitrary user
  gains can cause unstable behavior within the wind envelope; the table guard
  prevents continued integration beyond supported aerodynamic data.
- The legacy one-loop crossover estimate is marked inapplicable for coordinated
  control. Existing power plots still show aerodynamic power; generator-side
  mechanical-power presentation is reserved for the diagnostic-plot stage.

## Verification

Commands run successfully:

```text
npm run check:browser-range
npm run check:live-settings
npm run check:below-rated
npm run check:smoothing
npm run check:suggested-gains
npm run lint
npx tsc -b
npm run build -- --outDir .step6-build
```

The temporary build output was removed afterward; existing `dist` was untouched.
No new dependencies were installed. Concurrent older Vite check harnesses emitted
HMR-port-in-use messages; the checks do not use HMR and all exited successfully.

The new suite drives the **actual worker** through its message API with a manual
clock. It checks seven equilibrium winds from 3 to 25 m/s; 450 exact matches to
offline samples including controller diagnostics; Stop/Start/Reset; 1600 s rated
crossings in both directions with final-100-s speed error below 0.005 rpm; gain
retention; wind continuity; positive/zero-Ki transfer; smoothing/feedback edits;
both boundary trips and re-entry hysteresis; infeasible limits and recovery; and
an intentionally unregulated model stopped at aerodynamic data limits.

The legacy suite still reports zero difference over 4000 controller steps and
18000 scenario steps, plus 450 matching worker/offline samples and six original
simulation suites. Below-rated checks and historical smoother comparisons pass.
The historical smoother suite intentionally retains the old 1.50/0.05 reference
and prints its known oscillation; this is distinct from the conservative suggestion.

The 74-scenario suggested-gain suite checks the fixed conservative reference and
manually selected rows, perturbation recovery, gusts, turbulence and both rated
crossing directions. Its results support keeping gains fixed and user-owned;
no automatic gain scheduling is needed for the tested experiments. See
[Step 5a](step5a-suggested-gains.md) for quantitative tracking/motion trade-offs.
They do not guarantee stability for every combination or disturbance.

**Interactive browser validation remains unverified.** The local dev page returned
HTTP 200 and the production build passed, but the available browser-control
runtime failed during setup with `Cannot redefine property: process`, including
a retry after resetting its kernel. The worker tests do not substitute for visual
and interactive inspection. Use the procedure above to review the browser UI.

## Files changed in this stage

- `src/sim/generatingEnvelope.ts`: browser strategies, supported wind bounds and
  re-entry rule.
- `src/sim/simulationWorker.ts`: coordinated integration, equilibrium Reset,
  live transfer, boundary/table guards and operation status.
- `src/sim/workerMessages.ts`: strategy/gain settings and status protocol.
- `src/sim/coordinatedController.ts`: coordinated live gain transfer.
- `src/sim/coordinated.ts`: initialization documentation updated for shared use.
- `src/app/useSimulation.ts`: expose operation state from the existing worker.
- `src/ui/ControlsPanel.tsx`: strategy, manual suggestions, gain inputs and range
  explanations.
- `src/ui/SimulationDashboard.tsx`: connect operation status and update intro.
- `scripts/check-browser-range.mjs`: new deterministic worker integration checks.
- `scripts/check-live-settings.mjs`: legacy comparisons use unclipped wind;
  continuity fixture stays within its supported envelope.
- `package.json`: new `check:browser-range` command.
- This document: review procedure, evidence and limitations.

Existing uncommitted changes from earlier stages have been retained. No commit,
push or deployment was performed. Proposed next step: **Step 7, controls tabs**,
after explicit user instruction.
