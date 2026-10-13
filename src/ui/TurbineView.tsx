import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import type { SimulationScenarioSample } from "../sim/simulation";
import type { SimulationRunState } from "../app/useSimulation";
import { FowtSchematic } from "./FowtSchematic";

// Three.js is downloaded only after the user requests 3D. This component owns
// presentation state only: it cannot send worker messages or change settings.
const FowtScene3D = lazy(() => import("../graphics/FowtScene3D"));

export function TurbineView(props: {
  sample: SimulationScenarioSample | undefined;
  history: SimulationScenarioSample[];
  runState: SimulationRunState;
}) {
  const [view, setView] = useState<"2d" | "3d">("2d");
  const fallback = useMemo(() => (
    <div className="scene-fallback" role="status">
      <p>3D is unavailable. WebGL may be disabled, the graphics context was lost, or the scene could not load.</p>
      <p>Your simulation is still available in 2D.</p>
      <button type="button" onClick={() => setView("2d")}>Return to live 2D</button>
    </div>
  ), []);

  return (
    <div className="turbine-view">
      <div className="turbine-view-selector" role="group" aria-label="Turbine view">
        <button type="button" aria-pressed={view === "2d"} onClick={() => setView("2d")}>2D · live motion</button>
        <button type="button" aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D · live motion</button>
      </div>
      {/* Retain the SVG and its disclosure state; only the GPU scene unmounts. */}
      <div hidden={view !== "2d"}><FowtSchematic {...props} /></div>
      {view === "3d" && (
        <section className="panel scene-panel" aria-labelledby="scene-heading">
          <div className="panel-header">
            <div>
              <h2 id="scene-heading">IEA 15 MW / VolturnUS-S</h2>
              <p className="scene-caption">Reference exterior · simulation-driven motion</p>
            </div>
          </div>
          <SceneErrorBoundary fallback={fallback}>
            <Suspense fallback={<p className="scene-fallback" role="status">Loading 3D view…</p>}>
              <FowtScene3D fallback={fallback} sample={props.sample} runState={props.runState} />
            </Suspense>
          </SceneErrorBoundary>
        </section>
      )}
    </div>
  );
}

// Covers loading/render errors without taking down controls, plots or the worker.
class SceneErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
