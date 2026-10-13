import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TurbineAssembly3D } from "./TurbineAssembly3D";
import { SceneGauges } from "../ui/SceneGauges";
import { SeaAndSeabed, type WaterView } from "./SeaAndSeabed";
import type { SimulationScenarioSample } from "../sim/simulation";
import type { SimulationRunState } from "../app/useSimulation";
import { InfoDisclosure } from "../ui/InfoDisclosure";

function FowtScene3D({ fallback, sample, runState }: {
  fallback: ReactNode; sample: SimulationScenarioSample | undefined; runState: SimulationRunState;
}) {
  const [resetView, setResetView] = useState(0);
  const [contextLost, setContextLost] = useState(false);
  const [preset, setPreset] = useState<CameraPreset>("turbine");
  const [water, setWater] = useState<WaterView>("clear");
  const [seabed, setSeabed] = useState(true);
  const [showMoorings, setShowMoorings] = useState(true);
  const wind = useRef<HTMLDivElement>(null), pitch = useRef<HTMLDivElement>(null), warning = useRef<HTMLParagraphElement>(null);
  const overlays = useMemo(() => ({ wind, pitch, warning }), []);
  const onContextLost = useCallback(() => setContextLost(true), []);
  if (contextLost) return fallback;

  return (
    <>
      <div className="scene-actions">
        <label>View <select value={preset} onChange={event => setPreset(event.target.value as CameraPreset)}>
          <option value="turbine">Turbine</option><option value="platform">Platform</option>
          <option value="underwater">Underwater</option><option value="moorings">Full mooring layout</option>
        </select></label>
        <button type="button" className="secondary-button" onClick={() => setResetView(value => value + 1)}>Reset view</button>
      </div>
      <div className="scene-options">
        <label>Water <select value={water} onChange={event => setWater(event.target.value as WaterView)}>
          <option value="clear">Transparent</option><option value="surface">Surface</option><option value="hidden">Hidden</option>
        </select></label>
        <label><input type="checkbox" checked={seabed} onChange={event => setSeabed(event.target.checked)} />Seabed</label>
        <label><input type="checkbox" checked={showMoorings} onChange={event => setShowMoorings(event.target.checked)} />Moorings</label>
      </div>
      <div className="scene-canvas" aria-label="Simulation-driven 3D turbine">
        <Canvas
          frameloop="demand"
          dpr={[1, 1.5]}
          camera={{ fov: 42, near: 0.5, far: 30000, up: [0, 0, 1], position: [-400, -500, 300] }}
          gl={{ antialias: true, powerPreference: "low-power" }}
          fallback={fallback}
        >
          <color attach="background" args={["#f8fbff"]} />
          <hemisphereLight args={["#ffffff", "#728d9b", 2.2]} position={[0, 0, 500]} />
          <directionalLight position={[-150, -200, 400]} intensity={2.5} />
          <TurbineAssembly3D sample={sample} runState={runState} overlays={overlays} showMoorings={showMoorings} />
          <SeaAndSeabed water={water} seabed={seabed} />
          <SceneCamera resetView={resetView} preset={preset} onContextLost={onContextLost} />
        </Canvas>
        <SceneGauges sample={sample} />
        <div ref={wind} className="scene-spatial-label scene-wind-value" />
        <div ref={pitch} className="scene-spatial-label scene-pitch-value" />
      </div>
      <p ref={warning} className="scene-solver-warning" role="status" />
      <p className="scene-caption">Drag to orbit · scroll/pinch to zoom · right-drag to pan. Depth 200 m · quasi-static moorings.</p>
      <InfoDisclosure label="3D motion and geometry">
        <p>Gauges show the latest sample. Motion and nearby wind/angle labels blend received poses with up to 250 ms delay. Stop freezes the latest received pose; turbine shutdown keeps moving while the clock runs.</p>
        <p>The orange arrow shows simulated free-stream wind toward +X: 2.5 scene metres per m/s. The purple arc measures platform pitch from vertical; positive tilts downwind. No angle amplification. Gauge needles stop at their scale ends; numerical readings retain actual values.</p>
        <p>Hub 150 m · tip radius 120.97 m · draft 20 m · freeboard 15 m. Still water is illustrative and creates no motion.</p>
        <p>Reference blade twist and prebend, 6° shaft uptilt and 4° upwind precone. Nacelle and spinner are approximations. The simulator still uses its original simplified geometry.</p>
        <p>Three 850 m elastic lines use the reference anchor/fairlead positions, submerged weight and stiffness. Flat seabed, frictionless contact; slack bed layouts are nonunique. Line profiles are quasi-static display geometry, not dynamic MoorDyn results, and add no forces to the simulator. Sea and seabed texture are illustrative. Full layout preserves the real mooring footprint.</p>
        <p><a href={`${import.meta.env.BASE_URL}models/iea15mw-volturnus/SOURCES.md`} target="_blank" rel="noreferrer">Asset sources and optimisation</a> · <a href={`${import.meta.env.BASE_URL}models/iea15mw-volturnus/LICENSE.txt`} target="_blank" rel="noreferrer">Licence</a></p>
      </InfoDisclosure>
    </>
  );
}

// Presentation of existing samples only; no parallel simulation model.
export default memo(FowtScene3D);

type CameraPreset = "turbine" | "platform" | "underwater" | "moorings";
function SceneCamera({ resetView, preset, onContextLost }: { resetView: number; preset: CameraPreset; onContextLost: () => void }) {
  const { camera, gl, invalidate, size } = useThree();
  useEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const canvas = gl.domElement;
    // Engineering coordinates are also render coordinates (Z up), including
    // OrbitControls' polar axis. Fit the whole assembly even on narrow screens.
    camera.up.set(0, 0, 1);
    const verticalFov = camera.fov * Math.PI / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * size.width / size.height);
    const radius = { turbine: 170, platform: 105, underwater: 160, moorings: 1000 }[preset];
    const distance = radius * 1.08 / Math.sin(Math.min(verticalFov, horizontalFov) / 2);
    const target = new Vector3(0, 0, { turbine: 115, platform: 0, underwater: -40, moorings: -20 }[preset]);
    camera.position.copy(new Vector3(-1, -1.4, preset === "underwater" ? -0.12 : 0.65).normalize().multiplyScalar(distance).add(target));
    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    controls.minDistance = 35;
    controls.maxDistance = 15000;
    controls.enableDamping = false; // No continuous frames while idle.
    const requestRender = () => invalidate();
    controls.addEventListener("change", requestRender);
    controls.update();
    canvas.setAttribute("tabindex", "0");
    canvas.setAttribute("aria-label", "Live 3D reference turbine. Drag to orbit, scroll to zoom, arrow keys to pan.");
    controls.listenToKeyEvents(canvas);
    const lost = (event: Event) => {
      event.preventDefault();
      onContextLost();
    };
    canvas.addEventListener("webglcontextlost", lost);
    invalidate();
    return () => {
      controls.removeEventListener("change", requestRender);
      controls.dispose(); // Pointer, wheel and keyboard listeners, StrictMode safe.
      canvas.removeEventListener("webglcontextlost", lost);
    };
  }, [camera, gl, invalidate, size.width, size.height, resetView, preset, onContextLost]);
  return null;
}
