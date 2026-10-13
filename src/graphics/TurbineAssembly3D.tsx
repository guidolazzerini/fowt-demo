import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { Mesh } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createReferenceAssembly, disposeReferenceAssembly, type ReferenceGeometries } from "./referenceAssembly";
import { SamplePlayback, type DisplayPose } from "./samplePlayback";
import { bindSceneMotion, createWindArrow } from "./sceneMotion";
import type { SimulationRunState } from "../app/useSimulation";
import { createMooringDisplay } from "./mooringDisplay";
import { createPitchIndicator, placeSceneIndicators, type SceneOverlayRefs } from "./sceneIndicators";

export function TurbineAssembly3D({ sample, runState, overlays, showMoorings }: {
  sample: DisplayPose | undefined; runState: SimulationRunState; overlays: SceneOverlayRefs; showMoorings: boolean;
}) {
  const asset = useLoader(GLTFLoader, `${import.meta.env.BASE_URL}models/iea15mw-volturnus/reference-geometry.glb`);
  const invalidate = useThree(state => state.invalidate);
  const { camera, size } = useThree();
  const assembly = useMemo(() => {
    const geometry = (name: keyof ReferenceGeometries) => {
      const object = asset.scene.getObjectByName(name);
      if (!(object instanceof Mesh)) throw new Error(`Reference geometry is missing ${name}.`);
      // Only local geometry: the GLB's Y-up viewer node transform is NOT baked
      // into these Z-up coordinates. Never transform the cached asset itself.
      return object.geometry;
    };
    return createReferenceAssembly({ blade: geometry("blade"), tower: geometry("tower"), platform: geometry("platform") });
  }, [asset]);
  const arrow = useMemo(() => createWindArrow(), []);
  const moorings = useMemo(() => createMooringDisplay(), []);
  const angle = useMemo(() => createPitchIndicator(), []);
  const applyPose = useMemo(() => bindSceneMotion(assembly, arrow), [assembly, arrow]);
  const updateScene = useMemo(() => (pose: DisplayPose | undefined) => {
    applyPose(pose);
    angle.update(pose?.platformPitchRad);
    const warning = moorings.update(showMoorings ? pose?.platformPitchRad : undefined);
    placeSceneIndicators(overlays, pose, camera, size.width, size.height, warning);
  }, [applyPose, angle, moorings, overlays, camera, size.width, size.height, showMoorings]);
  const [playback] = useState(() => new SamplePlayback());
  useLayoutEffect(() => {
    const now = performance.now();
    playback.accept(sample, runState, now);
    updateScene(playback.read(now));
    invalidate();
  }, [sample, runState, playback, updateScene, invalidate]);
  useFrame(() => {
    const now = performance.now();
    updateScene(playback.read(now));
    // Demand frames stop at the newest sample. No extrapolation while waiting,
    // and no permanent RAF loop while Stop/error/parked data are unchanged.
    if (playback.isBlending(now)) invalidate();
  });
  useEffect(() => {
    invalidate();
    return () => {
      [assembly, arrow, moorings.group, angle.group].forEach(disposeReferenceAssembly);
    };
  }, [assembly, arrow, moorings, angle, invalidate]);
  return <><primitive object={assembly} /><primitive object={arrow} />
    <primitive object={moorings.group} /><primitive object={angle.group} /></>;
}
