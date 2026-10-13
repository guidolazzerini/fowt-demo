// Display/transform tests using the production interpolator and real GLB.
// These do not establish WebGL rendering, browser responsiveness or GPU memory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Vector3, Box3, PerspectiveCamera } from 'three';

const server = await createServer({ server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
const TAU = 2 * Math.PI;
const close = (a, b, message) => assert(Math.abs(a - b) < 1e-8, `${message ?? 'value'}: ${a} vs ${b}`);
const sample = (timeS = 0, extra = {}) => ({ timeS, rotorAzimuthRad: timeS % TAU,
  rotorSpeedRadPerSec: 1, collectivePitchRad: 0, platformPitchRad: 0, windSpeedMps: 10, ...extra });
try {
  const { SamplePlayback } = await server.ssrLoadModule('/src/graphics/samplePlayback.ts');
  const { bindSceneMotion, createWindArrow } = await server.ssrLoadModule('/src/graphics/sceneMotion.ts');
  const { createPitchIndicator, placeSceneIndicators } = await server.ssrLoadModule('/src/graphics/sceneIndicators.ts');
  const { createReferenceAssembly, disposeReferenceAssembly } = await server.ssrLoadModule('/src/graphics/referenceAssembly.ts');

  // Same wall cadence, different simulation rates: endpoint time determines pose.
  for (const dt of [0.1, 0.32, 2, 4, 8]) {
    const p = new SamplePlayback();
    p.accept(sample(0), 'running', 0); p.accept(sample(dt), 'running', 100);
    close(p.read(150).timeS, dt / 2); close(p.read(150).rotorAzimuthRad, dt / 2);
    close(p.read(200).rotorAzimuthRad, dt);
    close(p.read(10000).rotorAzimuthRad, dt, 'no extrapolation');
  }
  const p = new SamplePlayback();
  p.accept(sample(0, { rotorAzimuthRad: 6.2 }), 'running', 0);
  p.accept(sample(0.32, { rotorAzimuthRad: 0.2 }), 'running', 100);
  assert(p.read(150).rotorAzimuthRad > 6.2 && p.read(150).rotorAzimuthRad < TAU + 0.2);
  close(p.read(200).rotorAzimuthRad, TAU + 0.2, 'forward wrap');
  // Stop settles the latest received pose, then stays fixed over wall time.
  p.accept(sample(0.32, { rotorAzimuthRad: 0.2 }), 'stopped', 150);
  assert.deepEqual(p.read(150), p.read(60000)); assert(!p.isBlending(151));
  p.accept(sample(0.32, { rotorAzimuthRad: 0.2 }), 'running', 60000);
  p.accept(sample(0.64, { rotorAzimuthRad: 0.52 }), 'running', 60100);
  close(p.read(60150).rotorAzimuthRad, 0.36, 'resume excludes stopped wall interval');
  p.accept(sample(0), 'reset', 60160); close(p.read(60160).timeS, 0);
  p.accept(sample(0, { collectivePitchRad: Math.PI / 2, rotorSpeedRadPerSec: 0 }), 'reset', 60170);
  close(p.read(60170).collectivePitchRad, Math.PI / 2, 'same-time Reset updates initial pose');
  p.accept(undefined, 'loading', 60180); assert.equal(p.read(60180), undefined);
  assert.throws(() => p.accept(sample(0, { windSpeedMps: NaN }), 'running', 0), /Non-finite/);
  console.log('PASS: measured accelerated timing, large-angle/multi-turn wrap, Stop/resume/Reset and finite-data guard');

  const jitter = new SamplePlayback();
  jitter.accept(sample(0), 'running', 0); jitter.accept(sample(0.32), 'running', 100);
  jitter.accept(sample(0.32, { windSpeedMps: 20 }), 'running', 150);
  close(jitter.read(175).timeS, 0.24, 'duplicate does not restart blending');
  jitter.accept(sample(0.64), 'running', 250);
  close(jitter.read(325).timeS, 0.48, 'jitter uses measured cadence');
  jitter.accept(sample(2), 'running', 1000); close(jitter.read(1000).timeS, 2, 'long gap snaps');
  close(jitter.read(99999).timeS, 2); assert(!jitter.isBlending(99999));
  jitter.accept(sample(0), 'running', 1100); close(jitter.read(1100).timeS, 0, 'backwards timestamp clears');

  // Sampling a display at 60/144 Hz must not integrate a different physical pose.
  for (const fps of [60, 144]) {
    const display = new SamplePlayback(); display.accept(sample(0), 'running', 0);
    display.accept(sample(0.32), 'running', 100);
    for (let now = 100; now < 175; now += 1000 / fps) display.read(now);
    close(display.read(175).rotorAzimuthRad, 0.24);
  }
  const parked = new SamplePlayback();
  parked.accept(sample(0), 'running', 0); parked.accept(sample(8), 'running', 100);
  const stoppedAzimuth = 8 % TAU;
  for (let i = 1; i <= 20000; i++) {
    parked.accept(sample(8 + i * 0.32, { rotorAzimuthRad: stoppedAzimuth,
      rotorSpeedRadPerSec: 0, collectivePitchRad: Math.PI / 2 }), 'running', 100 + i * 100);
  }
  close(parked.read(3000000).rotorAzimuthRad, 8, 'parked after unwrapped turns');
  close(parked.read(3000000).collectivePitchRad, Math.PI / 2);
  assert(!Object.values(parked).some(Array.isArray), 'playback keeps no sample history');
  assert.equal(Object.values(parked).filter(v => v && typeof v === 'object').length, 2);
  console.log('PASS: duplicate/jitter/delayed samples, frame-rate independence, parked feathering and bounded playback storage');

  const bytes = await fs.readFile(new URL('../public/models/iea15mw-volturnus/reference-geometry.glb', import.meta.url));
  const asset = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const source = Object.fromEntries(['blade', 'tower', 'platform'].map(name => [name, asset.scene.getObjectByName(name).geometry]));
  const root = createReferenceAssembly(source), arrow = createWindArrow();
  const apply = bindSceneMotion(root, arrow);
  apply(undefined); assert(!root.visible && !arrow.visible);
  apply(sample(0)); root.updateMatrixWorld(true);
  assert(root.visible && arrow.visible);
  const pitch = root.getObjectByName('blade-1-pitch');
  const pivot = pitch.getWorldPosition(new Vector3());
  apply(sample(0, { collectivePitchRad: Math.PI / 2, rotorSpeedRadPerSec: 0 })); root.updateMatrixWorld(true);
  assert(pitch.getWorldPosition(new Vector3()).distanceTo(pivot) < 1e-10);
  assert(new Vector3(0, -1, 0).transformDirection(pitch.matrixWorld).x < -0.99, 'feather leading edge turns upwind');
  for (const i of [1, 2, 3]) close(root.getObjectByName(`blade-${i}-pitch`).rotation.z, -Math.PI / 2);
  const hub = root.getObjectByName('rotor-azimuth'), originalHub = hub.getWorldPosition(new Vector3());
  apply(sample(0, { platformPitchRad: Math.PI / 9 })); root.updateMatrixWorld(true);
  close(root.rotation.y, Math.PI / 9, '20 degree platform not clipped');
  assert(hub.getWorldPosition(new Vector3()).x > originalHub.x);
  close(root.position.length(), 0, 'still-water pitch pivot');
  apply(sample(0, { rotorAzimuthRad: Math.PI / 2 })); root.updateMatrixWorld(true);
  assert(root.getObjectByName('blade-1').localToWorld(new Vector3(0, 0, 117)).y < -110);
  close(root.getObjectByName('blade-1-precone').rotation.y, -4 * Math.PI / 180);
  assert.equal(root.getObjectByName('blade-1').geometry, root.getObjectByName('blade-3').geometry);
  for (const windSpeedMps of [0, 5, 25, 35]) {
    apply(sample(0, { windSpeedMps })); arrow.updateMatrixWorld(true);
    assert.equal(arrow.visible, windSpeedMps > 0);
    if (windSpeedMps > 0) {
      const bounds = new Box3().setFromObject(arrow);
      close(bounds.max.x - bounds.min.x, 2.5 * windSpeedMps, 'arrow length in metres');
      close(bounds.min.x, -105, 'wind origin world fixed');
    }
  }
  // Clock still running through physical shutdown: pitch/platform continue to update.
  const shutdown = new SamplePlayback(); shutdown.accept(sample(0), 'running', 0);
  shutdown.accept(sample(1, { collectivePitchRad: Math.PI / 2, platformPitchRad: 0.2,
    rotorSpeedRadPerSec: 0 }), 'running', 100);
  apply(shutdown.read(150)); close(pitch.rotation.z, -Math.PI / 4); close(root.rotation.y, 0.1);
  apply(shutdown.read(200)); close(pitch.rotation.z, -Math.PI / 2);
  let released = 0; const materials = new Set();
  arrow.traverse(o => { if (o.isMesh) { o.geometry.addEventListener('dispose', () => released++); materials.add(o.material); } });
  materials.forEach(m => m.addEventListener('dispose', () => released++));
  disposeReferenceAssembly(root); disposeReferenceAssembly(arrow); assert.equal(released, 3);
  console.log('PASS: real geometry motion signs, blade pivots/full feather, no platform clamp, wind-arrow magnitude and disposal');
  const angle = createPitchIndicator();
  for (const theta of [-0.3, 0, 0.3]) {
    angle.update(theta);
    const arc = angle.group.getObjectByName('pitch-angle-arc').geometry.attributes.position;
    assert(Math.abs(arc.getX(32) - 32 * Math.sin(theta)) < 2e-6);
    assert(Math.abs(arc.getZ(32) - 32 * Math.cos(theta)) < 2e-6);
    const datum = angle.group.getObjectByName('vertical-datum').geometry.attributes.position;
    close(datum.getX(1), 0); close(datum.getZ(1), 43);
  }
  const refs = Object.fromEntries(['wind', 'pitch', 'warning'].map(name => [name, { current: { style: {}, textContent: '' } }]));
  const camera = new PerspectiveCamera(42, 1.5, 0.5, 30000);
  camera.up.set(0, 0, 1); camera.position.set(-400, -500, 300); camera.lookAt(0, 0, 115);
  placeSceneIndicators(refs, sample(0, { windSpeedMps: 18.5, platformPitchRad: -0.1 }), camera, 900, 600, 'Test failure');
  assert.equal(refs.wind.current.textContent, 'Wind 18.5 m/s');
  assert.equal(refs.pitch.current.textContent, 'Platform θ -5.73°');
  assert.equal(refs.wind.current.style.visibility, 'visible');
  assert.equal(refs.warning.current.textContent, 'Test failure');
  placeSceneIndicators(refs, undefined, camera, 900, 600, '');
  assert.equal(refs.wind.current.style.visibility, 'hidden');
  assert.equal(refs.pitch.current.style.visibility, 'hidden');
  camera.lookAt(-800, -1000, 600);
  placeSceneIndicators(refs, sample(0), camera, 900, 600, '');
  assert.equal(refs.wind.current.style.visibility, 'hidden', 'Behind camera hides label');
  disposeReferenceAssembly(angle.group);
  console.log('PASS: signed angle arc/vertical datum, projected wind/angle labels, behind-camera/missing data and warning text');
} finally { await server.close(); }
console.log('NOTE: browser WebGL, visual smoothness, view switching and memory still require local review.');
