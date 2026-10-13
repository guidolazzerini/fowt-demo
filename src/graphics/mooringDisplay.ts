import { BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Mesh, MeshStandardMaterial, SphereGeometry } from "three";
import { solveCatenary } from "./catenary";
import { LINE_WEIGHT_N_PER_M, MOORING, MOORING_ENDPOINTS, pitchedFairlead } from "./mooringReference";

// Fixed buffers are reused on every pose. One-pixel curves and anchor/fairlead
// symbols aid visibility; these are not resolved chain-bar exterior geometry.
export function createMooringDisplay() {
  const group = new Group(); group.name = "quasi-static-moorings";
  const material = new LineBasicMaterial({ color: "#344e63" });
  const markerMaterial = new MeshStandardMaterial({ color: "#766552", roughness: 0.9 });
  const anchorGeometry = new SphereGeometry(4, 12, 8), fairleadGeometry = new SphereGeometry(1.2, 12, 8);
  const lines = MOORING_ENDPOINTS.map(({ anchor }, index) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(132 * 3), 3));
    const line = new Line(geometry, material); line.name = `mooring-${index + 1}`;
    line.frustumCulled = false; // Its reused buffer changes with platform pose.
    const anchorMarker = new Mesh(anchorGeometry, markerMaterial); anchorMarker.position.fromArray(anchor);
    const fairlead = new Mesh(fairleadGeometry, markerMaterial);
    group.add(line, anchorMarker, fairlead);
    return { line, fairlead };
  });
  let lastPitch = NaN, status = "";
  return { group, update(theta: number | undefined): string {
    group.visible = theta !== undefined;
    if (theta === undefined) return "";
    if (theta === lastPitch) return status;
    lastPitch = theta;
    const issues: string[] = [];
    MOORING_ENDPOINTS.forEach(({ anchor, fairlead }, i) => {
      const end = pitchedFairlead(fairlead, theta);
      lines[i].fairlead.visible = end.every(Number.isFinite);
      if (lines[i].fairlead.visible) lines[i].fairlead.position.set(...end);
      try {
        const dx = end[0] - anchor[0], dy = end[1] - anchor[1], distance = Math.hypot(dx, dy);
        const profile = solveCatenary({ horizontalM: distance, heightM: end[2] - anchor[2],
          lengthM: MOORING.lengthM, stiffnessN: MOORING.stiffnessN, weightNPerM: LINE_WEIGHT_N_PER_M });
        const positions = lines[i].line.geometry.getAttribute("position") as BufferAttribute;
        profile.points.forEach((point, j) => positions.setXYZ(j,
          anchor[0] + point.x * dx / distance, anchor[1] + point.x * dy / distance, anchor[2] + point.z));
        positions.needsUpdate = true;
        lines[i].line.geometry.setDrawRange(0, profile.points.length);
        lines[i].line.visible = true;
        if (profile.regime === "slack") issues.push(`Line ${i + 1}: slack; bed layout is illustrative.`);
      } catch (error) {
        // Never leave a stale or fabricated curve attached to a new pose.
        lines[i].line.visible = false;
        issues.push(`Line ${i + 1} hidden: ${error instanceof Error ? error.message : "catenary solve failed"}`);
      }
    });
    status = issues.join(" ");
    return status;
  } };
}
