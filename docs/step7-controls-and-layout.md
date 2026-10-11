# Step 7 — controls tabs and quieter dashboard

This stage organizes the existing browser controls and reduces always-visible
explanations. It does not introduce new control laws or automatic gain scheduling.
No commit, push, Netlify configuration change or deployment was performed.

## Review in the browser

Open the existing local dev app at http://127.0.0.1:5173 (or run `npm run dev`
and use Vite's printed address). Refresh once to load this layout. Refreshing
restarts the current experiment; subsequent tab changes should not.

1. The top run bar contains Start, Stop, Reset, the operating region, active
   strategy/range, run state and time. Scroll down to check that the bar remains
   accessible. Boundary and Reset-required messages appear directly in it.
2. Select **Environment**, **Control strategy**, **Gains**, **Floating feedback**,
   and **Limits and initialization**. Only the chosen panel is visible. Focus
   a tab and use Left/Right arrows, Home or End; Tab enters the selected panel.
3. Under Control strategy select coordinated TSR PI. Under Gains choose the
   fixed reference and press **Apply SUGGESTED gains**. Under Environment select
   Constant wind at 5 m/s. Reset and Start. Switch through all five tabs:
   time and motion should continue, with the same gains and simulation state.
4. In Random mode at 12 m/s and TI 0.06, compare runs with and without tab
   switching after Reset. Merely navigating the controls or opening help must
   not restart the wind or recreate the worker.
5. Click an information disclosure (the small **i** and its topic) to read help.
   Click again or press Escape from within it to close it. These are native
   expanders, usable with keyboard and touch, rather than hover-only tooltips.
   Help stays open when switching away from and back to its tab.
6. Try Gust and Random modes: only their relevant disturbance controls appear.
   In legacy mode torque PI and smoothing are visibly inactive. Selecting a
   suggestion alone does not apply gains; Apply remains an explicit action.
7. Sliders apply while dragging. Numeric inputs apply on Enter or when leaving
   the field, retain fine precision, and cancel with Escape. Clearing a field
   must not send NaN or unexpectedly set a gain to zero. Empty/invalid edits
   revert to the last setting. Applied values obey the shared bounds.
8. The live summary shows four instantaneous values. Open **All values and 30 s
   statistics** for the remaining existing data; **Schematic readouts** for the
   extra schematic values; **Plot options** to show plot averages and standard
   deviations. Existing plotted signals remain available.
9. Review at a narrow window width as well as desktop width. The page stacks on
   smaller screens; the statistics table can scroll horizontally within its
   panel. Verify readable labels, focus outlines, tab selection and the run bar.
10. Repeat the Step 6 gust boundary test (24 m/s mean, +2 m/s gust, start 0 s,
    duration 10 s). The unsupported-operation message must remain visible even
    with all help closed. Recover at Constant 24.8 m/s with Reset.

## Implementation decisions

- Tab state belongs to ControlsPanel. Switching tabs changes only local React
  state; panels stay mounted with the native hidden attribute. The existing
  useSimulation hook and worker lifetime are unchanged.
- The run bar is outside all tabs. It stays at the top during page scrolling.
  Required action messages are not hidden inside optional help.
- Explanations, crossover notes, model assumptions and existing statistics are
  available on request. Normal view has a shorter title, four key values and
  less repeated text. No new diagnostic signals were added in this stage.
- Input labels now address numeric inputs individually; sliders have separate
  accessible names. Numeric drafts are local until committed, avoiding a
  temporary zero/minimum gain while the student types.
- settingRanges.ts is the single definition of numeric input bounds for the
  controls and worker validation. SI torque values are displayed in MN m units.
  Initial pitch also obeys current pitch limits; maximum pitch cannot be below
  minimum pitch. Worker bounds retain their previous values. The turbulence
  slider increment is now 0.01 so the existing default 0.06 is representable.
- Existing editable pitch limits remain editable. Speed references, torque
  caps/rate and feedback-filter cutoff are shown as **fixed** model values from
  the existing configuration. Making these additional parameters adjustable
  would need controller initialization/validation work and is not implied by
  this presentation change.
- The applied gains remain entirely student-owned, including through wind
  changes. Suggested gains still require the Apply action.

## Checks and limits of verification

- `npm run check:controls`: actual React static rendering across both strategies
  and all three wind modes; five linked tabs, initial visibility, unique labeled
  inputs, contextual controls, shared wind bounds, collapsed help, blocked Start
  and visible boundary messages. Static rendering does not exercise clicks,
  keyboard focus, responsive layout or a live browser worker.
- `npm run check:browser-range`: existing full-range worker suite passes; added
  checks send below-range, above-range and non-finite values for every numeric
  setting through the actual worker and confirm shared bounds plus dynamic
  initial-pitch constraints.
- `npm run check:live-settings`: exact worker/offline parity, live tuning,
  Start/Stop/Reset, legacy controller regression and six existing suites pass.
- `npm run lint`, `npx tsc -b`, and production build via
  `npm run build -- --outDir .step7-build` pass. Temporary build output is removed
  afterward; the existing dist directory is untouched.
- Local development page responds with HTTP 200. Automated interactive/visual
  browser review remains unavailable: the browser-control connection fails
  during setup, including a fresh-session retry. The manual review above is
  still needed; static rendering is not a substitute for it.

## Files changed in this stage

- src/ui/ControlsPanel.tsx — five tabs, grouped existing controls and optional help.
- src/ui/SimulationToolbar.tsx — persistent run actions and operation status.
- src/ui/InfoDisclosure.tsx — shared native information expander.
- src/ui/SimulationDashboard.tsx — shorter header and revised composition.
- src/ui/SliderRow.tsx — labels and safe numeric editing.
- src/ui/StatusPanel.tsx — compact summary with expandable statistics.
- src/ui/FowtSchematic.tsx — optional extra readouts.
- src/ui/PlotPanel.tsx — optional plot statistics and help.
- src/index.css — compact responsive layout, tabs, focus styles and run bar.
- src/sim/settingRanges.ts — shared permitted numeric input ranges.
- src/sim/workerMessages.ts — compatibility constants reference shared ranges.
- src/sim/simulationWorker.ts — validation uses shared ranges.
- scripts/check-controls.mjs — static component checks.
- scripts/check-browser-range.mjs — actual-worker range checks.
- package.json — check:controls command.
- This document — review procedure and verification limits.

All earlier uncommitted work is retained. Proposed next stage: Step 8, dedicated
controller diagnostics and clearer power presentation, after explicit instruction.
