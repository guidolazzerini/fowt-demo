import { useSimulation } from "../app/useSimulation";
import { ControlsPanel } from "./ControlsPanel";
import { FowtSchematic } from "./FowtSchematic";
import { PlotPanel } from "./PlotPanel";
import { StatusPanel } from "./StatusPanel";

export function SimulationDashboard() {
  const simulation = useSimulation();

  return (
    <main className="dashboard-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Floating offshore wind turbine demo</p>
          <h1>Browser-based FOWT simulator</h1>
          <p>
            Educational 1-DOF IEA 15 MW floating turbine model with aerodynamics from lookup tables,
            above-rated collective pitch control, wind disturbances, and optional
            platform-pitch-rate feedback.
          </p>
        </div>
      </header>

      <div className="dashboard-grid">
        <ControlsPanel
          settings={simulation.settings}
          controllerBandwidthEstimate={simulation.controllerBandwidthEstimate}
          isRunning={simulation.isRunning}
          onStart={simulation.startSimulation}
          onStop={simulation.stopSimulation}
          onReset={simulation.resetSimulation}
          onSettingsChange={simulation.updateSettings}
        />
        <div className="right-column">
          <FowtSchematic sample={simulation.latestSample} history={simulation.history} />
          <StatusPanel
            sample={simulation.latestSample}
            history={simulation.history}
            status={simulation.status}
            statusMessage={simulation.statusMessage}
            runState={simulation.runState}
            isRunning={simulation.isRunning}
          />
          <PlotPanel history={simulation.history} runState={simulation.runState} />
        </div>
      </div>
    </main>
  );
}
