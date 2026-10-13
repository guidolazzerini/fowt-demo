// Numerical asset/scene checks, not a WebGL or browser-interaction test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Box3, Mesh, Vector3 } from 'three';

const folder = new URL('../public/models/iea15mw-volturnus/', import.meta.url);
const manifest = JSON.parse(await fs.readFile(new URL('geometry-manifest.json', folder), 'utf8'));
const bytes = await fs.readFile(new URL('reference-geometry.glb', folder));
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.glbSha256);
const asset = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength), '');
const source = {};
for (const name of ['blade', 'tower', 'platform']) {
  const mesh = asset.scene.getObjectByName(name);
  assert(mesh instanceof Mesh);
  const geometry = source[name] = mesh.geometry;
  const p = geometry.attributes.position, n = geometry.attributes.normal, indices = geometry.index;
  assert.equal(p.count, manifest.meshes[name].vertices);
  assert.equal(indices.count / 3, manifest.meshes[name].triangles);
  for (let i = 0; i < p.count; i++) {
    assert([p.getX(i), p.getY(i), p.getZ(i)].every(Number.isFinite));
    assert(Math.abs(new Vector3().fromBufferAttribute(n, i).length()-1) < 1e-6);
  }
  let signedVolume = 0;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < indices.count; i += 3) {
    a.fromBufferAttribute(p, indices.getX(i)); b.fromBufferAttribute(p, indices.getX(i+1)); c.fromBufferAttribute(p, indices.getX(i+2));
    signedVolume += a.dot(new Vector3().crossVectors(b, c)) / 6;
    assert(new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).length() > 1e-10, `${name}: no degenerate faces`);
  }
  assert(signedVolume > 0, `${name}: outward winding gives positive volume`);
  geometry.computeBoundingBox();
  for (const [side, values] of [['min', manifest.meshes[name].boundsM[0]], ['max', manifest.meshes[name].boundsM[1]]]) {
    assert(geometry.boundingBox[side].distanceTo(new Vector3(...values)) < 1e-5);
  }
}
assert.equal(source.blade.boundingBox.min.z, 0);
assert.equal(source.blade.boundingBox.max.z, 117);
assert.equal(source.tower.boundingBox.min.z, 15);
assert(Math.abs(source.tower.boundingBox.max.z-144.386) < 1e-5);
assert.equal(source.platform.boundingBox.min.z, -20);
assert.equal(source.platform.boundingBox.max.z, 15);
assert(manifest.bladeLoft.maxSectionPolylineDeviationM < 0.015);
assert(manifest.bladeLoft.maxSpanInterpolationDeviationM < 0.015);
assert(bytes.length < 120_000);
assert(source.blade.index.count / 3 < 3500);
console.log('PASS: real GLTFLoader decode, hash, bounds, unit normals, winding, nondegenerate faces and asset budgets');

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { createReferenceAssembly, disposeReferenceAssembly, REFERENCE_HUB } = await server.ssrLoadModule('/src/graphics/referenceAssembly.ts');
  const root = createReferenceAssembly(source);
  const rotor = root.getObjectByName('rotor-azimuth');
  assert(rotor.getWorldPosition(new Vector3()).distanceTo(REFERENCE_HUB) < 1e-10);
  assert(Math.abs(REFERENCE_HUB.z-150) < 0.001);
  assert(Math.abs(REFERENCE_HUB.x+12.0317) < 0.001);
  const blade1 = root.getObjectByName('blade-1');
  assert.equal(blade1.geometry, root.getObjectByName('blade-2').geometry);
  assert.equal(blade1.geometry, root.getObjectByName('blade-3').geometry);
  assert.notEqual(blade1.geometry, source.blade, 'Cache is not attached to renderer');
  const tip = blade1.localToWorld(new Vector3(-4, 0, 117));
  assert(tip.z > 270 && Math.abs(tip.y) < 1e-10, 'Blade 1 upward, prebend applied once');
  const pitch = root.getObjectByName('blade-1-pitch');
  const cone = root.getObjectByName('blade-1-precone');
  assert(new Vector3(0, 0, 1).applyEuler(cone.rotation).x < 0, 'Precone points upwind');
  const pitchOrigin = pitch.getWorldPosition(new Vector3());
  pitch.rotation.z = -Math.PI / 2; root.updateMatrixWorld(true);
  assert(pitch.getWorldPosition(new Vector3()).distanceTo(pitchOrigin) < 1e-10, 'Feather about root, no root translation');
  const chord = new Vector3(0, 1, 0).transformDirection(pitch.matrixWorld);
  assert(chord.x > 0.99, '90-degree feather chord aligns with wind; leading edge upwind');
  pitch.rotation.z = 0;
  root.rotation.y = 0.1; root.updateMatrixWorld(true);
  assert(rotor.getWorldPosition(new Vector3()).x > REFERENCE_HUB.x, 'Positive platform pitch tilts downwind');
  root.rotation.y = 0; rotor.rotation.x = Math.PI / 2; root.updateMatrixWorld(true);
  assert(blade1.localToWorld(new Vector3(0, 0, 117)).y < -110, 'Increasing azimuth moves upper blade toward -Y');
  rotor.rotation.x = 0; root.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(root);
  assert(bounds.min.z === -20 && bounds.max.z > 270 && bounds.max.z < 272);
  console.log('PASS: hub at 150 m, root pivots, blade sharing, upwind cone, feather/platform/azimuth signs, assembly bounds');
  const geometries = new Set(), materials = new Set();
  root.traverse(object => { if (object instanceof Mesh) { geometries.add(object.geometry); materials.add(object.material); } });
  let releasedGeometry = 0, releasedMaterial = 0, releasedSource = 0;
  geometries.forEach(g => g.addEventListener('dispose', () => releasedGeometry++));
  materials.forEach(m => m.addEventListener('dispose', () => releasedMaterial++));
  Object.values(source).forEach(g => g.addEventListener('dispose', () => releasedSource++));
  disposeReferenceAssembly(root);
  assert.equal(releasedGeometry, geometries.size);
  assert.equal(releasedMaterial, materials.size);
  assert.equal(releasedSource, 0);
  console.log(`PASS: ${geometries.size} owned geometries and ${materials.size} materials disposed once; source cache untouched`);
} finally { await server.close(); }
console.log('NOTE: static numerical scene checks; WebGL appearance, labels and browser memory require visual review.');
