import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from "three";
import type { DisplayPose } from "./samplePlayback";
import { pitchColour } from "../ui/pitchColour";

// Illustrative scale: 2.5 scene metres per m/s. Zero wind has no arrow; there is
// no nonzero floor or operating-range clamp hiding boundary excursions.
export function windArrowLengthM(windMps: number): number { return 2.5 * Math.max(0, windMps); }

export function createWindArrow(): Group {
  const arrow = new Group(); arrow.name = "free-stream-wind";
  arrow.position.set(-105, 0, 72); // World-fixed, independent of platform motion.
  const material = new MeshBasicMaterial({ color: "#e99b47" });
  const shaft = new Mesh(new CylinderGeometry(1, 1, 1, 12), material);
  shaft.name = "wind-shaft"; shaft.rotation.z = -Math.PI / 2;
  const head = new Mesh(new ConeGeometry(1, 1, 16), material);
  head.name = "wind-head"; head.rotation.z = -Math.PI / 2;
  arrow.add(shaft, head);
  return arrow;
}

// Resolve nodes once, rather than traverse meshes on every animation frame.
export function bindSceneMotion(assembly: Group, arrow: Group): (pose: DisplayPose | undefined) => void {
  const rotor = assembly.getObjectByName("rotor-azimuth")!;
  const pitches = [1, 2, 3].map(i => assembly.getObjectByName(`blade-${i}-pitch`)!);
  const blade = assembly.getObjectByName("blade-1") as Mesh;
  const bladeMaterial = blade.material as MeshStandardMaterial;
  const shaft = arrow.getObjectByName("wind-shaft")!;
  const head = arrow.getObjectByName("wind-head")!;
  return pose => {
    // Hide until the worker provides a valid pose; never present an invented one.
    if (!pose) { assembly.visible = false; arrow.visible = false; return; }
    assembly.visible = true;
    assembly.rotation.y = pose.platformPitchRad; // +Y tilts downwind; no ±12° clamp/amplification.
    rotor.rotation.x = pose.rotorAzimuthRad; // Sampled azimuth, never RPM integrated here.
    pitches.forEach(pitch => { pitch.rotation.z = -pose.collectivePitchRad; }); // Full 90° feather supported.
    // Match the 2D pitch colour cue. Only colour saturates, NOT the blade angle.
    // Parse the same sRGB colour as SVG; Three converts it to linear internally.
    bladeMaterial.color.set(pitchColour(pose.collectivePitchRad * 180 / Math.PI));
    const length = windArrowLengthM(pose.windSpeedMps);
    arrow.visible = length > 0;
    const headLength = Math.min(10, length / 4);
    shaft.scale.y = length - headLength;
    shaft.position.x = (length - headLength) / 2;
    head.scale.set(Math.min(4, length / 8), headLength, Math.min(4, length / 8));
    head.position.x = length - headLength / 2;
  };
}
