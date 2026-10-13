"""Rebuild display meshes from pinned IEA exterior data (not a physical model).

Developer utility: Python + numpy + PyYAML; no browser/build dependency.
Run with --download once, then without it for an offline deterministic rebuild.
Inputs are cached in .stage2-sources.local; only compact GLB/provenance ship.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math
import re
import struct
import urllib.request
import zipfile

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.stage2-sources.local'
OUT = ROOT / 'public/models/iea15mw-volturnus'
REVISION = 'e4993d63de10f165389534461dd544006750fe60'
BASE = f'https://raw.githubusercontent.com/IEAWindSystems/IEA-15-240-RWT/{REVISION}/'
STEMS = ['IEA-15-240-RWT_blade', 'IEA-15-240-RWT_VolturnUS-S_tower',
         'IEA-15-240-RWT_VolturnUS-S_floater']
INPUTS = [f'CAD/OpenSCAD/{s}.{ext}.zip' for s in STEMS for ext in ['scad', 'stl']] + [
    'WT_Ontology/IEA-15-240-RWT_VolturnUS-S.yaml',
    'OpenFAST/IEA-15-240-RWT-UMaineSemi/IEA-15-240-RWT-UMaineSemi_ElastoDyn.dat', 'LICENSE']
TOLERANCE_M = 0.015


def zipped_text(stem, extension):
    with zipfile.ZipFile(CACHE / f'{stem}.{extension}.zip') as archive:
        return archive.read(f'{stem}.{extension}').decode()


def inspect_stl(stem):
    text = zipped_text(stem, 'stl')
    vertices = np.array(re.findall(r'vertex\s+(\S+)\s+(\S+)\s+(\S+)', text), dtype=float)
    return dict(triangles=len(vertices) // 3, boundsM=[vertices.min(0).tolist(), vertices.max(0).tolist()])


def blade_mesh():
    # Separate blade SCAD has baked section twist + prebend, but no hub offset,
    # shaft tilt, rotor azimuth or cone. Its global hull is deliberately NOT used.
    text = zipped_text(STEMS[0], 'scad')
    rings = re.findall(r'translate\(v = \[([^\]]+)\]\)\s*\{\s*linear_extrude\(height = ([^)]+)\)\s*\{\s*polygon\(points = (\[.*?\])\);', text, re.S)
    profiles = np.array([json.loads(r[2]) for r in rings])
    span = np.array([float(r[0].split(',')[2]) for r in rings])
    assert profiles.shape == (151, 400, 2) and np.all(np.diff(span) > 0)
    assert abs(span[-1] - 117) < 1e-9

    # Common section indices retain corresponding points for a continuous loft.
    # RDP criterion is maximum point-to-segment distance over ALL source rings.
    closed = np.concatenate([profiles, profiles[:, :1]], axis=1)
    section_ids = {0, 200, 400}

    def section_error(a, b):
        delta = closed[:, b] - closed[:, a]
        v = closed[:, a+1:b] - closed[:, a, None]
        t = np.clip(np.sum(v * delta[:, None], axis=-1) /
                    np.maximum(np.sum(delta * delta, axis=-1)[:, None], 1e-20), 0, 1)
        return np.linalg.norm(v - t[:, :, None] * delta[:, None], axis=-1).max(axis=0)

    def reduce_section(a, b):
        if b <= a + 1:
            return
        errors = section_error(a, b)
        if errors.max() > TOLERANCE_M:
            i = a + 1 + int(np.argmax(errors))
            section_ids.add(i)
            reduce_section(a, i)
            reduce_section(i, b)

    reduce_section(0, 200)
    reduce_section(200, 400)
    section_ids = sorted(section_ids)
    perimeter_error = max(float(section_error(a, b).max()) if b > a+1 else 0
                          for a, b in zip(section_ids[:-1], section_ids[1:]))
    section_ids = section_ids[:-1]  # Closing point shares its vertex with point 0.
    span_ids = {0, len(span)-1}

    def span_error(a, b):
        t = (span[a+1:b] - span[a]) / (span[b] - span[a])
        linear = profiles[a, None] + t[:, None, None] * (profiles[b]-profiles[a])[None]
        return np.linalg.norm(profiles[a+1:b] - linear, axis=-1).max(axis=1)

    def reduce_span(a, b):
        if b <= a+1:
            return
        errors = span_error(a, b)
        if errors.max() > TOLERANCE_M:
            i = a+1+int(np.argmax(errors))
            span_ids.add(i)
            reduce_span(a, i)
            reduce_span(i, b)

    reduce_span(0, len(span)-1)
    span_ids = sorted(span_ids)
    span_deviation = max(float(span_error(a, b).max()) if b > a+1 else 0
                         for a, b in zip(span_ids[:-1], span_ids[1:]))
    points = np.array([[*profiles[i, j], span[i]] for i in span_ids for j in section_ids])
    count = len(section_ids)
    faces = []
    for i in range(len(span_ids)-1):
        for j in range(count):
            a, b = i*count+j, i*count+(j+1) % count
            faces += [[a, b, b+count], [a, b+count, a+count]]
    # Closed circular root sections repeat their trailing-edge point; weld those
    # coincident side vertices, but retain the finite trailing-edge thickness
    # farther outboard. Do not weld caps to sides (hard cap normals).
    sections = [points[:count].copy(), points[-count:].copy()]
    points, remap = np.unique(np.round(points, 9), axis=0, return_inverse=True)
    faces = remap[np.array(faces)].tolist()
    # Split cap vertices for hard normals at the circular root and thin tip.
    for ring, reverse in [(0, True), (len(span_ids)-1, False)]:
        section = sections[0 if ring == 0 else 1]
        start = len(points)
        points = np.vstack([points, section, section.mean(axis=0)])
        for j in range(count):
            face = [start+count, start+j, start+(j+1) % count]
            faces.append(face[::-1] if reverse else face)
    faces = np.array(faces)
    area = np.linalg.norm(np.cross(points[faces[:,1]]-points[faces[:,0]], points[faces[:,2]]-points[faces[:,0]]), axis=1)
    faces = faces[area > 1e-10]
    used, indices = np.unique(faces, return_inverse=True)
    points, faces = points[used], indices.reshape(-1,3)
    return points, faces, dict(sourceSections=151, sourcePointsPerSection=400,
        retainedSections=len(span_ids), retainedPointsPerSection=count,
        maxSectionPolylineDeviationM=perimeter_error, maxSpanInterpolationDeviationM=span_deviation,
        toleranceM=TOLERANCE_M, referenceAxisTipM=[-4, 0, 117])


def lathe(profile, segments=64):
    """Revolve radius/Z stations. Split caps retain hard rim normals."""
    vertices = [[r*math.cos(a), r*math.sin(a), z] for r, z in profile
                for a in np.arange(segments)*2*math.pi/segments]
    faces = []
    for i in range(len(profile)-1):
        for j in range(segments):
            a, b = i*segments+j, i*segments+(j+1) % segments
            faces += [[a, b, b+segments], [a, b+segments, a+segments]]
    for ring, reverse in [(0, True), (len(profile)-1, False)]:
        start = len(vertices)
        vertices += vertices[ring*segments:(ring+1)*segments] + [[0, 0, profile[ring][1]]]
        for j in range(segments):
            face = [start+segments, start+j, start+(j+1) % segments]
            faces.append(face[::-1] if reverse else face)
    return np.array(vertices), np.array(faces)


def box(length, width, height):
    # Separate vertices at each face preserve the pontoon's sharp corners.
    corners = np.array([[-1,-1,-1], [1,-1,-1], [1,1,-1], [-1,1,-1],
                        [-1,-1,1], [1,-1,1], [1,1,1], [-1,1,1]]) * [length/2, width/2, height/2]
    quads = [[0,3,2,1], [4,5,6,7], [0,1,5,4], [1,2,6,5], [2,3,7,6], [3,0,4,7]]
    vertices = corners[np.array(quads)].reshape(-1, 3)
    faces = [[i, i+1, i+2] for i in range(0,24,4)] + [[i,i+2,i+3] for i in range(0,24,4)]
    return vertices, np.array(faces)


def structure_meshes(ontology):
    components = ontology['components']
    tower = components['tower']
    z = tower['reference_axis']['z']['values']
    radii = np.array(tower['outer_shape']['outer_diameter']['values']) / 2
    # Remove collinear stations: same exact exterior, fewer triangles.
    profile = [(radii[0], z[0])]
    for i in range(1, len(z)-1):
        if abs((radii[i]-radii[i-1])/(z[i]-z[i-1]) - (radii[i+1]-radii[i])/(z[i+1]-z[i])) > 1e-9:
            profile.append((radii[i], z[i]))
    profile.append((radii[-1], z[-1]))
    tower_mesh = lathe(profile)
    platform = components['floating_platform']
    joints = {j['name']: j['location'] for j in platform['joints']}
    members = {m['name']: m for m in platform['members']}
    meshes = []
    for name in ['main', 'col1', 'col2', 'col3']:
        lower, upper = joints[f'{name}_keel'], joints[f'{name}_freeboard']
        radius = members['main_column' if name == 'main' else 'column'+name[-1]]['outer_shape']['outer_diameter']['values'][0]/2
        centre = [0, 0, 0] if name == 'main' else [lower[0]*math.cos(math.radians(lower[1])), lower[0]*math.sin(math.radians(lower[1])), 0]
        p, f = lathe([(radius, lower[2]), (radius, upper[2])])
        meshes.append((p+centre, f))
    for name in ['col1', 'col2', 'col3']:
        radius, angle, _ = joints[f'{name}_keel']
        a = math.radians(angle)
        rotation = np.array([[math.cos(a),-math.sin(a),0], [math.sin(a),math.cos(a),0], [0,0,1]])
        # Rectangular exterior dimensions are retained as comments in this same
        # revision's ontology; active circular shape is a displacement surrogate.
        p, f = box(radius, 12.5, 7)
        meshes.append(((p+[radius/2, 0, -16.5]) @ rotation.T, f))
        strut_radius = members['Y_pontoon_upper1']['outer_shape']['outer_diameter']['values'][0]/2
        p, f = lathe([(strut_radius, 0), (strut_radius, radius)], segments=16)
        # Local cylinder Z -> radial X, preserving handedness.
        p = np.column_stack([p[:,2], p[:,1], -p[:,0]]) + [0, 0, 14.545]
        meshes.append((p @ rotation.T, f))
    vertices, faces, offset = [], [], 0
    for p, f in meshes:
        vertices.extend(p); faces.extend(f+offset); offset += len(p)
    return tower_mesh, (np.array(vertices), np.array(faces))


def normals(points, faces):
    crosses = np.cross(points[faces[:,1]]-points[faces[:,0]], points[faces[:,2]]-points[faces[:,0]])
    assert np.linalg.norm(crosses, axis=1).min() > 1e-10, 'Degenerate triangle'
    values = np.zeros_like(points)
    for column in range(3):
        np.add.at(values, faces[:,column], crosses)
    lengths = np.linalg.norm(values, axis=1)
    assert lengths.min() > 1e-10
    return values / lengths[:,None]


def write_glb(meshes):
    data = bytearray()
    doc = dict(asset=dict(version='2.0', generator='fowt-demo/scripts/build-reference-geometry.py',
        copyright=f'Derived/modified from IEA-15-240-RWT {REVISION}; Apache-2.0; see SOURCES.md'),
        buffers=[], bufferViews=[], accessors=[], meshes=[], nodes=[], scenes=[dict(nodes=[])], scene=0)

    def accessor(array, component_type, kind, bounds=False):
        while len(data) % 4: data.append(0)
        raw = array.tobytes()
        view = len(doc['bufferViews'])
        doc['bufferViews'].append(dict(buffer=0, byteOffset=len(data), byteLength=len(raw)))
        data.extend(raw)
        spec = dict(bufferView=view, componentType=component_type, count=len(array), type=kind)
        if bounds: spec.update(min=array.min(0).tolist(), max=array.max(0).tolist())
        doc['accessors'].append(spec)
        return len(doc['accessors'])-1

    for name, (points, faces) in meshes.items():
        p = accessor(points.astype('<f4'), 5126, 'VEC3', True)
        n = accessor(normals(points, faces).astype('<f4'), 5126, 'VEC3')
        assert len(points) < 65536
        idx = accessor(faces.astype('<u2').reshape(-1), 5123, 'SCALAR')
        i = len(doc['meshes'])
        doc['meshes'].append(dict(name=name, primitives=[dict(attributes=dict(POSITION=p, NORMAL=n), indices=idx)]))
        # A glTF viewer expects Y up. Geometry remains in engineering component
        # coordinates; our loader intentionally extracts it without this node pose.
        doc['nodes'].append(dict(name=name, mesh=i, rotation=[-math.sqrt(.5),0,0,math.sqrt(.5)]))
        doc['scenes'][0]['nodes'].append(i)
    while len(data) % 4: data.append(0)
    doc['buffers'] = [dict(byteLength=len(data))]
    header = json.dumps(doc, separators=(',', ':')).encode()
    header += b' ' * (-len(header) % 4)
    glb = struct.pack('<III', 0x46546c67, 2, 12+8+len(header)+8+len(data))
    glb += struct.pack('<II', len(header), 0x4e4f534a)+header
    glb += struct.pack('<II', len(data), 0x004e4942)+data
    (OUT/'reference-geometry.glb').write_bytes(glb)
    return len(glb)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    CACHE.mkdir(exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
    if args.download:
        for path in INPUTS:
            urllib.request.urlretrieve(BASE+path, CACHE/Path(path).name)
    ontology = yaml.safe_load((CACHE/'IEA-15-240-RWT_VolturnUS-S.yaml').read_text())
    blade_p, blade_f, quality = blade_mesh()
    tower, platform = structure_meshes(ontology)
    meshes = dict(blade=(blade_p, blade_f), tower=tower, platform=platform)
    byte_count = write_glb(meshes)
    manifest = dict(revision=REVISION, units='metres', geometryAxes='X downwind, Y transverse, Z up',
        sourceFiles={p:hashlib.sha256((CACHE/Path(p).name).read_bytes()).hexdigest() for p in INPUTS},
        inspectedStl={s:inspect_stl(s) for s in STEMS}, bladeLoft=quality,
        meshes={name:dict(vertices=len(p), triangles=len(f), boundsM=[p.min(0).tolist(),p.max(0).tolist()]) for name,(p,f) in meshes.items()},
        glbBytes=byte_count, glbSha256=hashlib.sha256((OUT/'reference-geometry.glb').read_bytes()).hexdigest())
    (OUT/'geometry-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    (OUT/'LICENSE.txt').write_bytes((CACHE/'LICENSE').read_bytes())
    print(json.dumps(dict(bladeLoft=quality, meshes=manifest['meshes'], glbBytes=byte_count), indent=2))


if __name__ == '__main__':
    main()
