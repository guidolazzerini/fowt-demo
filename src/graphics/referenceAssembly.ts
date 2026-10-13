import { BoxGeometry, BufferGeometry, CylinderGeometry, Group,
  Line, Material, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from "three";

// Pinned floating ElastoDyn geometry, metres/radians. Presentation values only;
// simulation defaults (including zero shaft tilt) are untouched.
export const REFERENCE = {
  towerTopM: 144.386,
  towerToShaftM: 4.3495,
  overhangM: -12.098,
  hubRadiusM: 3.97,
  bladeLengthM: 117,
  shaftTiltRad: 6 * Math.PI / 180, // OpenFAST ShftTilt=-6 -> engineering Ry(+6).
  preconeRad: -4 * Math.PI / 180, // Engineering Ry(-4): upper blade cones upwind.
} as const;

export const REFERENCE_HUB = new Vector3(REFERENCE.overhangM, 0, 0)
  .applyAxisAngle(new Vector3(0, 1, 0), REFERENCE.shaftTiltRad)
  .add(new Vector3(0, 0, REFERENCE.towerTopM + REFERENCE.towerToShaftM));

export interface ReferenceGeometries { blade: BufferGeometry; tower: BufferGeometry; platform: BufferGeometry }

export function createReferenceAssembly(source: ReferenceGeometries): Group {
  const root = new Group();
  root.name = "platform-pitch"; // +Y pitch pivot at still water/tower axis.
  const platformMaterial = new MeshStandardMaterial({ color: "#fbc004", roughness: 0.65 });
  const towerMaterial = new MeshStandardMaterial({ color: "#d9dde1", roughness: 0.6 });
  const nacelleMaterial = new MeshStandardMaterial({ color: "#eef1f3", roughness: 0.55 });
  // Initial zero-pitch blue; sceneMotion updates the shared pitch colour cue.
  const bladeMaterial = new MeshStandardMaterial({ color: "#2563eb", roughness: 0.6 });
  const hubMaterial = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.55 });
  function mesh(name: string, geometry: BufferGeometry, material: MeshStandardMaterial, parent: Group) {
    const object = new Mesh(geometry, material);
    object.name = name; parent.add(object); return object;
  }
  mesh("VolturnUS-S", source.platform.clone(), platformMaterial, root);
  mesh("floating-tower", source.tower.clone(), towerMaterial, root);
  const nacelle = new Group(); nacelle.name = "nacelle";
  nacelle.position.z = REFERENCE.towerTopM; root.add(nacelle);
  // Restrained housing approximation; its base joins the floating tower.
  mesh("nacelle-enclosure-approximation", new BoxGeometry(15, 8, 8), nacelleMaterial, nacelle)
    .position.set(-1, 0, 4);
  const shaft = new Group(); shaft.name = "shaft-tilt";
  shaft.position.set(0, 0, REFERENCE.towerToShaftM);
  shaft.rotation.y = REFERENCE.shaftTiltRad; nacelle.add(shaft);
  const rotor = new Group(); rotor.name = "rotor-azimuth";
  rotor.position.x = REFERENCE.overhangM; shaft.add(rotor);
  // Direct-drive enclosure near the ontology's 5.309 m generator radius.
  const cover = mesh("generator-cover-approximation", new CylinderGeometry(5.5, 5.5, 2.5, 40), nacelleMaterial, shaft);
  cover.rotation.z = Math.PI / 2; cover.position.x = -8.8;
  mesh("hub", new SphereGeometry(REFERENCE.hubRadiusM, 24, 16), hubMaterial, rotor);
  // Rounded ellipsoidal cap, overlapping the spherical hub. Illustrative
  // enclosure only; the hub centre and all blade roots remain unchanged [m].
  const spinner = mesh("spinner-approximation", new SphereGeometry(1, 32, 20), hubMaterial, rotor);
  spinner.scale.set(3.5, 3.4, 3.4); spinner.position.x = -2;

  // One GPU geometry shared by three independently transformable blades.
  const bladeGeometry = source.blade.clone();
  for (let i = 0; i < 3; i++) {
    const azimuth = new Group(); azimuth.name = `blade-${i+1}-azimuth`;
    azimuth.rotation.x = i * 2 * Math.PI / 3; rotor.add(azimuth);
    const cone = new Group(); cone.name = `blade-${i+1}-precone`;
    cone.rotation.y = REFERENCE.preconeRad; azimuth.add(cone);
    const pitch = new Group(); pitch.name = `blade-${i+1}-pitch`;
    pitch.position.z = REFERENCE.hubRadiusM; cone.add(pitch);
    // Twist/prebend are baked into geometry. Positive feather uses -beta
    // about local Z: leading edge (-Y) moves upwind (-X).
    mesh(`blade-${i+1}`, bladeGeometry, bladeMaterial, pitch);
  }
  root.updateMatrixWorld(true);
  return root;
}

export function disposeReferenceAssembly(root: Group): void {
  // Fiber primitive objects are caller-owned. Dispose shared resources once;
  // loader-cached source geometries are CPU-only and never mutated.
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse(object => {
    if (object instanceof Mesh || object instanceof Line) {
      geometries.add(object.geometry);
      const list = Array.isArray(object.material) ? object.material : [object.material];
      list.forEach(material => materials.add(material));
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}
