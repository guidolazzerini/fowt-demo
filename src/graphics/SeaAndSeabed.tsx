import { useEffect, useMemo } from "react";
import { DataTexture, DoubleSide, RepeatWrapping, RGBAFormat } from "three";
import { MOORING } from "./mooringReference";

export type WaterView = "clear" | "surface" | "hidden";
export function SeaAndSeabed({ water, seabed }: { water: WaterView; seabed: boolean }) {
  const sand = useMemo(() => {
    const pixels = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) {
      // Deterministic procedural grain; decorative, unrelated to bathymetry.
      const grain = ((i * 1103515245 + 12345) >>> 16) % 19;
      pixels.set([187 + grain, 172 + grain, 139 + grain, 255], i * 4);
    }
    const texture = new DataTexture(pixels, 64, 64, RGBAFormat);
    texture.wrapS = texture.wrapT = RepeatWrapping; texture.repeat.set(24, 24); texture.needsUpdate = true;
    return texture;
  }, []);
  useEffect(() => () => sand.dispose(), [sand]);
  return <>
    {water !== "hidden" && <mesh name="illustrative-sea" renderOrder={1}>
      <planeGeometry args={[2400, 2400]} />
      <meshPhongMaterial color="#6cbbd4" shininess={70} specular="#c8f0ff" transparent
        opacity={water === "clear" ? 0.14 : 0.82} side={DoubleSide} depthWrite={false} />
    </mesh>}
    {seabed && <mesh name="flat-seabed" position={[0, 0, -MOORING.depthM]}>
      <planeGeometry args={[2400, 2400]} />
      <meshStandardMaterial map={sand} roughness={1} side={DoubleSide} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
    </mesh>}
  </>;
}
