# 3D view — Stages 1–4

## Release validation

After the reviewed hub/gauge refinements, the user authorized committing and
deploying this version. The complete `npm run check:all` suite (12 suites),
`npm run lint`, production build and local production HTTP smoke checks passed.
The build used ignored `.release-preview.local`; no generated `dist` files are
included. The existing large lazy-3D-chunk warning remains. Automated browser
interaction and long-run GPU-memory review remain unperformed in this environment;
the numerical and HTTP checks do not establish those results. Stage 5 browser
review can still be performed separately after release.
The imported MoorDyn file has a path-specific `.gitattributes` rule preserving
its original bytes/whitespace; Git line-ending normalization must not alter the
pinned SHA256 checked by the catenary suite.

## Current: Stage 4, moorings and presentation refinement

This stage preserves the local Stage 1–3 work on `feat/static-3d-view`. The
simulation model, worker and controller are unchanged. No commit, push or
deployment was made. Baseline motion/UI checks passed before editing.

### Interface and view

Review refinement: the pointed spinner is now a rounded ellipsoidal cap
(semi-axes 3.5/3.4/3.4 m, centre X=−2 m relative to the rotor hub), still an
illustrative enclosure. Hub/blade pivots are unchanged. Both gauges are about
20% larger, with labelled 5 RPM and 7.55 RPM ticks (the latter is rated speed).
`src/ui/pitchColour.ts` supplies one continuous sRGB scale to the 2D blades,
3D blade material and pitch gauge: blue at 0°, yellow at 14°, red at/above 28°.
Lighting affects the shaded blade appearance; gauges still read the latest sample
while blade poses/colours follow the brief display interpolation.

Refinement files: `referenceAssembly.ts`, `sceneMotion.ts`, `SceneGauges.tsx`,
`FowtSchematic.tsx`, `src/index.css`, new `src/ui/pitchColour.ts`, and this guide.
Passed after the refinement: lint, production build, `check:controls`,
`check:geometry`, `check:motion`, production HTTP smoke check and diff check.
Browser appearance still requires local review. No physics changes or deployment.

- **At a glance** is below the turbine visualization, in both 2D and 3D.
- Rotor-speed and collective-pitch gauges reuse the actual 2D SVG components.
  The 3D speed scale starts at zero for parked operation; pitch covers −5° to 90°.
  Needles clamp to the gauge scale, while numeric readings retain the actual value.
  The original 2D speed scale remains unchanged.
- Wind speed is projected beside its arrow. Arrow length is now 2.5 scene metres
  per m/s (25% larger); shaft/head thickness also increased. It still represents
  simulated free-stream wind, not filtered or estimated controller wind.
- A signed platform-pitch angle arc, fixed vertical datum and moving axis sit
  beside the platform. They use the actual engineering XZ-plane angle, without
  amplification or a claimed optimum. The dimension plane is offset 16 m in −Y
  for legibility. Viewed obliquely, its screen angle is foreshortened; the signed
  numeric label always reports the actual angle. Positive means downwind tilt.
- Nearby labels use the same interpolated pose as the turbine and moorings.
  Gauges use the latest sample, which can lead that pose by up to 250 ms. Labels
  hide outside/behind the camera and do not intercept orbit controls.
- Camera presets: Turbine, Platform, Underwater, Full mooring layout. Reset view
  restores the selected preset. The full footprint is at true scale, not compressed.
  Water can be transparent (default), surface-tinted or hidden. Seabed and moorings
  have independent visibility controls. These controls never message the worker.
- Still water at Z=0 and a procedural sand surface at Z=−200 m are illustrative.
  There is no wave load, added platform motion or bathymetry beyond the flat plane.

### Reference and physical assumptions

The mooring input is pinned to the same IEA revision as the exterior geometry:
[`e4993d63de10f165389534461dd544006750fe60` MoorDyn file](https://github.com/IEAWindSystems/IEA-15-240-RWT/blob/e4993d63de10f165389534461dd544006750fe60/OpenFAST/IEA-15-240-RWT-UMaineSemi/IEA-15-240-RWT-UMaineSemi_MoorDyn.dat).
An unchanged copy ships with the asset attribution/licence. Tests check its SHA256
and compare runtime constants directly to the file.

| Quantity | Value |
|---|---|
| Unstretched length per line | 850 m |
| Axial stiffness EA | 3.27e9 N |
| Dry mass per length | 685 kg/m |
| Displaced-volume equivalent diameter | 0.333 m (not 0.185 m chain-bar diameter) |
| Assumed seawater density / gravity | 1025 kg/m³ / 9.81 m/s² |
| Submerged weight w | 5844.117996654215 N/m |
| Contact plane / friction | Z=−200 m / zero friction |

Fairleads (−58,0,−14), (29,50.229,−14), (29,−50.229,−14) m rotate with the
**displayed** platform Ry(theta) about the still-water tower origin. Anchors remain
at (−837.6,0,−200), (418.8,725.383,−200), (418.8,−725.383,−200) m in world space.
All line geometry is evaluated between these endpoints. One-pixel curves and
4 m/1.2 m anchor/fairlead symbols aid visibility; they are not chain CAD or
dimensionally accurate anchor hardware.

`catenary.ts` solves the elastic uniform-weight catenary independently of the
simulation. For a suspended segment of unstretched length s, horizontal tension
H and lower-end vertical tension V, the integrated endpoint equations are:

```text
x(s) = H/w [asinh((V+w*s)/H) − asinh(V/H)] + H*s/EA
z(s) = [sqrt(H²+(V+w*s)²) − sqrt(H²+V²)]/w + (V*s+w*s²/2)/EA
```

Touchdown has V=0, and a bed segment b contributes x=b*(1+H/EA), z=0. Fully
suspended profiles have b=0 and V≥0. The solver brackets horizontal tension and
solves the vertical equation at each trial; it checks endpoint residual ≤1e−5 m.
Analytical zero-horizontal-tension limits handle slack and vertical cases. A
slack bed layout is nonunique; the displayed folded-back straight layout preserves
unstretched length but is explicitly labelled illustrative. Unsupported input or
solver failure hides that curve and displays a status message instead of stale
geometry. Fairlead must be above the bed; buoyant lines and off-bed anchors are
outside this solver's scope.

Sampling concentrates points near touchdown, preserving a straight bed segment.
Only ~130 vertices per line are needed, with fixed GPU buffers reused for every
pose. Lines are recomputed only when displayed platform pitch changes. Stop,
Reset and delayed-sample handling remain those of Stage 3. Explicit cleanup
includes line geometries/materials, markers, angle indicators and the sand texture.

This is a linear-elastic **quasi-static display model**, not dynamic MoorDyn.
It excludes friction, inertia, drag, bending, breaking and hysteretic contact.
No forces or additional stiffness are fed back into `model.ts`; future force
coupling must first reconcile the aggregate `platformPitchStiffnessNm`.

### Independent validation and the reference plotting caveat

MoorPy was downloaded for validation only, pinned at
[`1fb29f8eca2618543b2df7056adfdfce0265737b`](https://github.com/NatLabRockies/MoorPy/tree/1fb29f8eca2618543b2df7056adfdfce0265737b).
Its `Catenary.py` SHA256 is
`41720c4a0a30e3637291f8e14c0b20c985919e4b7dcfa21cd388773bf9a98fd5`.
No Python/MoorPy dependency is added to the browser build. Raw generated fixtures
record the revision, assumptions and reference results; `check:catenaries` reuses
them without requiring Python. [MoorPy documentation](https://moorpy.readthedocs.io/en/latest/)
describes its quasi-static scope.

Twenty comparisons use CB=0, alpha=0 and the same L, EA and wet weight: three
reference lines at −20°, −12°, 0°, +12°, +20°, plus slack, near-slack,
near-lift-off, fully suspended and stretched cases. Maximum tension difference was
5.46e−5 N; suspended profile agreement was within 0.1 mm (test tolerance). At zero
platform pitch, line 1 has approximately H=1.350 MN, fairlead vertical=2.028 MN,
total fairlead tension=2.436 MN and 502.956 m unstretched bed contact.
These are static calculation results, not dynamic tensions.

**Reference plotting discrepancy:** this MoorPy revision's CB=0 bed plotting
branch uses x=s, omitting H*s/EA, although its end/force equations include bed
strain. The raw plotted coordinate difference reaches 0.283887 m in these tests.
Fixtures remain untouched; the comparison explicitly checks this known term.
After accounting for it, maximum profile discrepancy is 2.23e−9 m. Slack bed
layouts are nonunique, and MoorPy's plotted slack vertical segment is approximate;
slack tests therefore compare forces/contact to MoorPy and check our exact
elastic length/endpoints analytically, not against that plotting approximation.
This caveat is not hidden by a loose profile tolerance.

Other checks cover 801 horizontal-distance cases across contact regimes,
elastic arc-length convergence (maximum 1.32e−6 m discrepancy using 4096 segments),
vertical/invalid inputs, actual rendered endpoints/contact, failure/recovery and
disposal. A 240-pose sweep (720 line solves) took about 17–20 ms in Node on this
machine. This is a CPU calculation check, **not browser FPS or GPU-memory evidence**.

To regenerate the fixtures, download the pinned ZIP into `.stage4-reference.local`,
extract it there, and run `py -3.13 scripts/generate-moorpy-reference.py` with
NumPy, SciPy, matplotlib and PyYAML available. The source folder must be
`.stage4-reference.local/MoorPy-1fb29f8eca2618543b2df7056adfdfce0265737b`.
Then run `npm run check:catenaries` (or `node scripts/check-catenaries.mjs`).

### Stage 4 checks and local review

Passed: lint, TypeScript/production build, control/UI markup, geometry, motion,
catenary comparison and browser-worker operating-range checks. Motion checks now
include signed angle geometry, projected wind/angle text and behind-camera hiding.
UI markup checks verify **At a glance** follows the turbine and test the reused
gauges at parked/feathered conditions. The final full `check:all` gate remains
Stage 5. Vite's existing lazy-chunk size warning remains; there are no new npm
dependencies. The worker remains byte-identical to Stage 3.
Production HTTP smoke checks also passed on port 4178, including exact served
bytes for the GLB, manifest, attribution, licence and official MoorDyn input.
`git diff --check` passed. `dist` was not edited; production output is isolated
in ignored `.stage4-preview.local`. Sandbox subprocess/download failures were
rerun with permission. Implementation lint/type/test failures were corrected
before the passing results above.

Browser inventory returned no available browser. No WebGL screenshot, visual
layout check, camera interaction or browser memory test was performed. Review
label/gauge placement and long-run behaviour locally:

```sh
npm run build -- --outDir .stage4-preview.local
npm run preview -- --outDir .stage4-preview.local --host 127.0.0.1 --port 4178 --strictPort
```

1. Open http://127.0.0.1:4178/ and select **3D · live motion**. Confirm the two
   gauges, wind value by the enlarged arrow, signed platform arc and status below.
2. Orbit in both Turbine and Platform presets. Change wind and use Stop/Reset;
   watch pitch, rotor speed, arrow and fairleads remain consistent with the pose.
3. Choose **Full mooring layout**: all three anchors should be visible hundreds
   of metres away. Inspect touchdown and the straight bed portions. Use
   Underwater with transparent/hidden water to inspect the submerged platform.
4. Toggle water, seabed and moorings. Reset view, resize/narrow the window and
   switch 2D/3D repeatedly. Time, settings and history must persist. Check labels
   for overlap/clipping, the console for errors and Chrome memory for growth.
5. Run startup/shutdown: gauges must include zero rpm and 90° pitch, with moorings
   following platform motion even while the rotor parks. Stop must freeze the pose.

Files added: `src/graphics/catenary.ts`, `mooringReference.ts`, `mooringDisplay.ts`,
`sceneIndicators.ts`, `SeaAndSeabed.tsx`, `src/ui/SceneGauges.tsx`,
`scripts/check-catenaries.mjs`, `scripts/generate-moorpy-reference.py`,
`scripts/fixtures/moorpy-catenary.json`, and the official MoorDyn source copy.
Updated: `FowtScene3D.tsx`, `TurbineAssembly3D.tsx`, `sceneMotion.ts`,
`referenceAssembly.ts`, `SimulationDashboard.tsx`, `FowtSchematic.tsx`,
`src/index.css`, control/motion checks, `package.json`, README, this guide and
asset attribution. Replaced `SceneReadouts.tsx` with `SceneGauges.tsx`.

**Proposed Stage 5, awaiting approval:** integrated browser/visual/performance
review and full regression gate. Publishing remains separately authorized.

## Historical Stage 3: simulation-driven motion

The selector is **3D · live motion**; 2D remains the initial default. Existing
Stage 1–2 work is preserved on `feat/static-3d-view` at base `6d02985`. No worker,
controller, simulation equation or mesh asset changed. Nothing was committed,
pushed or deployed. Geometry and control checks passed before this stage.

Four compact readouts replace all old spatial geometry labels: rotor speed (rpm),
collective blade pitch (degrees), simulated free-stream wind (m/s), and platform
pitch (degrees). Readouts use the latest received sample. The orange world-fixed
+X arrow has length 2 scene metres per m/s, with zero wind hiding it. This is a
display scale, not a physical displacement. It uses `windSpeedMps`, not the
COFLEX estimate or the controller's filtered signal. Blade colour retains the 2D
blue/yellow/red pitch cue. Colour saturates at 28°; blade angle does not.

### Motion, timing and ownership

The dashboard still owns one `useSimulation` call/worker. It passes the existing
latest sample and run state into the view. No display code posts worker messages,
changes settings, integrates rotor speed or adds physical forces. Camera reset is
independent of simulator Reset. Switching away unmounts the GPU scene; switching
back starts at the latest pose, without replaying old history.

`samplePlayback.ts` holds two poses, not an accumulating sample history. It uses
simulation timestamp differences and measured wall-clock receipt intervals to
blend successive received poses. The nominal 3.2× rate is not hardcoded. The
display targets the latest received sample over the measured interval (at most
250 ms); it holds at that endpoint rather than extrapolating when samples pause.
Readouts therefore lead the rendered pose slightly during interpolation.

Azimuth is unwrapped forward across 2π. For unusually large sample intervals,
endpoint average speed times simulated duration disambiguates whole revolutions;
it never drives motion beyond the supplied azimuth. This is an approximation if
speed changes sharply across a multi-turn interval. A receipt gap over 500 ms
snaps to fresh data rather than inventing missing revolutions. Duplicate timestamps
update values without inventing elapsed time. Backward time, Reset and resume
clear interpolation history. Stop/error settle to the latest **received** pose
and freeze; the worker currently sends no additional sample on Stop, so that pose
can precede its private stopped state by one sample publication interval.

Transforms preserve the Stage 2 hierarchy: platform Ry(theta) at the still-water
origin, fixed shaft tilt, rotor Rx(azimuth), per-blade azimuth/precone/root offset,
then local Rz(-beta). Blade twist/prebend remain baked into the mesh exactly once.
There is no ±12° platform clamp or motion amplification. Zero rpm and full 90°
feather are supported. Physical startup/shutdown continue while run state is
running, even as the rotor parks; Stop freezes the simulation clock separately.
Reference visual shaft tilt remains different from the unchanged zero-tilt model.
Still water creates no platform motion.

Fiber demand frames run only while blending or interacting with the camera.
Animation mutates owned Three objects outside React render; it does not update
React state per frame. Fiber removes the frame subscription on unmount, and the
assembly plus wind-arrow geometries/materials are explicitly disposed. The shared
CPU source asset remains cached. See the [Fiber hook documentation](https://r3f.docs.pmnd.rs/api/hooks).

### Stage 3 validation and remaining browser review

Passed: `npm run lint`, `npm run build -- --outDir .stage3-preview.local`,
`npm run check:motion`, `npm run check:geometry`, `npm run check:controls`,
`npm run check:browser-range`, and `npm run check:startup-shutdown`.
Also passed: `npm run check:preview -- http://127.0.0.1:4177/`, byte-for-byte
HTTP checks of the GLB/manifest/attribution/licence, and `git diff --check`.
The motion suite exercises accelerated rates, wrapped/multiple revolutions,
Stop/resume/Reset, missing/duplicate/delayed samples, frame-rate independence,
20,000 updates with bounded storage, parked/full-feather poses, actual GLB
transform signs/pivots, unclipped 20° platform pitch, arrow lengths and disposal.
Startup/shutdown regressions span 3–24.8 m/s plus turbulence and boundaries.
`check:motion` joins `check:all` for the final integration gate; the full suite
was not run at this stage. Sandbox EPERM launch failures were rerun successfully
with permission; they were not application failures. Lint issues introduced
during implementation were corrected before the final checks.

The production worker bundle remains `simulationWorker-CA2oQnxM.js`, identical
to Stage 2. The lazy 3D bundle is about 991 kB minified / 264 kB gzip; Vite's
existing >500 kB chunk warning remains. No dependencies were added this stage.
Browser inventory returned no available browser. No browser screenshot or WebGL
interaction test was performed. Numerical/markup tests do not prove visual
smoothness, GPU resource behaviour, mobile layout or camera interaction.

Files added in Stage 3: `src/graphics/samplePlayback.ts`,
`src/graphics/sceneMotion.ts`, `src/ui/SceneReadouts.tsx`, and
`scripts/check-scene-motion.mjs`. Updated: `FowtScene3D.tsx`,
`TurbineAssembly3D.tsx`, `referenceAssembly.ts` (comments), `TurbineView.tsx`,
`SimulationDashboard.tsx`, `src/index.css`, `scripts/check-controls.mjs`,
`package.json`, `README.md`, this guide and asset `SOURCES.md`.
Removed: `src/graphics/SceneAnnotations.tsx`. Dependency/lockfile changes visible
in Git belong to Stage 1; there are no further dependency changes in Stage 3.

### Review Stage 3 locally

Run `npm run dev` and open its printed URL, or use the production preview:

```sh
npm run build -- --outDir .stage3-preview.local
npm run preview -- --outDir .stage3-preview.local --host 127.0.0.1 --port 4177 --strictPort
```

1. Start at 8 m/s and select **3D · live motion**. Check forward rotation,
   blade pitch, four readouts and absence of old floating geometry labels.
2. Orbit/zoom and **Reset view** while running. Switch 2D/3D repeatedly: time,
   settings and plot history must continue. Narrow the window and check readouts.
3. Set 18 m/s, then try a gust/turbulence. Watch blade feathering and the orange
   arrow length. Platform tilt should agree in sign with the readout; unlike the
   SVG, the 3D pose is not clipped to ±12°.
4. Click **Stop**. Motion must settle and freeze, while orbit/zoom still work.
   Resume after a pause: no catch-up spin. **Reset** must show the new initial pose.
5. Select **Simple startup / shutdown · Reset to parked**, then Reset. Inspect
   stationary blades at 90°. **Start turbine** should unfeather and accelerate;
   **Shut down turbine** must keep moving as simulated time advances, feather and
   park. Orbit near the hub to inspect pitch about each blade's root.
6. Switch views at least 20 times and inspect Chrome console/Task Manager for
   WebGL errors or sustained memory growth. Check fallback with WebGL disabled.

**Proposed Stage 4, awaiting approval:** three reference-scale elastic quasi-static
catenaries, fixed seabed contact and illustrative sea/seabed, with solver validation
and no mooring-force feedback into the existing model.

## Historical Stage 2: static reference exterior

Stage 2 builds on the uncommitted Stage 1 changes on `feat/static-3d-view`.
Git still points to `6d02985`; no user changes were overwritten, no physics was
changed, and nothing was committed, pushed or deployed. Stage 1 lint/UI checks
were rerun before these changes and passed.

The selector now reads **3D · static reference**. It loads an optimised 111 kB
GLB, sharing one blade geometry across three blade instances. Blue blades,
yellow platform, grey tower/nacelle, light sky/water and a warm wind arrow follow
the existing 2D colour scheme. **Annotations** hides/shows camera-projected hub,
platform and wind-direction labels plus the waterline label. Geometry help stays
collapsed. These are geometric annotations, not live wind/rotor-speed readings.
The turbine remains static while the simulator continues independently.

### Reference data and optimisation

All inputs are pinned to `e4993d63de10f165389534461dd544006750fe60`.
Full attribution, differences, units, origins, transforms and rebuild instructions
are in [asset SOURCES.md](../public/models/iea15mw-volturnus/SOURCES.md).
The source licence and a machine-readable hash/quality manifest ship with the GLB.

Inspection identified three reasons to regenerate rather than blindly import:

- The blade SCAD applies one convex hull to all sections. A local section loft
  preserves its supplied airfoil shapes, twist and prebend instead.
- Floating tower CAD spans 0–144.386 m. The ontology/ElastoDyn places its base
  at 15 m and top at 144.386 m. Regeneration uses those actual elevations.
- CAD lower pontoons use the ontology's circular displacement equivalent,
  reaching Z = −21.2979 m. Regeneration uses the 12.5 × 7 m rectangular exterior
  documented in that same revision and the −20 m draft.

The blade retains 44 of 151 sections and 37 of 400 perimeter points, with measured
maximum section-polyline error 14.854 mm and source-station span interpolation
error 13.349 mm. These are separate approximation criteria, not a global error
claim against the convex-hull STL. Blade triangles drop from 21,730 to 3,232.
Floater triangles drop from 1,480 to 1,252. The tower uses 384 triangles rather
than 146, improving the original 25-sided silhouette to 64 circumferential sides.
The combined asset is 110,936 bytes versus 4,632,854 bytes of uncompressed STLs.
It needs no mesh compression decoder, textures, or new npm dependencies.

The platform now includes three 0.91 m upper radial struts. Component solids
overlap at their junctions; they are display surfaces, not a watertight analysis
mesh. Nacelle, generator cover, hub and spinner remain documented approximations.

### Transforms and lifetime

Rendering retains engineering X downwind / Y transverse / Z up, in metres.
The GLB stores component geometry in this frame; its node rotation exists only
for ordinary Y-up glTF viewers and is not copied into the application assembly.
The blade's section twist and −4 m tip-axis prebend are already baked in.

The hierarchy is platform pitch → nacelle/tower-top → shaft tilt → rotor azimuth
→ per-blade azimuth → precone → root translation → pitch → blade mesh. Shaft
Ry(+6°) maps OpenFAST −6° tilt, and precone Ry(−4°) cones upwind. The −12.098 m
shaft offset plus 4.3495 m tower-to-shaft height puts the hub at Z ≈ 150.000085 m.
The pitch root is 3.97 m along the coned axis. Increasing feathering uses local
Rz(−beta), so the leading edge turns upwind. These are fixed geometry poses only;
the unchanged simulation still has zero shaft tilt and aerodynamic radius 120 m.

The loader caches one CPU source asset. Each mounted assembly clones its three
geometries, shares the blade clone, and owns seven unique geometries/five materials
including the simple nacelle/hub primitives. Explicit cleanup disposes each owned
resource once without mutating/discarding the source cache. Annotation projection
uses Fiber's demand frames, only when the camera/view changes; it introduces no
motion or wall-clock integration. Existing worker/view ownership remains unchanged.

### Stage 2 validation

Passed: generator rebuild; `npm run check:geometry`; `npm run lint`;
`npm run build -- --outDir .stage2-preview.local`; `npm run check:controls`;
`npm run check:browser-range`; `npm run check:preview -- http://127.0.0.1:4176/`;
and `git diff --check`. GLB, manifest, attribution and licence were served with
correct MIME types and exact source bytes. An offline rebuild reproduced the
same GLB hash; the worker bundle is byte-identical to Stage 1.
Geometry checks use the real GLTFLoader and actual
assembly factory: hashes, bounds, finite/unit normals, outward winding, no
degenerate faces, mesh/size budgets, hub height, root pivots, shared blade resource,
precone/feather/azimuth/platform-pitch signs, and disposal. `check:geometry` is now
included in the future full `check:all` gate; the full suite was not run here.

An offline geometry plot was inspected for proportions and blade envelopes; it
was not a browser screenshot. Browser inventory again returned no available
browser, so WebGL appearance, projected-label placement/overlap, camera interaction,
mobile layout and repeated-switch memory still require local review. The lazy
3D JavaScript bundle is about 988 kB minified / 263 kB gzip (Vite's size warning
remains), separate from the 111 kB geometry asset. The renderer remains demand-driven.

### Review Stage 2 locally

Use `npm run dev`, or the checked production preview:

```sh
npm run preview -- --outDir .stage2-preview.local --host 127.0.0.1 --port 4176 --strictPort
```

1. Open **3D · static reference**. Inspect yellow columns/pontoons/struts and
   blue blades; orbit close enough to see blade twist/prebend and the tower taper.
2. Inspect the hub from the side: shaft rises toward the upwind rotor, blades
   cone away from the tower. Blade 1 is uppermost. Nothing should rotate yet.
3. Toggle **Annotations**, orbit, zoom and reset the camera. Labels should follow
   their anchors, disappear off-camera and never block pointer controls.
4. Inspect the submerged structure through the still-water plane. Keel is −20 m,
   top of platform +15 m, hub approximately +150 m.
5. Switch repeatedly to live 2D and back, running and paused. Confirm the same
   time, gains and history remain, and check console/Task Manager for problems.
6. Repeat on a narrow viewport; inspect labels and fallback if WebGL is disabled.

**Proposed Stage 3, awaiting approval:** connect the existing timestamped sample
stream to platform pitch, rotor azimuth and collective pitch; interpolate through
azimuth wrap and accelerated time, with explicit Stop/Reset/shutdown handling.
Moorings and sea/seabed styling remain Stage 4.

---

## Stage 1 record (historical prototype)

Stage 1 adds a **static, dimensioned prototype**, selected alongside the existing
live SVG. Detailed meshes, motion, moorings and sea/seabed styling are not implemented.
The initial view remains 2D. Nothing here changes the physical model or controllers.

## Working copy and baseline

- Checkout: `C:\_my_codes\fowt-demo`; remote `guidolazzerini/fowt-demo`.
- Started clean on `main` at `6d02985e9c37c9506d4b9079172dae20e1e1462a`,
  matching the reviewed snapshot. Local branch: `feat/static-3d-view`.
- No applicable `AGENTS.md` was found in the checkout or its parent directories.
- Active chain remains `src/main.tsx` → `src/App.tsx` → `SimulationDashboard`.
  Empty graphics/app placeholders were left alone. No archives were used.
- Baseline lint, TypeScript/production build, `check:controls` and
  `check:browser-range` passed before source edits.
- No commit, push or deployment is part of this stage.

## Geometry and coordinates

One rendering unit is **one metre**. Engineering and Three.js coordinates are
identical: **X downwind, Y transverse, Z upward**, right-handed. Camera up and
orbit polar axis are Z. Origin is still water at the tower axis. Primitive
cylinders are rotated from Three.js's Y axis to Z; the water plane is XY.

Dimensions are tied to official IEA-15-240-RWT revision
**`e4993d63de10f165389534461dd544006750fe60`**, using its
[floating ontology](https://github.com/IEAWindSystems/IEA-15-240-RWT/blob/e4993d63de10f165389534461dd544006750fe60/WT_Ontology/IEA-15-240-RWT_VolturnUS-S.yaml)
and [floating ElastoDyn input](https://github.com/IEAWindSystems/IEA-15-240-RWT/blob/e4993d63de10f165389534461dd544006750fe60/OpenFAST/IEA-15-240-RWT-UMaineSemi/IEA-15-240-RWT-UMaineSemi_ElastoDyn.dat).

| Component | Prototype geometry, metres |
|---|---|
| Central column | Diameter 10, bottom Z = −20, top Z = 15 |
| Three outer columns | Diameter 12.5; centre radius 51.75; azimuths 180°, +60°, −60°; same bottom/top |
| Three radial bottom pontoons | Rectangular width 12.5, height 7; Z = −20 to −13; overlap column solids at junctions |
| Floating tower | Base Z = 15, top Z = 144.386; simple taper from diameter 10 to 6.5 |
| Hub/rotor | Hub centre Z = 150, X = −12.098; root radius 3.97, tip radius 120.97 |
| Blades | Length 117; straight tapered planform, chord about 5.2–5.8 at root/inboard, 0.5 at tip; constant 0.65 thickness |
| Nacelle enclosure | Approximate 18 × 8 × 8 box; not reference CAD |

The ontology's lower-pontoon block retains the **12.5 × 7 rectangular exterior
dimensions in comments** and uses a 9.6148 m circular displacement equivalent
in its active data. This exterior prototype uses the rectangular dimensions,
not that equivalent circle. The straight tower taper simplifies the intervening
ontology stations. Blades are original simple solids, not airfoils or imported
reference surfaces. No third-party meshes or textures are distributed in Stage 1.

This stage intentionally uses a **horizontal shaft, zero precone, zero prebend
and zero pitch**, with blade 1 upward and a level platform. It does not copy the
SVG's separate −4° drawing rotation or its ±12° visual pitch clamp. The reference
ElastoDyn shaft tilt −6° and precone −4° are recorded, but their OpenFAST transform
mapping and any baked-in CAD transforms must be resolved in Stage 2. Hub height
is set directly to 150 m for this prototype; the nacelle/tower-top offset is an
approximation, not a tilted-shaft reconstruction.

For future motion, positive platform pitch about engineering +Y tilts the upper
tower downwind (+X). No platform, rotor or blade transforms are driven by samples
yet, and blade feathering signs remain a later validation gate. The simplified
physics still has shaft tilt zero, a 120 m aerodynamic radius and a 150 m hub lever
arm. Reference visual geometry must not silently change those equations.

## Integration and lifetime

- `TurbineView.tsx` owns only the 2D/3D choice. The dashboard still calls
  `useSimulation` once. The SVG remains mounted while hidden, including its
  disclosure state; the WebGL scene unmounts when returning to 2D.
- `FowtScene3D.tsx` is a lazy import: the initial page does not load Three.js.
  It accepts no simulation data or actions. Its stable props avoid rerendering
  the static scene on every simulation sample.
- Three.js `0.186.1`, React Three Fiber `9.8.1` and development types `0.186.0`
  are pinned. Registry peers were checked: Fiber accepts React/React DOM
  `>=19 <19.4` and Three `>=0.156`; installed React is 19.2.4. No Drei or other
  direct dependencies were needed. Existing package versions did not change.
- Rendering uses Fiber's [demand mode and error handling](https://r3f.docs.pmnd.rs/api/canvas),
  with pixel ratio capped at 1.5. OrbitControls changes request frames; there
  is no continuous animation loop or second physical model.
- Reset view and canvas resize refit the whole assembly to its aspect ratio.
  Drag orbits, wheel/pinch zooms, right-drag pans; focused canvas arrow keys pan.
  Camera reset never resets the simulator.
- Camera listeners are installed in an effect and disposed on cleanup, including
  keyboard and context-loss listeners. Fiber owns disposal of declarative scene
  geometry/materials and its renderer. This supports StrictMode effect cleanup.
- Loading/render failures and context loss show an explanation and a Return to
  live 2D button inside the panel. The worker and controls remain outside the
  error boundary. Context restoration is retried by selecting 2D then 3D.
- Still water is a translucent flat plane at Z = 0, with a reference grid.
  It introduces no waves or forces. No seabed or mooring lines are shown in 3D.

Worker timing is unchanged: 50 ms ticks, 8 × 0.02 s integration steps per tick,
and a sample every two ticks (nominal 3.2× simulated time). Later animation must
interpolate sample timestamps and wrapped azimuth, not assume wall-clock speed.

## Verification performed

After implementation:

```sh
npm run lint
npm run build -- --outDir .stage1-preview.local
npm run check:controls
npm run check:browser-range
npm run check:preview -- http://127.0.0.1:4175/
git diff --check
```

All passed. The UI suite now checks the default live-2D selection, explicit
static-3D label and absence of an initially mounted canvas. Existing worker tests
cover controller scenarios, boundaries, live settings, startup/shutdown and
worker/offline parity. No physics, worker, simulation-hook or SVG source changed.
The production worker bundle has the same SHA-256 as baseline.
The local preview passed HTTP/MIME/data checks. A separate asset check verified
the 3D chunk is a dynamic import and is served with the exact built contents.

The new lazy 3D bundle is approximately 940 kB minified / 249 kB gzip and triggers
Vite's 500 kB chunk warning; initial app JavaScript is about 255 kB / 79 kB gzip.
The warning is not suppressed. Mesh optimisation and further load-cost review
belong to later graphics stages.

`npm audit` reports 10 advisories (1 low, 2 moderate, 7 high), all for existing
packages at unchanged versions. No unrelated dependency upgrades were applied.
These are pre-existing dependency advisories, not lint/build/test failures.

**Browser validation limitation:** the available computer/browser tool reported
no browsers, and opening its in-app browser returned “Browser is not available”.
No WebGL screenshot, actual view-switch/camera/resize interaction, browser
context-loss test, or repeated-switch memory/listener test was performed. Source
review and static/worker checks do not establish that those browser checks pass.
The full `check:all` suite remains the Stage 5 integration gate.

## Local review

Run `npm run dev` and open Vite's printed URL. For the checked production build:

```sh
npm run preview -- --outDir .stage1-preview.local --host 127.0.0.1 --port 4175 --strictPort
```

1. Confirm the page starts in **2D · live motion**. Start the simulator; note
   time, current gains and plot history.
2. Select **3D · static prototype**. Confirm four columns, three pontoons, a
   tower, nacelle/hub and three blades. The turbine stays still while the
   simulation clock and plots continue. Inspect below water by orbiting.
3. Drag, scroll/pinch, right-drag and **Reset view**. Reset view should reframe
   the assembly without changing simulation time or controller settings.
4. Return to 2D: motion, history and edited gains should still be present.
   Repeat 10–20 times, both running and stopped. There should be one canvas
   in 3D and none in 2D, and no increasing retained contexts/listeners.
5. Try a narrow (~390 px) window and resize back: check full-model framing,
   readable buttons, no horizontal overflow and usable touch gestures.
6. Check Start, Stop, simulator Reset, gains and diagnostics in both views.
   Stop freezes the live simulation; camera inspection still works in 3D.
7. Check Chrome's console and Task Manager during repeated switching. Verify
   graceful fallback on a browser without WebGL, or on deliberate context loss
   in DevTools. A lost 3D view must not remove controls or the running worker.
