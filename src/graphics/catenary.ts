// Elastic, uniform-weight quasi-static line: anchor on a flat, frictionless bed,
// fairlead above it. Coordinates x/z [m] run from anchor toward fairlead, z up.
// No bending, drag, inertia, seabed friction or force coupling to the simulator.
export interface CatenaryInput { horizontalM: number; heightM: number; lengthM: number; stiffnessN: number; weightNPerM: number }
export interface LinePoint { s: number; x: number; z: number }
export interface CatenaryProfile {
  regime: "slack" | "touchdown" | "suspended";
  horizontalTensionN: number; anchorVerticalN: number; fairleadVerticalN: number;
  bedLengthM: number; stretchedLengthM: number; residualM: number;
  pointAt: (s: number) => LinePoint;
  points: LinePoint[];
}

// Stable vertical displacement integral, including axial strain T/EA.
function suspendedZ(H: number, V: number, s: number, w: number, EA: number): number {
  const q = V + w * s;
  return s * (2 * V + w * s) / (Math.hypot(H, q) + Math.hypot(H, V)) + (V * s + w * s * s / 2) / EA;
}
function suspendedX(H: number, V: number, s: number, w: number, EA: number): number {
  return H / w * (Math.asinh((V + w * s) / H) - Math.asinh(V / H)) + H * s / EA;
}

export function solveCatenary(input: CatenaryInput, segments = 128): CatenaryProfile {
  const { horizontalM: x, heightM: z, lengthM: L, stiffnessN: EA, weightNPerM: w } = input;
  if (![x, z, L, EA, w].every(Number.isFinite) || x < 0 || z <= 0 || L <= 0 || EA <= 0 || w <= 0 ||
    !Number.isInteger(segments) || segments < 8 || segments > 4096) throw new Error("Unsupported catenary inputs (anchor must be on bed, fairlead above it).");
  const verticalSlackLength = 2 * z / (1 + Math.sqrt(1 + 2 * w * z / EA));
  let H = 0, V = 0, bed = Math.max(0, L - verticalSlackLength);
  let regime: CatenaryProfile["regime"] = "slack";

  // For fixed H, height uniquely determines suspended length (touchdown) or
  // positive anchor vertical tension (fully suspended). Both join at bed = 0.
  const atH = (h: number) => {
    const d = 2 * EA * w * z / (Math.hypot(EA + h, Math.sqrt(2 * EA * w * z)) + EA + h);
    const suspended = Math.sqrt(d * (2 * h + d)) / w;
    if (suspended <= L) {
      const b = L - suspended;
      return { x: b * (1 + h / EA) + suspendedX(h, 0, suspended, w, EA), bed: b, V: 0 };
    }
    let lo = 0, hi = Math.max(w * L, EA * z / L);
    for (let i = 0; i < 64; i++) {
      const v = (lo + hi) / 2;
      if (suspendedZ(h, v, L, w, EA) < z) lo = v; else hi = v;
    }
    const v = (lo + hi) / 2;
    return { x: suspendedX(h, v, L, w, EA), bed: 0, V: v };
  };

  if (x > bed || verticalSlackLength > L) {
    // Exactly vertical and stretched: the entire line is hanging under tension.
    if (x === 0) { bed = 0; V = EA * (z / L - 1) - w * L / 2; regime = "suspended"; }
    else {
      let lo = 0, hi = w * L;
      for (let i = 0; atH(hi).x < x; i++) {
        if (i >= 60) throw new Error("Catenary horizontal tension did not bracket.");
        hi *= 2;
      }
      for (let i = 0; i < 64; i++) {
        const h = (lo + hi) / 2;
        if (atH(h).x < x) lo = h; else hi = h;
      }
      H = (lo + hi) / 2;
      const result = atH(H); bed = result.bed; V = result.V;
      regime = bed > 1e-8 ? "touchdown" : "suspended";
    }
  }

  // A zero-tension slack bed layout is nonunique. Use a folded-back straight
  // segment, explicitly illustrative; it preserves length instead of truncating it.
  const fold = regime === "slack" ? (bed - x) / 2 : 0;
  const pointAt = (s: number): LinePoint => {
    if (!Number.isFinite(s) || s < 0 || s > L) throw new Error("Line coordinate outside unstretched length.");
    if (s === 0) return { s: 0, x: 0, z: 0 };
    if (regime === "slack" && s <= bed) return { s, x: s <= fold ? -s : s - 2 * fold, z: 0 };
    if (s <= bed) return { s, x: s * (1 + H / EA), z: 0 };
    const u = s - bed;
    if (H === 0) return { s, x, z: u + (V * u + w * u * u / 2) / EA };
    return { s, x: bed * (1 + H / EA) + suspendedX(H, V, u, w, EA), z: suspendedZ(H, V, u, w, EA) };
  };
  const end = pointAt(L);
  const residualM = Math.hypot(end.x - x, end.z - z);
  if (!Number.isFinite(residualM) || residualM > 1e-5) throw new Error(`Catenary endpoint residual ${residualM.toExponential(2)} m.`);
  const suspended = L - bed;
  const q = V + w * suspended;
  const primitive = (v: number) => (v * Math.hypot(H, v) + H * H * Math.asinh(v / H)) / 2;
  const extension = H === 0 ? (V * suspended + w * suspended * suspended / 2) / EA : (primitive(q) - primitive(V)) / (w * EA);
  // Concentrate vertices near touchdown/anchor, where curvature is highest.
  // A straight bed portion needs only its ends (and the slack fold).
  const coordinates = [0];
  if (bed > 0) coordinates.push(bed);
  for (let i = 1; i <= segments; i++) coordinates.push(bed + suspended * (i / segments) ** 2);
  if (fold > 0) coordinates.push(fold);
  coordinates.sort((a, b) => a - b);
  return { regime, horizontalTensionN: H, anchorVerticalN: V, fairleadVerticalN: q,
    bedLengthM: bed, stretchedLengthM: L + bed * H / EA + extension, residualM,
    pointAt, points: coordinates.map(pointAt) };
}
