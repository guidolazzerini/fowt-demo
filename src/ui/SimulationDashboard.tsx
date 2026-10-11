import { useSimulation } from "../app/useSimulation";
import { ControlsPanel } from "./ControlsPanel";
import { FowtSchematic } from "./FowtSchematic";
import { PlotPanel } from "./PlotPanel";
import { StatusPanel } from "./StatusPanel";
import { SimulationToolbar } from "./SimulationToolbar";
import { ControllerDiagnostics } from "./ControllerDiagnostics";

export function SimulationDashboard() {
  const simulation = useSimulation();

  return (
    <main className="dashboard-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">IEA 15 MW · Floating wind lab</p>
          <h1>Explore turbine control</h1>
        </div>
      </header>

      <SimulationToolbar simulation={simulation} />
      <div className="dashboard-grid">
        <ControlsPanel
          settings={simulation.settings}
          controllerBandwidthEstimate={simulation.controllerBandwidthEstimate}
          onSettingsChange={simulation.updateSettings}
        />
        <div className="right-column">
          <StatusPanel
            sample={simulation.latestSample}
            history={simulation.history}
            status={simulation.status}
            statusMessage={simulation.statusMessage}
            runState={simulation.runState}
            isRunning={simulation.isRunning}
          />
          <FowtSchematic sample={simulation.latestSample} history={simulation.history} />
          <PlotPanel history={simulation.history} runState={simulation.runState} />
          <ControllerDiagnostics history={simulation.history} operation={simulation.operation} settings={simulation.settings} />
        </div>
      </div>
    </main>
  );
}
