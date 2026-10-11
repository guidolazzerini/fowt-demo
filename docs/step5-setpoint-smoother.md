# Step 5: coordinated torque/pitch control and set-point smoothing

**Historical Step 5 results:** the comparisons below use the original pitch
gains 1.50 / 0.05. [Step 5a](step5a-suggested-gains.md) replaces the coordinated
default with a conservative fixed pair and adds manually selectable SUGGESTED
values. `check:smoothing` explicitly retains the original gains to preserve this
comparison; `check:suggested-gains` validates the new choices.

The offline strategy `coordinated-tsr-pi` continuously runs torque PI and pitch
PI through the shared turbine-controller entry point. It retains the IEA low-wind
pitch schedule and 5 rpm minimum speed reference. The browser still uses the
legacy above-rated controller; no browser strategy switch or deployment is added.

## Equations and normalization

Implemented from [Abbas et al. (2022), Section 5.2, Eqs. (48)–(49)](https://wes.copernicus.org/articles/7/53/2022/):

```text
deltaOmega = [(beta - betaMin)/betaCutOut * kVs
              - (normalTorqueCap - torque)/normalTorqueCap * kPc] * ratedOmega

torqueSpeedRef = baseTorqueSpeedRef - max(0, deltaOmega)
pitchSpeedRef  = ratedOmega        - min(0, deltaOmega)
```

The base torque reference is the existing filtered-wind TSR reference, bounded
between 5 and 7.55 rpm. Internally speeds are rotor-side rad/s, pitch is radians,
and torque is rotor-side N m; positive generator torque opposes rotor rotation.
The shifted references are not clamped back to the base-reference limits.

The paper defines the pitch denominator as operating pitch at cut-out. The
factory solves the local aerodynamic torque and static platform balance at
25 m/s, 7.55 rpm, and the normal constant-torque operating cap. This gives
**22.8981 degrees**, distinct from the **30-degree actuator maximum**. A solve
without a supported aerodynamic bracket throws rather than silently extrapolating.

The normal torque cap is **18.972112 MN m**, distinct from the **20 MN m absolute
actuator limit**. Changing spare actuator authority does not change normalization.
The new controller has no constant-power operation or efficiency model.

Defaults use the paper's dimensionless gains `kVs = 1`, `kPc = 0.001`. Disabling
smoothing makes the applied offset zero while retaining the raw offset as a
diagnostic. Positive offsets lower the torque reference; negative offsets raise
the pitch reference. There is no controller-selection threshold in wind speed.

## State and signal handling

Both loops use the existing 5 s first-order filtered **simulated free-stream
wind**, not a wind estimate. The wind filter is advanced once per time step;
its next value also supplies the minimum-pitch schedule. The smoother uses the
previous applied pitch and torque, together with the minimum pitch associated
with that previous command. This one-step delay avoids an algebraic loop.

Pitch PI, floating feedback, integral handling, and both actuator limiters are
reused. A rising minimum-pitch schedule is restricted to a reachable actuator
position, so it cannot override the pitch rate limit. Anti-windup sees that
effective lower bound. Both controller states survive transitions and smoother
toggles; neither is reset by a change of operating region.

For the coordinated controller, fine pitch supplies the pitch bias and the
integral supplies the above-rated operating trim. Initialization below rated
uses zero pitch integral, allowing underspeed to saturate at the scheduled
floor; cancelling that underspeed with a positive integral would cause premature
pitching as wind rises. Above the floor, initialization preloads the pitch
integral to the solved equilibrium. Torque initialization accounts for its
shifted reference. The legacy controller's fixed 4.1-degree bias is unchanged.

Diagnostics include both references, the base torque reference, normalized
pitch/torque terms, raw/applied offsets, both PI contributions, saturation and
rate-limit flags, scheduled/effective pitch floors, and actuator-bound indicators.

## Repeatable checks and results

Run from the repository root:

```powershell
npm run check:smoothing
npm run check:below-rated
npm run check:live-settings
npm run lint
npm run build -- --outDir .step5-build
```

The production-build command uses a temporary output directory to leave `dist`
untouched. The check scripts run the simulation in Node through Vite, without
requiring the browser. Construct another offline case using
`createCoordinatedControllerConfig` and `createCoordinatedScenario` from
`src/sim/coordinated.ts`, then call `runSimulationScenario`.

The smoothing suite covers:

- Numerical equation checks for positive, negative, zero, and disabled offsets.
- Distinction between operating normalization and actuator limits.
- Six initialized equilibria (3, 8, 10, 12, 18, and 25 m/s), including constant
  above-rated torque. These tests establish equilibrium preservation, not
  stability after arbitrary perturbations.
- Integral continuity during smoother toggles, saturation/recovery, zero Ki,
  and a rapidly rising minimum-pitch schedule.
- Slow 9–13–9 and 13–9–13 m/s gusts: 800 s gust duration with a 100 s initial
  hold and 700 s final hold, 1600 s total.
- Repeated turbulent crossings: 1200 s, mean 10.5 m/s, TI 8%, wind time constant
  20 s, seed 12345. Wind samples are identical between smoothing on/off runs.
- Both floating feedback disabled and enabled with the existing 10 s gain.
- Finite outputs, amplitude/rate limits, both shifted references and offset
  signs, and crossings between torque-cap and pitch-floor operation.

The comparison defines simultaneous loop activity as torque more than 1% below
its normal cap while pitch is more than 0.1 degree above its effective minimum.
It is a diagnostic metric, not a definition of the turbine's operating region.

Representative results with floating feedback enabled at 10 s:

| Scenario | Overlap off/on (s) | Torque travel off/on (MN m) | Pitch travel off/on (degrees) |
|---|---:|---:|---:|
| Slow 9–13–9 | 321.22 / 66.00 | 11.91 / 9.92 | 17.28 / 17.32 |
| Slow 13–9–13 | 371.08 / 83.08 | 11.69 / 27.20 | 17.32 / 17.55 |
| Turbulent crossings | 961.98 / 315.78 | 153.05 / 200.79 | 250.61 / 256.64 |

Travel is the sum of absolute sample-to-sample command changes, not a load or
fatigue measure. Smoothing reduces overlap in every tested comparison, but it
does not uniformly reduce actuator movement or speed excursions. The same
turbulent case has peak overspeed 0.5575 rpm without smoothing and 0.6974 rpm
with smoothing. Both slow cases settle with floating feedback enabled; the
13–9–13 case has maximum speed error 0.0000119 rpm over its last 100 s.

## Readiness limitation and proposed next work

**The existing pitch gains with floating feedback disabled are not ready for
full-range browser operation.** In the smoothed 13–9–13 m/s case, oscillation
grows after returning above rated: maximum absolute speed error over the final
100 s is 0.7738 rpm, versus 0.00109 rpm without smoothing. Halving the time step
from 0.02 to 0.01 s gives 0.7731 rpm, so reducing this integration step does not
resolve the behavior. The check prints this limitation explicitly rather than
treating reduced overlap as proof of stability.

Exploratory reductions of `kVs` from 1 to 0.02–0.5 did not give a consistently
better result across slow and turbulent cases, so the published default is kept
for transparent development comparisons. This is not a completed tuning study.
The existing 10 s floating feedback settles the tested slow crossing, but that
alone does not establish adequate damping across 3–25 m/s or all gain settings.

Step 5a assesses fixed pitch gains and floating feedback across operating points
and provides manually selected SUGGESTED combinations. Automatic gain scheduling
is excluded by the teaching requirement: the user owns the gains throughout an
experiment. Startup, shutdown, boundary hysteresis, browser controls, and
deployment remain for their separately authorized steps.

## Files in this step

- `src/sim/setpointSmoother.ts`: equations and reference diagnostics.
- `src/sim/coordinatedController.ts`: continuous two-loop stepping and state.
- `src/sim/coordinated.ts`: configuration and offline generating initialization.
- `src/sim/torqueController.ts`: optional reference shift and shared wind-filter prediction.
- `src/sim/operatingPoint.ts`: torque-balanced pitch solve for initialization/normalization.
- `src/sim/turbineController.ts`, `src/sim/simulation.ts`: shared entry point and runner integration.
- `src/dev/runSetpointSmootherChecks.ts`, `scripts/check-smoothing.mjs`, `package.json`: repeatable checks.
- `docs/step5-setpoint-smoother.md`, `docs/step4-below-rated.md`: findings and cross-reference.
