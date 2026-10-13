# IEA 15 MW / UMaine VolturnUS-S display geometry

**Modified reference-derived geometry**, made for the fowt-demo browser view.
These meshes are display surfaces, not a structural or hydrodynamic model.

Source: [IEAWindSystems/IEA-15-240-RWT](https://github.com/IEAWindSystems/IEA-15-240-RWT),
revision **e4993d63de10f165389534461dd544006750fe60**, Apache License 2.0
([included licence](LICENSE.txt)). The repository provides no separate NOTICE.
Source CAD is credited upstream to WindIO2CAD/OpenSCAD. No textures are imported.

Pinned inputs (all under that revision):

- `CAD/OpenSCAD/IEA-15-240-RWT_blade.scad.zip` and `.stl.zip`.
- `CAD/OpenSCAD/IEA-15-240-RWT_VolturnUS-S_tower.scad.zip` and `.stl.zip`.
- `CAD/OpenSCAD/IEA-15-240-RWT_VolturnUS-S_floater.scad.zip` and `.stl.zip`.
- `WT_Ontology/IEA-15-240-RWT_VolturnUS-S.yaml`.
- `OpenFAST/IEA-15-240-RWT-UMaineSemi/IEA-15-240-RWT-UMaineSemi_ElastoDyn.dat`.

`geometry-manifest.json` records SHA-256 hashes of every input, output hash,
source/output bounds, triangle counts and measured section/span approximation errors.

## Changes made for this derivative

`reference-geometry.glb` contains three indexed meshes, with positions and unit
normals in float32, indices in uint16. No compression decoder is needed.

- **Blade:** loft of the 151 supplied SCAD airfoil sections, retaining their
  built-in twist and reference-axis prebend. Adaptive simplification retains
  44 span stations and 37 corresponding perimeter points. Maximum measured
  source-section polyline deviation is 14.854 mm; span interpolation deviation
  at source stations is 13.349 mm. These are separate geometric criteria, not a
  CFD tolerance or a Hausdorff claim against the supplied STL. The STL is a
  single global convex hull of the sections; we intentionally use the section
  loft instead, preserving the local airfoil shape. Closed root-edge duplicates
  are welded, degenerate triangles removed and caps split for hard rim normals.
  No additional twist or prebend is applied by the runtime.
- **Floating tower:** regenerated from ontology radius/Z stations, Z = 15 to
  144.386 m, diameter 10 m up to Z = 132 m then tapered to 6.5 m. Collinear
  stations removed; 64 circumferential segments. The separate tower CAD spans
  0–144.386 m and would be 15 m too tall if simply placed on the platform.
- **Floater:** regenerated with 64-segment columns, 16-segment 0.91 m upper
  radial struts, and 12.5 × 7 m rectangular lower pontoons. Rectangular exterior
  dimensions are recorded in comments in the same ontology revision. Its active
  circular displacement substitute (also used by CAD) extends to −21.2979 m.
  This exterior uses the documented −20 m keel and +15 m freeboard. Component
  solids overlap at joints; interior overlap faces are retained, not boolean-cut.
- **Materials/assembly:** applied in application code. Yellow platform, grey
  tower/nacelle and blue zero-pitch blades follow the existing 2D view. Nacelle
  housing, generator cover, spherical hub and spinner are restrained geometric
  approximations, not imported CAD; the cover radius is near the ontology's
  5.309 m generator radius. Materials are illustrative paint, not material data.

| Mesh | Triangles | Vertices |
|---|---:|---:|
| Blade (shared three times) | 3,232 | 1,692 |
| Floating tower | 384 | 322 |
| Floater | 1,252 | 1,302 |

GLB size: **110,936 bytes**, versus 4,632,854 bytes for the three uncompressed
source STLs. Original STL counts: blade 21,730, tower 146, floater 1,480.
The tower deliberately has more radial facets than the original 25-sided mesh.

## Component coordinates and placement

Geometry uses metres, right-handed X downwind / Y transverse / Z up. Blade
geometry is rooted at local (0,0,0), extends to Z = 117 m, and includes tip
reference-axis prebend X = −4 m. Tower and floater are already at their absolute
still-water elevations. The GLB's node rotations map local Z-up to glTF Y-up for
external viewers. The application extracts **local mesh geometry only** and
does not apply those viewer node rotations.

Runtime hierarchy is platform-pitch (+Y pivot at still water), nacelle at tower
top, shaft tilt, rotor azimuth (+X), each blade's azimuth offset, precone, root
translation, and blade pitch. OpenFAST ShftTilt −6° maps to engineering Ry(+6°),
so the upwind shaft rises. PreCone −4° maps to Ry(−4°), coning upwind. Hub offset
is −12.098 m along the shaft from tower-top +4.3495 m. Resulting hub centre is
approximately (−12.031726, 0, 150.000085) m. Root offset is 3.97 m along the coned
axis. Blade 1 is the upper blade at zero azimuth. Positive feather uses −Z local
rotation: the leading edge (−Y) turns upwind (−X). Twist is already in the mesh.

Stage 3 drives azimuth, collective pitch and platform pitch from the existing
simulation sample stream. These reference dimensions and fixed transforms do not alter simulator equations,
which retain zero shaft tilt and a 120 m aerodynamic radius. The GLB contains no
mooring geometry. Stage 4 calculates separate display-only mooring lines from
`IEA-15-240-RWT-UMaineSemi_MoorDyn.dat`, copied unchanged from this same reference
revision (SHA256 `606c681b051f793026bed56e4b8f349f93c9763cb7c0dba4326d4fba815d7d8b`).
The same included Apache-2.0 source licence applies. Runtime constants use its
three anchor/fairlead pairs, 850 m length, 685 kg/m mass, 0.333 m equivalent
displaced diameter and 3.27e9 N stiffness. Sea/seabed textures and anchor symbols
are application illustrations. No new physical forces are coupled into the model.

## Rebuild

From the repository root, use Python with NumPy and PyYAML installed:

```sh
python scripts/build-reference-geometry.py --download
npm run check:geometry
```

Omit `--download` to reuse `.stage2-sources.local`. The generator, parameters and
provenance are included in the repository; no external CAD application is needed.
