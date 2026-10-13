// Pinned IEA-15-240-RWT e4993d63... MoorDyn inputs; X downwind, Y transverse,
// Z up [m]. All anchors lie on the flat Z=-200 m bed. See docs/3d-view.md.
export const MOORING = {
  depthM: 200, lengthM: 850, stiffnessN: 3.27e9, massKgPerM: 685,
  displacedDiameterM: 0.333, waterDensityKgPerM3: 1025, gravityMPerS2: 9.81,
} as const;
// MoorDyn's equivalent displaced-volume diameter, NOT the 0.185 m chain bar.
export const LINE_WEIGHT_N_PER_M = (MOORING.massKgPerM - MOORING.waterDensityKgPerM3 *
  Math.PI * MOORING.displacedDiameterM ** 2 / 4) * MOORING.gravityMPerS2;
export const MOORING_ENDPOINTS = [
  { fairlead: [-58, 0, -14], anchor: [-837.6, 0, -200] },
  { fairlead: [29, 50.229, -14], anchor: [418.8, 725.383, -200] },
  { fairlead: [29, -50.229, -14], anchor: [418.8, -725.383, -200] },
] as const;

export function pitchedFairlead(point: readonly number[], theta: number): [number, number, number] {
  // Same Ry(theta) about the SWL origin as the rendered platform.
  return [point[0] * Math.cos(theta) + point[2] * Math.sin(theta), point[1],
    -point[0] * Math.sin(theta) + point[2] * Math.cos(theta)];
}
