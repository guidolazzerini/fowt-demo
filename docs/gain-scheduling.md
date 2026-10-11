# Manual suggestions and optional gain scheduling

The browser now starts in coordinated TSR PI with the stable manual baseline.
Legacy control remains available under **Control strategy → Advanced: legacy
controller** for regression comparisons. Selecting a strategy still requires Reset.

## Using the gains

Manual mode keeps user control of every gain. Suggestions now distinguish:

- **Stable demo baseline · all winds:** pitch Kp/Ki 0.60/0.015, floating feedback off.
- **For current filtered wind:** interpolate the table below, then apply once.
  Later wind changes do not alter manual gains. Before the first generating
  sample, the preview uses the configured mean wind.

**Automatic · demo wind schedule** uses that same table continuously. It schedules
pitch PI and the gain from platform pitch rate to collective blade pitch. Torque
PI remains 50.4 MN m s/rad and 2.24 MN m/rad throughout: this model uses constant
rotor inertia, and its existing torque tuning passed the tested range. Smoothing
and COFLEX observer gains remain manual. These are distinct from the gains being
scheduled using the observer's output.

| Filtered wind (m/s) | Pitch Kp (s) | Pitch Ki (–) | Floating gain (s) |
|---:|---:|---:|---:|
| 3 | 0.60 | 0.015 | 0 |
| 8 | 0.60 | 0.015 | 0 |
| 10 | 0.80 | 0.020 | 20 |
| 12 | 0.80 | 0.020 | 20 |
| 14 | 0.9333 | 0.02667 | 12 |
| 16 | 1.1667 | 0.03667 | 12 |
| 18 | 1.50 | 0.050 | 10 |
| 25 | 1.50 | 0.050 | 10 |

Linear interpolation uses the controller's existing 5 s low-pass filtered wind.
Its input is the selected simulated free-stream signal or causal COFLEX estimate
of rotor-effective wind. Scheduling does not access true wind when COFLEX is
selected. Table endpoints are held outside 3–25 m/s; operating supervision still
decides whether generation is supported. Startup/shutdown retain their separate
sequence and use these gains at generating handover.

The floating contribution is `beta_float = gain_s * filtered_platform_pitch_rate`:
positive platform pitch rate [rad/s] adds positive collective blade pitch [rad].
The existing 0.2 Hz first-order motion filter is unchanged. There is no wave-driven
optimization or new blade-load controller.

Automatic mode retains manual settings without rewriting them. Returning to Manual
restores those values. Mode changes retune once to preserve commands as far as
practical; ordinary scheduling rescales the pitch error integral to preserve
`Ki * integral`, then performs one integration/anti-windup step. It does not
reinitialize the controller each timestep. Pitch and torque slew limits remain
active. Manual Ki = 0 and estimator Ki = 0 retain their existing behavior.

## Literature and reference comparison

The floating schedule adapts the no-lidar MVFB column in
[Guo & Schlipf (2023), Section 4.2, Table 4](https://wes.copernicus.org/articles/8/1299/2023/):
24 s at 10 m/s, 20 s at 12, 12 s at 14–16, and 10 s above that range.
We cap 24 s at the existing 20 s demonstrator limit and retain our empirical
pitch PI suggestions. This combination is not their optimized controller.
Their pitch PI study includes Kp 0.2–1.4 s and integral times 5–20 s;
integral time is not Ki (`Ki = Kp / Ti`).

[De Pascali et al. (2026)](https://doi.org/10.1002/we.70107) jointly tune pitch PI
and platform-rate feedback for IEA 15 MW/VolturnUS. This supports checking the
loops together. We have not implemented its LQR design or reproduced its gains.

The official repository comparison uses
[UMaineSemi DISCON](https://github.com/IEAWindSystems/IEA-15-240-RWT/blob/e4993d63de10f165389534461dd544006750fe60/OpenFAST/IEA-15-240-RWT-UMaineSemi/IEA-15-240-RWT-UMaineSemi_DISCON.IN)
at commit `e4993d63de10f165389534461dd544006750fe60` (ROSCO 2.10.1 tuning).
Its signed gains, expressed with our **speed minus reference** error, compare as follows:

| Gain | Demo | Published reference, converted sign |
|---|---:|---:|
| Torque Kp (MN m s/rad) | 50.4 | 35.7306 |
| Torque Ki (MN m/rad) | 2.24 | 4.49937 |
| Pitch Kp (s) | 0.60 baseline; 0.60–1.50 schedule | 1.143 down to −0.07679 |
| Pitch Ki (–) | 0.015 baseline; 0.015–0.050 schedule | 0.1196 down to 0.02931 |
| Floating gain (s) | off baseline; 0–20 schedule, 10 at high wind | 9.1984 |

The reference uses gearbox ratio 1, rotational nacelle feedback and one constant
floating gain. Its floating filter is second-order at 0.213 rad/s with high-pass
0.01042 rad/s, unlike our 0.2 Hz first-order filter.

[ROSCO's error definitions](https://github.com/NREL/ROSCO/blob/main/rosco/controller/src/ControllerBlocks.f90)
use reference minus measured speed, reversing the PI signs above.
[Controller implementation](https://github.com/NREL/ROSCO/blob/main/rosco/controller/src/Controllers.f90)
schedules pitch PI on filtered **blade pitch angle**, not wind, and multiplies
the negative floating gain by negative nacelle motion. The sign-changing pitch
Kp must not be imported by taking its absolute value.

**Conclusion:** floating gains around 10 s are close in scale; torque Kp is 41%
higher and Ki about half the reference. Pitch gains are not the published schedule:
our baseline integral is weaker, and our scheduled proportional gain increases
with wind while the reference decreases with pitch. Similar numbers do not imply
equivalent dynamics. The [reference tuning configuration](https://github.com/IEAWindSystems/IEA-15-240-RWT/blob/e4993d63de10f165389534461dd544006750fe60/OpenFAST/IEA-15-240-RWT-UMaineSemi/IEA-15-240-RWT-UMaineSemi_ROSCO.yaml)
also uses different rotor inertia, TSR, limits and filtering. Therefore the UI
says **demo baseline/schedule**, not IEA/ROSCO reference gains.

## Repeatable validation

Run `npm run check:gain-scheduling` for the new checks, or `npm run check:all`
for all nine suites. Scheduling checks passed:

- 44 scenarios: both wind sources; perturbed steady operation at ten winds from
  3 to 25 m/s; slow crossings both ways; turbulence at five winds and two seeds.
- Steady/crossing final-100-s speed errors below 0.005 rpm; finite outputs,
  pitch/torque amplitude and slew bounds, integral-output continuity.
- 12 manual/scheduled comparisons with exactly identical turbulent wind.
- COFLEX crossing at dt = 0.01 versus 0.02 s: peak difference below 0.01 rpm.
- Scheduled COFLEX startup at 3/18 m/s, 300 s generating, then requested shutdown.

Worker checks additionally verify 1800 exact worker/offline sample matches for
manual/scheduled gains and both wind sources, live mode/source changes, preserved
wind, inactive manual edits and restored manual gains. Static React checks cover
default strategy, hidden legacy controls, suggestions and read-only scheduled gains.

All nine suites, lint, TypeScript/production build and production asset/MIME smoke
checks passed. The build used `--outDir .startup-preview.local` to preserve `dist`.
Local production preview: `http://127.0.0.1:4174/` while its preview server is running.

For 6% turbulence, seed 12345, COFLEX input, over simulated seconds 100–600:

| Mean wind | Speed-error RMS, manual → scheduled (rpm) | Platform deviation RMS (deg) | Blade-pitch travel (deg) |
|---:|---:|---:|---:|
| 10.5 m/s | 0.229 → 0.198 | 0.403 → 0.190 | 89.4 → 151.4 |
| 12 m/s | 0.216 → 0.193 | 0.423 → 0.198 | 95.5 → 161.5 |
| 18 m/s | 0.168 → 0.106 | 0.256 → 0.178 | 137.4 → 284.0 |

Platform deviation is relative to the initial equilibrium, not a fatigue-load
metric. Improved tracking/motion comes with more pitch activity. These limited
scenarios do not establish an optimum or real-turbine load reduction. The model
has one platform degree of freedom, default zero waves, ideal measurements and
an approximate aerodynamic table. Interactive Chrome and long-run memory checks
remain manual; the installed browser skill file was unavailable during this stage.

## Browser review

1. Run `npm run dev`, open its URL and refresh. Check coordinated control is
   the default; legacy appears inside the Advanced disclosure.
2. Set constant 18 m/s, Reset and Start. In Gains choose **For current filtered
   wind**, inspect its preview, then Apply. It should approach 1.50/0.050 and
   10 s floating feedback. Manual gains remain fixed when wind changes.
3. Enter manual pitch gains 0.60/0.015. Select **Automatic · demo wind schedule**.
   Confirm pitch/torque/floating fields are read-only, estimator/smoothing remain
   editable, and Controller diagnostics shows applied gains.
4. Change wind from 8 to 18 m/s and back. Gains should follow filtered wind
   continuously, including floating feedback fading to zero at 8 m/s.
5. Select COFLEX as controller wind input. Scheduling should follow the plotted
   filtered controller wind. Return to Manual: saved 0.60/0.015 should return,
   without Reset or a clock/wind restart.
6. Compare manual baseline and automatic at 12 m/s, Random wind, TI 0.06. Reset
   before each run for repeatability. Observe speed, platform motion and pitch
   activity. Stop/Start should pause/resume; Reset should reproduce the wind.

Browser behavior was reviewed locally before publication was requested.

## Changed files

- `src/sim/gainSchedule.ts`: interpolation and documented gain table.
- `src/sim/coordinatedController.ts`: shared scheduling, integral handling and diagnostics.
- `src/sim/workerMessages.ts`, `src/sim/simulationWorker.ts`: defaults, mode setting and live transfer.
- `src/ui/ControlsPanel.tsx`, `src/ui/SimulationDashboard.tsx`, `src/ui/ControllerDiagnostics.tsx`: suggestions, hidden legacy controls and applied gains.
- `scripts/check-gain-scheduling.mjs`: new behavioral scenarios and comparisons.
- `scripts/check-browser-range.mjs`, `scripts/check-controls.mjs`, `scripts/check-live-settings.mjs`: integration/UI checks and explicit historical legacy fixture.
- `package.json`, `README.md`, this document: validation command and current instructions.

Implementation preserved dependencies and generated `dist` files. Publication is
handled separately through the existing GitHub–Netlify connection.
