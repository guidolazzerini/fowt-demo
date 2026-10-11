# Step 9 — integrated validation

## Result and scope

Validated the existing `C:\_my_codes\fowt-demo` checkout on 2026-10-11 using
Node 24.14.1 and npm 11.11.0. Existing uncommitted work was preserved.
No controller, physics, wind or UI behavior was changed in this step.

The automated validation and documentation work is complete. **Interactive
production-browser acceptance is outstanding**, particularly a repeat of the
reported Chrome out-of-memory failure with diagnostics open. The browser-control
connection failed during setup (`Cannot redefine property: process`); its
troubleshooting API was consequently unavailable. HTTP and static React checks
must not be interpreted as a passed interactive browser test.

Closed-panel runs were reported stable. The Step 8 follow-up compacted SVG paths,
kept axis node identities stable and skipped unused statistics calculations.
These changes reduce rendering allocations; they have not established or proved
resolution of the original memory problem.

## Repeatable automated evidence

`npm run check:all` runs all six existing commands sequentially, stopping on a
failure. Sequential execution also avoids concurrent Vite optimizer activity.

| Check | Result |
|---|---|
| Live settings and legacy | PASS: wind continuity, Reset-only initial pitch, positive/zero-Ki changes, Start/Stop/Reset; 450 exact worker/offline samples; zero legacy difference across 4,000 controller and 18,000 scenario steps; six original suites |
| Below rated | PASS: IEA low-wind pitch schedule, torque signs/limits/rates, minimum-speed feasibility, PI tracking and steady equilibria |
| Smoothing | PASS: equations/normalizations, slow crossings in both directions, repeated turbulent crossings and identical disturbances with smoothing on/off |
| Suggested gains | PASS: 74 fixed-gain scenarios covering recovery, gusts, turbulence, crossings and user-selected combinations; no automatic scheduling |
| Browser worker integration | PASS: equilibrium initialization at 3, 5, 8, 10.5, 12, 18 and 25 m/s; 450 exact offline matches; 1,600 s crossings both directions; final recovery error below 0.005 rpm |
| Added turbulent worker comparison | PASS: 1,200 s each at mean 10.5 m/s, TI 8%, seed 12345, smoothing on/off; identical wind samples, repeated region crossings, bounded torque/pitch and net actuator slew, unchanged user gains |
| Live edits, strategies and boundaries | PASS: gain changes including Ki = 0, smoothing/feedback toggles, gain retention across strategies, both unclipped boundary trips, 0.2 m/s Reset hysteresis, infeasible limits, aerodynamic-table guard and worker range validation |
| Controls and diagnostics | PASS: static React markup, five tab contracts, shared numeric ranges, hidden help, visible boundary message; 600 actual diagnostic samples, signal units and power, missing-data gaps and compact 600-point drawing |
| Lint and TypeScript | PASS |
| Production build | PASS: separate ignored `.step9-preview.local` output; existing `dist` untouched |
| Production HTTP smoke check | PASS: HTML, bundled application JavaScript, CSS, worker JavaScript, favicon and aerodynamic JSON return HTTP 200 with appropriate MIME types; all 27,000 values in each coefficient field are finite |

The historical smoother comparison intentionally retains pitch gains 1.50/0.05
with feedback off and reports their known oscillation. It is not the suggested
coordinated fixed reference (0.60/0.015). Neither that comparison nor the passing
suggestion checks guarantee stability for arbitrary user gains.

The new turbulent worker case uses the browser's existing 2.5 s disturbance
filter and unchanged 0.02 s integration timestep. It increases steps per worker
tick only to advance the manual test clock efficiently. Worker tests do not
allocate browser DOM nodes or measure Chrome memory.

## Production review for the user

The production preview was started at **http://127.0.0.1:4173/**. If the process
has stopped, recreate it from the repository:

```bash
npm run build -- --outDir .step9-preview.local
npm run preview -- --outDir .step9-preview.local --host 127.0.0.1 --port 4173 --strictPort
```

In a second terminal, `npm run check:preview` repeats the asset checks.
Build artifacts are ignored; this is a build of the existing repository, not a
second project checkout. The preview is local only.

Use these acceptance checks in Chrome. They are **pending**, not claimed passes:

1. Load the preview with no query string. Confirm the dashboard and schematic
   render, then Start, Stop, resume and Reset. Time must pause/resume and Reset
   must return to zero. Look for console errors and failed worker/JSON requests.
2. Choose Coordinated TSR PI, apply the SUGGESTED fixed reference, and use
   Constant 5 m/s. Reset/Start. Expect approximately 5 rpm, 2.994 MN m and
   1.568 MW generator mechanical power. Repeat at 18 m/s: approximately 7.55 rpm,
   18.972 MN m and 15 MW. Test 3 and 25 m/s as fresh constant-wind resets too.
3. Use a gust with mean 9 m/s, amplitude +4 m/s, start 100 s and duration 800 s;
   run through 1,600 s. Repeat with mean 13 m/s and amplitude −4 m/s. Compare
   smoothing on/off after Reset, keeping all other settings identical. Inspect
   both references, operating region and pitch/torque response.
4. Choose random wind at 10.5 m/s with TI 0.08; Reset and run past 1,200 s.
   Change pitch/torque gains, set Ki to zero and restore it, and toggle smoothing
   and floating feedback. Time must continue, and wind must not jump/restart
   solely because of these control edits. Reset and repeat for an identical wind.
5. Switch settings tabs and open/close help and diagnostics while running.
   Time must continue without Reset. At narrow width verify labels/inputs remain
   usable. Change a numeric input with Enter and blur; use Escape to discard a
   draft. Verify Stop and Reset remain accessible.
6. Switch strategy: the run must pause, retain gains and require Reset. Legacy
   must show torque reference/target TSR/smoothing as unavailable. Initial pitch
   applies only on legacy Reset; it must not alter a running trajectory.
7. For an upper-boundary trip, use coordinated gust mean 24 m/s, amplitude +2,
   start 0, duration 10 s. For a lower trip use mean 4 and amplitude −2.
   Expect Unsupported operation and frozen physical outputs with triggering
   wind shown. Start remains blocked. Set Constant wind to 24.8 or 3.2 m/s,
   respectively, and Reset to recover. Changing coordinated pitch limits must
   likewise pause and require a feasible Reset.
8. Repeat the previously crashing configuration with diagnostics **open** beyond
   1,000 simulated seconds, then continue for several minutes. Use Chrome Task
   Manager (Shift+Esc) to record simulator-tab memory at intervals. Check whether
   memory grows persistently, whether closing/reopening diagnostics changes it,
   and whether Stop/Reset remain responsive. A short closed-panel run does not
   settle this issue. Report settings, elapsed time and memory observations if
   it fails again; do not treat the prior 509.8 s as an intentional duration limit.

## Ready and unsupported

The automated evidence supports the implemented generating controller, manual
gain experiments, transitions, deterministic live tuning, operating guards and
diagnostic signal definitions. The fixed suggested gains support the tested
scenarios; gain scheduling was neither added nor required by those results.

Outstanding: interactive Chrome acceptance, long-run diagnostic memory behavior
and production layout review. Unsupported physical features remain startup,
motoring, parked/feathered shutdown, electrical power conversion and a full
flexible aero-hydro-servo-elastic turbine. Browser speed/torque/filter constants
are read-only. Short limit events between posted samples may be missed.

## Files and next action

- `README.md`: current modes, ranges, gains, live-setting semantics, assumptions,
  validation commands, architecture and deployment status.
- `package.json`: `check:all` and `check:preview` commands.
- `scripts/check-browser-range.mjs`: long turbulent smoothing comparison through
  the actual worker.
- `scripts/check-preview.mjs`: repeatable production HTTP/asset smoke check.
- This document: results, explicit browser gaps and the review procedure.

No commit, push, merge, Netlify configuration/link change or deployment occurred.
Next: review the browser results and, on explicit instruction, inspect the
GitHub/Netlify linkage and prepare the deployment. `K * Omega^2`, constant-power
above-rated control and advanced control remain separate future stages.
