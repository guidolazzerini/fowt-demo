import { BufferAttribute, BufferGeometry, Camera, Group, Line, LineBasicMaterial, Vector3 } from "three";
import type { RefObject } from "react";
import type { DisplayPose } from "./samplePlayback";
import { windArrowLengthM } from "./sceneMotion";

export interface SceneOverlayRefs {
  wind: RefObject<HTMLDivElement | null>;
  pitch: RefObject<HTMLDivElement | null>;
  warning: RefObject<HTMLParagraphElement | null>;
}

export function createPitchIndicator() {
  const group = new Group(); group.name = "platform-angle-dimension";
  const line = (name: string, count: number, color: string) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
    const object = new Line(geometry, new LineBasicMaterial({ color, depthTest: false }));
    object.name = name; object.frustumCulled = false; object.renderOrder = 2; group.add(object); return object;
  };
  // Conventional signed angle dimension: fixed upright datum, moving platform
  // axis and intervening arc in the engineering XZ plane. No angular magnification.
  const datum = line("vertical-datum", 2, "#7c8a96");
  datum.geometry.setFromPoints([new Vector3(0, -16, 0), new Vector3(0, -16, 43)]);
  const axis = line("platform-axis", 2, "#704db3"), arc = line("pitch-angle-arc", 33, "#704db3");
  return { group, update(theta: number | undefined) {
    group.visible = theta !== undefined;
    if (theta === undefined) return;
    const axisPositions = axis.geometry.getAttribute("position") as BufferAttribute;
    axisPositions.setXYZ(0, 0, -16, 0); axisPositions.setXYZ(1, 43 * Math.sin(theta), -16, 43 * Math.cos(theta));
    axisPositions.needsUpdate = true;
    const arcPositions = arc.geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i <= 32; i++) arcPositions.setXYZ(i, 32 * Math.sin(theta * i / 32), -16, 32 * Math.cos(theta * i / 32));
    arcPositions.needsUpdate = true;
  } };
}

// DOM labels track the SAME interpolated pose as meshes, without React renders
// per frame. Hide when behind/outside camera. Labels cannot intercept orbit input.
export function placeSceneIndicators(refs: SceneOverlayRefs, pose: DisplayPose | undefined,
  camera: Camera, width: number, height: number, warning: string) {
  const place = (element: HTMLDivElement | null, position: Vector3, text: string) => {
    if (!element) return;
    camera.updateMatrixWorld();
    const front = position.clone().applyMatrix4(camera.matrixWorldInverse).z < 0;
    const point = position.project(camera);
    const visible = pose && front && Math.abs(point.x) < 0.95 && Math.abs(point.y) < 0.95 && Math.abs(point.z) <= 1;
    element.style.visibility = visible ? "visible" : "hidden";
    element.style.left = `${(point.x + 1) * width / 2}px`;
    element.style.top = `${(1 - point.y) * height / 2}px`;
    if (element.textContent !== text) element.textContent = text;
  };
  place(refs.wind.current, new Vector3(-105 + windArrowLengthM(pose?.windSpeedMps ?? 0) / 2, 0, 85),
    `Wind ${pose?.windSpeedMps.toFixed(1) ?? "—"} m/s`);
  const angle = pose?.platformPitchRad ?? 0;
  place(refs.pitch.current, new Vector3(48 * Math.sin(angle / 2), -16, 48 * Math.cos(angle / 2)),
    `Platform θ ${angle >= 0 ? "+" : ""}${(angle * 180 / Math.PI).toFixed(2)}°`);
  if (refs.warning.current && refs.warning.current.textContent !== warning) refs.warning.current.textContent = warning;
}
