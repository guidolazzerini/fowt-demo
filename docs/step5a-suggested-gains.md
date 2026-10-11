# Step 5a: SUGGESTED fixed gains for student experiments

The demonstrator is intended for students to test different combinations.
**There is no gain scheduling.** Wind changes, operating-region changes, and
crossings of rated operation never select, interpolate, or apply different
gains. A suggestion is an explicitly chosen starting point, not a restriction
on which values students may enter.

## Fixed reference and operating-point suggestions

The coordinated development controller now starts with pitch **Kp = 0.60 s,
Ki = 0.015**, floating feedback **off**, at every operating point. These replace
its previous inherited 1.50 / 0.05 pitch gains. The legacy browser controller
retains its existing defaults for regression comparison. Browser integration
and presentation of these suggestions remain for separately authorized steps.

The following rows are labeled **SUGGESTED** in `src/sim/suggestedGains.ts`.
The wind column identifies the test condition; it is not a runtime selection rule.

| Tested wind (m/s) | SUGGESTED pitch Kp (s) | SUGGESTED pitch Ki (dimensionless) | Floating feedback | SUGGESTED floating gain (s) |
|---:|---:|---:|---|---:|
| 3 | 0.60 | 0.015 | Off | 0 |
| 5 | 0.60 | 0.015 | Off | 0 |
| 8 | 0.60 | 0.015 | Off | 0 |
| 10.5 | 0.80 | 0.020 | On | 10 |
| 12 | 0.80 | 0.020 | On | 10 |
| 15 | 1.00 | 0.030 | On | 10 |
| 18 | 1.50 | 0.050 | On | 10 |
| 22 | 1.50 | 0.050 | On | 10 |
| 25 | 1.50 | 0.050 | On | 10 |

Common SUGGESTED values in all rows:

- Torque Kp: **50.4e6 N m s/rad**, torque Ki: **2.24e6 N m/rad**.
- Smoother k_vs: **1**, k_pc: **0.001**, both dimensionless.
- Existing wind filter: **5 s**; existing floating-feedback filter: **0.2 Hz**.

Positive rotor-speed error increases braking torque and collective pitch.
Pitch PI uses speed in rad/s and pitch in radians, hence its Kp has units of
seconds and its Ki is dimensionless. Floating feedback adds pitch proportional
to filtered platform pitch angular velocity, with gain in seconds.

Below rated, pitch PI normally rests at the IEA scheduled minimum, so changing
pitch gains can have little effect until pitch regulation becomes active.
Torque control is the principal speed-regulating loop there. The suggestions
retain the already validated below-rated torque gains.

These choices were made from fixed-gain experiments on this model. They are not
a globally optimal tuning, certified physical-turbine settings, or proof that
the listed combination outperforms all others at its nominal wind speed.
The catalog values apply to the current aerodynamic table, inertia, and platform
parameters; changing those requires reassessment.

## Reproduce and inspect

```powershell
npm run check:suggested-gains
npm run check:suggested-gains -- --sweep
```

The normal command runs **74 scenarios**. The optional sweep adds **36 runs**
comparing nine fixed combinations at four operating points, for **110 total**.
It prints speed error, platform motion, and actuator travel without rewriting
the catalog or choosing a winner. Larger gains are allowed to produce worse
responses; exploring that behavior is part of the demonstrator's purpose.

Each normal operating-point check includes:

- 900 s recovery tests from both +5%/+1 degree and -5%/-1 degree changes in
  rotor speed/platform pitch, retaining equilibrium controller states. Both
  the conservative reference and the point's manually selected suggestion are tested.
- 900 s gust-recovery runs: +/-1 m/s, start at 50 s, duration 200 s. At 3 and
  25 m/s only inward gusts are used; wind is not clipped at operating thresholds.
- For the seven interior points, two 600 s turbulence runs: TI 4%, time constant
  20 s, seeds 12345 and 67890. Boundary turbulence is omitted and printed as
  `null`, not a measured zero error.

The recovery checks require final-100-s maximum speed error below 0.005 rpm and
platform pitch rate below 0.002 degrees/s. All reference and suggested recovery
cases pass. Among the suggested rows, the largest final speed error is about
0.0000213 rpm. Small tail errors describe convergence of this deterministic
model and should not be read as physical turbine prediction accuracy.

Tests also cover slow crossings in both directions, a halved time step,
identical turbulent disturbances across manually chosen combinations, actuator
limits, and a custom student combination that is absent from the catalog.
Configuration values and applied PI contributions are checked to confirm that
wind changes do not alter the chosen Kp or Ki.

## What improved, and the trade-offs

For the previously problematic 1600 s 13–9–13 m/s crossing, with floating
feedback off and identical wind:

| Measure | Previous pitch gains 1.50 / 0.05 | SUGGESTED fixed reference 0.60 / 0.015 |
|---|---:|---:|
| Final-100-s maximum speed error (rpm) | 0.7738 | 0.00000248 |
| Maximum platform-pitch departure from initial equilibrium (degrees) | 7.50 | 1.98 |
| Total pitch travel (degrees) | 340.42 | 17.43 |

Halving the time step from 0.02 to 0.01 s gives final error 0.00000249 rpm.
This resolves the growing oscillation observed with the old reference in that
test. The new conservative pair is slower and can allow larger temporary
speed excursions than faster, adequately damped combinations.

A 1200 s turbulent case at mean 10.5 m/s, TI 8%, time constant 20 s, seed 12345
demonstrates the trade-off using exactly the same wind samples:

| Fixed combination | RMS speed error (rpm) | Maximum absolute speed error (rpm) | Platform departure (degrees) | Pitch travel (degrees) |
|---|---:|---:|---:|---:|
| Reference 0.60 / 0.015, feedback off | 0.321 | 1.048 | 2.20 | 149.11 |
| Near-rated suggestion 0.80 / 0.020, feedback 10 s | 0.291 | 0.954 | 1.55 | 180.79 |
| 15 m/s suggestion 1.00 / 0.030, manually tested at 10.5 m/s, feedback 10 s | 0.260 | 0.878 | 1.83 | 202.49 |

Speed error is measured relative to the base TSR speed reference. Platform
departure is from the initial static equilibrium, so it also includes changes
in mean thrust. Travel is the sum of absolute command changes, not fatigue.
The fastest row improves tracking at the cost of more pitch movement and is
not uniformly best for platform motion. Keeping gains manually selectable is
essential to exposing these trade-offs.

## Choose values explicitly in an offline experiment

`createCoordinatedControllerConfig(params, table)` uses the fixed conservative
reference. Its optional third argument supplies all selected gains; legacy pitch
gain fields in `params` are not used for the coordinated strategy's gain selection.
Geometry, actuator limits, and filter settings continue to come from `params`.

```ts
const row = SUGGESTED_OPERATING_POINT_GAINS.find(item => item.id === "wind-12")!;
const studentGains = { ...row.gains, pitchKpS: 0.73, pitchKi: 0.018 };
const config = createCoordinatedControllerConfig(params, table, studentGains);
const { scenario } = createCoordinatedScenario({
  name: "Student fixed-gain experiment", params, aeroTable: table, config,
  totalTimeS: 900, dtS: 0.02,
  wind: { mode: "constant", meanWindSpeedMps: 12 },
});
const result = runSimulationScenario({ scenario, params, aeroTable: table });
```

The catalog is imported from `src/sim/suggestedGains.ts`, the configuration and
scenario factories from `src/sim/coordinated.ts`, and the runner from
`src/sim/simulation.ts`. `withFixedControllerGains(config, studentGains)` is an
alternative for configuring another offline experiment; it returns a new config
and leaves the original and controller states untouched. Live gain-transfer and
browser selection remain integration work, not something this helper performs.

## Scope and next stage

The current tests support these suggested starting values for the stated
experiments. They do not establish stability for every student combination,
arbitrary disturbances, startup/shutdown, or operation outside 3–25 m/s.
No automatic gain scheduler will be added. The next stage is Step 6 browser
integration with explicit generating boundaries and user-owned gain values;
the planned Gains tab should present suggestions as advice or an explicit
user action, never overwrite values when wind or operating region changes.

Files: `src/sim/suggestedGains.ts`, `src/sim/coordinated.ts`,
`src/dev/runSuggestedGainChecks.ts`, `src/dev/runSetpointSmootherChecks.ts`,
`scripts/check-suggested-gains.mjs`, `package.json`, this document, and the
cross-reference in `docs/step5-setpoint-smoother.md`.
