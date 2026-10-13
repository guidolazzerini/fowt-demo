import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { Vector3 } from 'three';
const server = await createServer({ server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
try {
  const { solveCatenary } = await server.ssrLoadModule('/src/graphics/catenary.ts');
  const { createMooringDisplay } = await server.ssrLoadModule('/src/graphics/mooringDisplay.ts');
  const { MOORING, MOORING_ENDPOINTS, pitchedFairlead, LINE_WEIGHT_N_PER_M } = await server.ssrLoadModule('/src/graphics/mooringReference.ts');
  const { disposeReferenceAssembly } = await server.ssrLoadModule('/src/graphics/referenceAssembly.ts');
  const fixtures = JSON.parse(await fs.readFile(new URL('./fixtures/moorpy-catenary.json', import.meta.url), 'utf8'));
  const reference = await fs.readFile(new URL('../public/models/iea15mw-volturnus/IEA-15-240-RWT-UMaineSemi_MoorDyn.dat', import.meta.url));
  assert.equal(createHash('sha256').update(reference).digest('hex'), '606c681b051f793026bed56e4b8f349f93c9763cb7c0dba4326d4fba815d7d8b');
  const rows = reference.toString().split(/\r?\n/).map(row => row.trim().split(/\s+/));
  const lineType = rows.find(row => row[0] === 'main');
  assert.deepEqual(lineType.slice(1,4).map(Number), [MOORING.displacedDiameterM, MOORING.massKgPerM, MOORING.stiffnessN]);
  MOORING_ENDPOINTS.forEach(({ fairlead, anchor }, i) => {
    assert.deepEqual(rows.find(row => row[0] === String(2*i+1) && row[1] === 'Vessel').slice(2,5).map(Number), [...fairlead]);
    assert.deepEqual(rows.find(row => row[0] === String(2*i+2) && row[1] === 'Fixed').slice(2,5).map(Number), [...anchor]);
    assert.equal(Number(rows.find(row => row[0] === String(i+1) && row[1] === 'main')[4]), MOORING.lengthM);
    assert.equal(anchor[2], -MOORING.depthM);
  });
  console.log('PASS: pinned official input hash, three endpoint pairs, line length/stiffness/mass and displaced diameter');
  let maxPositionErrorM = 0, maxForceErrorN = 0, maxLengthErrorM = 0, maxBedPlotDifferenceM = 0;
  const regimes = new Set();
  for (const entry of fixtures.cases) {
    const profile = solveCatenary(entry.input, 4096); regimes.add(profile.regime);
    assert(Math.abs(entry.input.weightNPerM - LINE_WEIGHT_N_PER_M) < 1e-9);
    for (const [actual, reference] of [[profile.horizontalTensionN, entry.H],
      [profile.fairleadVerticalN, entry.V], [profile.anchorVerticalN, entry.anchorVerticalN]]) {
      maxForceErrorN = Math.max(maxForceErrorN, Math.abs(actual - reference));
      assert(Math.abs(actual - reference) < 1, `${entry.name}: tension ${actual} vs ${reference}`);
    }
    assert(Math.abs(profile.bedLengthM - entry.bedLengthM) < 1e-4);
    // Slack bed layout is nonunique; MoorPy also uses a different approximation
    // for plotting its vertical slack segment. Compare slack tensions/contact,
    // and use endpoint/length tests below for our exact vertical elastic profile.
    if (profile.regime !== 'slack') for (const [s, x, z] of entry.points) {
      const actual = profile.pointAt(s);
      // This pinned MoorPy revision omits H*s/EA from its CB=0 bed PLOT
      // coordinates (Catenary.py line 968), although its force/end equations
      // include bed strain. Keep raw fixtures; disclose this plotting discrepancy
      // and check its exact expected size. Suspended coordinates are unmodified.
      const bedStrain = s <= entry.bedLengthM ? entry.H * s / entry.input.stiffnessN : 0;
      if (bedStrain) maxBedPlotDifferenceM = Math.max(maxBedPlotDifferenceM, Math.abs(actual.x-x));
      const error = Math.hypot(actual.x - (x + bedStrain), actual.z - z);
      maxPositionErrorM = Math.max(maxPositionErrorM, error);
      assert(error < 1e-4, `${entry.name}: profile error ${error} m`);
    }
    const end = profile.points.at(-1);
    assert(Math.hypot(end.x - entry.input.horizontalM, end.z - entry.input.heightM) < 1e-5);
    assert(profile.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.z) && p.z >= -1e-9));
    assert.deepEqual(profile.points[0], { s: 0, x: 0, z: 0 });
    let length = 0;
    for (let i = 1; i < profile.points.length; i++) length += Math.hypot(profile.points[i].x-profile.points[i-1].x, profile.points[i].z-profile.points[i-1].z);
    maxLengthErrorM = Math.max(maxLengthErrorM, Math.abs(length-profile.stretchedLengthM));
    assert(Math.abs(length-profile.stretchedLengthM) < 0.005, `${entry.name}: polyline ${length} vs elastic arc length ${profile.stretchedLengthM}`);
    assert(profile.stretchedLengthM >= entry.input.lengthM);
  }
  assert.deepEqual([...regimes].sort(), ['slack', 'suspended', 'touchdown']);
  console.log(`PASS: ${fixtures.cases.length} pinned MoorPy comparisons; max profile ${maxPositionErrorM.toExponential(3)} m, tension ${maxForceErrorN.toExponential(3)} N, arc-length ${maxLengthErrorM.toExponential(3)} m`);
  console.log(`NOTE: raw MoorPy bed plotting omits axial strain; max ${maxBedPlotDifferenceM.toFixed(6)} m difference accounted for explicitly. Slack profiles checked analytically, not against its plotting approximation.`);

  const input = fixtures.cases[0].input;
  for (const h of [100, 900]) {
    const vertical = solveCatenary({ ...input, horizontalM: 0, heightM: h });
    assert(Math.abs(vertical.pointAt(850).z - h) < 1e-7);
  }
  for (const bad of [{ heightM: -1 }, { lengthM: 0 }, { stiffnessN: NaN }, { weightNPerM: -1 }]) {
    assert.throws(() => solveCatenary({ ...input, ...bad }), /Unsupported/);
  }
  // Sweep regime boundaries and platform poses, checking continuity and endpoints.
  let previousH = -1;
  for (let x = 660; x <= 860; x += 0.25) {
    const p = solveCatenary({ ...input, horizontalM: x });
    assert(p.horizontalTensionN >= previousH); previousH = p.horizontalTensionN;
    assert(p.residualM < 1e-5);
  }
  const display = createMooringDisplay();
  const buffers = display.group.children.filter(o => o.isLine).map(o => o.geometry.attributes.position.array);
  const start = performance.now();
  for (let i = 0; i < 240; i++) {
    const theta = 0.35 * Math.sin(i / 20);
    assert.equal(display.update(theta), '');
    MOORING_ENDPOINTS.forEach(({ anchor, fairlead }, index) => {
      const line = display.group.getObjectByName(`mooring-${index+1}`);
      assert.equal(line.geometry.attributes.position.array, buffers[index], 'GPU position buffer reused');
      const p = line.geometry.attributes.position;
      assert(new Vector3().fromBufferAttribute(p, 0).distanceTo(new Vector3(...anchor)) < 1e-4);
      const expected = new Vector3(...pitchedFairlead(fairlead, theta));
      assert(new Vector3().fromBufferAttribute(p, line.geometry.drawRange.count - 1).distanceTo(expected) < 1e-4);
      for (let j = 0; j < line.geometry.drawRange.count; j++) assert(p.getZ(j) >= -200.0001);
    });
  }
  console.log(`PASS: 240 moving poses / 720 line solves in ${(performance.now()-start).toFixed(0)} ms; fixed anchors, exact moving fairleads, contact, buffer reuse`);
  assert.match(display.update(NaN), /hidden/);
  assert(display.group.children.filter(o => o.isLine).every(o => !o.visible), 'Failed curves hidden');
  assert.equal(display.update(0), '', 'Recovery from invalid pose');
  let releases = 0; const geometries = new Set(), materials = new Set();
  display.group.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); });
  for (const resource of [...geometries, ...materials]) resource.addEventListener('dispose', () => releases++);
  disposeReferenceAssembly(display.group); assert.equal(releases, geometries.size + materials.size);
  console.log('PASS: invalid/vertical cases, boundary sweep, failure reporting/recovery and shared-resource disposal');
} finally { await server.close(); }
