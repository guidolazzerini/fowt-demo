# Step 4: offline below-rated torque PI and IEA low-wind pitch schedule

The later coordinated development mode and its validation findings are described
in [Step 5](step5-setpoint-smoother.md). This page documents the isolated Step 4 mode.

The development strategy is `below-rated-tsr-pi`. It is available through the
shared turbine controller and offline scenario runner. The browser continues to
use `legacy-above-rated`; no strategy selector or full-range operation is enabled.

## Signal, units, and controller

The reference is
`Omega_ref = clamp(9.5 * filtered_wind / 120, 5 rpm, 7.55 rpm)`, with speeds
converted to rad/s internally. The input is **simulated free-stream wind** from
the wind generator, not estimated wind and not rotor-effective wind. It passes
through a first-order low-pass filter with a 5 s time constant, initialized to the
initial wind value. The discrete filter uses `alpha = 1 - exp(-dt/tau)`.
Control uses the current sample before the next wind/physics step.

Generator torque is rotor-side in N m. Positive torque brakes the rotor:
`J * dOmega/dt = aerodynamic_torque - generator_torque`. Consequently the PI
error is measured speed minus reference speed: overspeed increases braking.

Defaults:

| Setting | Value |
|---|---:|
| Target TSR | 9.5 |
| Collective pitch | IEA low-wind schedule, then 0 degrees |
| Minimum reference speed | 5 rpm |
| Maximum reference speed | 7.55 rpm |
| Torque Kp | 50.4e6 N m s/rad |
| Torque Ki | 2.24e6 N m/rad |
| Generating torque limits | 0 to 18.972112 MN m |
| Torque rate limit | 2 MN m/s |
| Pitch limits / rate limit | 0 to 30 degrees / 5 degrees/s |

The gains start from `Kp = 2*zeta*wn*J`, `Ki = wn^2*J`, using `zeta = 0.9`,
`wn = 0.08 rad/s`, and the existing rotor inertia. These are demo gains tested
with this model, not validated settings for a physical turbine.

The normal generating cap is rated torque; the existing absolute actuator
ceiling is 20 MN m. The factory takes the smaller of the two. Conditional
anti-windup holds integration when the error pushes farther into an amplitude
or rate limit. Ki = 0 clears the integral. Initialization preloads the integral
to match bounded aerodynamic torque, including any initial speed error.
The slew limiter is the torque actuator representation here; no additional
first-order actuator lag or generator efficiency model is introduced.

## Research and pitch schedule

The [IEA 15 MW definition report, Sections 3.1–3.2](https://docs.nlr.gov/docs/fy20osti/75698.pdf)
specifies a 5 rpm minimum and positive pitch at low wind speeds to improve Cp
under this constraint. [Abbas et al. (2022), Section 5.3.2](https://wes.copernicus.org/articles/7/53/2022/)
explains the ROSCO minimum-pitch schedule: when minimum rotor speed forces TSR
above optimum, increasing pitch can improve power capture. This is distinct
from the near-rated thrust peak-shaving schedule in Section 5.3.1.

`src/sim/belowRatedPitch.ts` copies the first 17 wind/pitch pairs from
`PS_WindSpeeds` / `PS_BldPitchMin` in the official
[IEA-15-240-RWT v1.1.17 UMaineSemi DISCON file](https://github.com/IEAWindSystems/IEA-15-240-RWT/blob/v1.1.17/OpenFAST/IEA-15-240-RWT-UMaineSemi/IEA-15-240-RWT-UMaineSemi_DISCON.IN).
Values retain their published precision and units (m/s, radians). Pitch is
0.0600 rad (3.438 degrees) through 4.3345 m/s, then decreases to zero at
7.2703 m/s. Interpolation is linear; endpoints are held beyond this branch.
The later near-rated/above-rated peak-shaving values are deliberately excluded.
Endpoint holding is numerical behavior, not permission to operate outside the
supported generating envelope.

In this isolated below-rated mode, the schedule supplies the pitch command,
bounded by the existing pitch amplitude and rate limits. It uses the **same
filtered simulated free-stream wind** as the torque controller, without another
filter. It does not reproduce ROSCO's wind estimator. Initialization sets pitch
to the bounded scheduled value, balances platform thrust, and preloads torque
PI state to the aerodynamic torque at that pitch and initial rotor speed.

The published low-wind pitch values and 5 rpm floor are adopted; other model
parameters remain those of this simulator. In particular, the table-checked TSR
target remains 9.5, whereas the reference DISCON uses 9.0. This gives departure
from the minimum-speed reference at about 6.61 m/s, with a small remaining
scheduled pitch until 7.2703 m/s. This is not a complete ROSCO reproduction.
Changing the minimum speed substantially would require reassessing the schedule.

## Aerodynamic choice and feasibility

At each tested wind speed, the check scans pitch from 0 to 30 degrees at the
requested rotor speed and equilibrium effective wind. The published schedule
retains 97.3–100% of this scanned, **speed-constrained** peak Cp at 3–10 m/s.
That does not mean 97% of the unconstrained optimum: at 3 m/s, 5 rpm implies
free-stream TSR about 20.94 and this table gives Cp only about 0.082.

The earlier 3 rpm demo floor is replaced by 5 rpm. The previous zero-generation
result at 5 rpm / 3 m/s applied specifically to **fixed 0-degree pitch**.
Scheduled positive pitch makes this operating point feasible with the local
table. The minimum constrains the reference only: actual rotor speed can fall
below it during transients. No motoring torque or artificial speed clamp is used.

Representative equilibria, including static platform pitch and wind projection:

| Free-stream wind (m/s) | Rotor speed (rpm) | Pitch (degrees) | Rotor-side torque (MN m) | Generator mechanical power (kW) |
|---:|---:|---:|---:|---:|
| 3 | 5.000 | 3.438 | 0.117 | 61.4 |
| 4 | 5.000 | 3.438 | 1.243 | 650.8 |
| 5 | 5.000 | 2.847 | 2.994 | 1567.9 |
| 6 | 5.000 | 1.567 | 5.562 | 2912.5 |
| 7 | 5.292 | 0.062 | 8.515 | 4718.5 |
| 8 | 6.048 | 0 | 11.138 | 7054.0 |
| 9 | 6.804 | 0 | 14.055 | 10014.5 |
| 10 | 7.550 | 0 | 17.313 | 13688.0 |

These are simulator results, not the reference turbine's published power curve.
Generator mechanical power is torque times rotor speed, with no efficiency
model. Aerodynamic power uses the separately interpolated Cp table and may
differ slightly from torque times speed.

`createBelowRatedScenario` returns both a scenario and an operating-point
assessment. Check `operatingPoint.feasible` and `reason`. The assessment checks
table bounds and whether the required generating torque is positive and within
the configured limits (1 N m is the zero-generation tolerance). Feasibility
alone does not establish dynamic stability. Infeasible scenarios can still be
run for diagnosis, with torque bounded and no forced speed tracking.

Two deliberate counterexamples are tested:

- 3 m/s with a 5 rpm floor and fixed 0-degree pitch: the table gives zero generating torque. Coasting at
  that speed in the lossless model does not establish generating feasibility.
- 11 m/s with 0-degree pitch: required torque exceeds the generating cap, so
  speed exceeds the reference (22.56 MN m required versus an 18.97 MN m cap).
  Coordinated pitch control is required.

The table metadata says negative Cp/Ct values were clipped to zero during export.
Its low-speed coverage starts at 2 rpm. These data and the lossless drivetrain
do not support claims about realistic startup, idling, or shutdown.

## Validation and use

From the repository root:

```powershell
npm run check:below-rated
npm run check:live-settings
npm run lint
npm run build -- --outDir .step4-build
```

The below-rated suite runs 24 constant-wind scenarios (eight wind speeds, each
initialized at the reference and +/-10% speed), each lasting 600 simulated
seconds. Over the final 100 s it checks speed error below 1e-4 rpm, torque
balance within 100 N m, and settled platform rate. It also checks torque sign,
both torque/slew limits, anti-windup recovery, filter response, zero Ki,
deterministic turbulence, and the two infeasible cases. Pitch checks cover the
published knots, interpolation, endpoint holding, both amplitude and rate
limits, shared wind filtering, and consistent initialization. An 800 s gust
case traverses 3 to 8 to 3 m/s and verifies recovery to positive generation at
5 rpm. Seeded turbulence at 5 m/s exercises the changing pitch schedule.
The maximum speed error over the final 100 s of the constant-wind cases was
about 9e-10 rpm; these idealized results do not imply an equally precise physical
turbine model or guaranteed minimum speed under arbitrary disturbances.

The previously failing steady-state check now uses the coupled static
equilibrium for both its power solve and torque/platform initialization.
The legacy browser/offline comparison and existing suites remain separate in
`check:live-settings`.

To construct an offline case, use `createBelowRatedScenario` from
`src/sim/belowRated.ts`, then pass its `scenario` to `runSimulationScenario`.
Torque diagnostics include the raw and filtered wind, speed reference, reference
clamps, PI contributions, and amplitude/rate-limit indicators.
Pitch diagnostics expose the scheduled value, bounded target, and saturation
and rate-limit flags; the applied pitch remains in each simulation sample.
For a fixed-pitch comparison, set `config.pitch` to
`{ ...config.pitch, mode: "fixed", fixedPitchRad: 0 }` before creating a scenario.

Transition smoothing, above-rated coordination, boundary hysteresis, and browser
exposure are deliberately left for later steps. Do not use this isolated mode as
a full-range turbine controller.
