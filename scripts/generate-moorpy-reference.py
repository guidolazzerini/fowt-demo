"""Generate independent catenary fixtures, not an application/build dependency.

Download the pinned MoorPy ZIP as described in docs/3d-view.md; NumPy, SciPy,
matplotlib and PyYAML are required in the Python validation environment.
No MoorPy source is bundled with the browser app.
"""
import hashlib
import json
from pathlib import Path
import sys
import math

ROOT = Path(__file__).resolve().parents[1]
REVISION = "1fb29f8eca2618543b2df7056adfdfce0265737b"
SOURCE = ROOT / ".stage4-reference.local" / f"MoorPy-{REVISION}"
sys.path.insert(0, str(SOURCE))
from moorpy import catenary  # noqa: E402

w = (685 - 1025 * math.pi * 0.333**2 / 4) * 9.81
endpoints = [([-58, 0, -14], [-837.6, 0, -200]),
             ([29, 50.229, -14], [418.8, 725.383, -200]),
             ([29, -50.229, -14], [418.8, -725.383, -200])]
cases = []
for pitch in [-20, -12, 0, 12, 20]:
    theta = math.radians(pitch)
    for i, (f, a) in enumerate(endpoints):
        end = [f[0]*math.cos(theta) + f[2]*math.sin(theta), f[1],
               -f[0]*math.sin(theta) + f[2]*math.cos(theta)]
        cases.append((f"pitch-{pitch}-line-{i+1}", math.hypot(end[0]-a[0], end[1]-a[1]), end[2]-a[2]))
cases += [("slack", 600, 186), ("near-slack", 665, 186),
          ("near-lift", 820, 186), ("suspended", 840, 186), ("stretched", 900, 186)]
results = []
for name, x, z in cases:
    *forces, info = catenary(x, z, 850, 3.27e9, w, CB=0, alpha=0,
                            Tol=1e-8, nNodes=65, MaxIter=200, plots=1)
    if info["error"]:
        raise RuntimeError(f"MoorPy failed: {name}: {info}")
    results.append({"name": name, "input": {"horizontalM": x, "heightM": z,
        "lengthM": 850, "stiffnessN": 3.27e9, "weightNPerM": w},
        "profileType": info["ProfileType"], "H": info["HF"], "V": info["VF"],
        "anchorVerticalN": forces[1], "bedLengthM": info["LBot"],
        "points": [[float(s), float(px), float(pz)] for s, px, pz in zip(info["s"], info["X"], info["Z"]) ]})
    print(name, "type", info["ProfileType"], "H", round(info["HF"]), "V", round(info["VF"]), "bed", round(info["LBot"], 3))
output = {"source": "https://github.com/NatLabRockies/MoorPy", "revision": REVISION,
          "catenarySha256": hashlib.sha256((SOURCE / "moorpy/Catenary.py").read_bytes()).hexdigest(),
          "assumptions": "CB=0, alpha=0, anchor on bed, 1025 kg/m3 water, 9.81 m/s2 gravity, equivalent diameter 0.333 m",
          "cases": results}
target = ROOT / "scripts/fixtures/moorpy-catenary.json"
target.parent.mkdir(exist_ok=True)
target.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
