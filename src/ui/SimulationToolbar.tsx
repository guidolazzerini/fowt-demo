import type { UseSimulationResult } from "../app/useSimulation";
import { InfoDisclosure } from "./InfoDisclosure";

export function SimulationToolbar({ simulation }: { simulation: UseSimulationResult }) {
  const { operation, isRunning, runState, latestSample, statusMessage } = simulation;
  const needsAttention = operation?.requiresReset || runState === "error";
  const strategy = !operation ? "Loading model" : operation.activeStrategy === "coordinated-tsr-pi" ?
    "Coordinated TSR PI · 3–25 m/s" : "Legacy above-rated · 10–20 m/s";
  return <section className="simulation-toolbar" aria-label="Simulation controls">
    <div className="toolbar-main">
      <div className="button-row">
        <button type="button" onClick={simulation.startSimulation} disabled={isRunning || !operation?.canStart || runState === "error"}>Start</button>
        <button type="button" className="secondary-button" onClick={simulation.stopSimulation} disabled={!isRunning}>Stop</button>
        <button type="button" className="secondary-button" onClick={simulation.resetSimulation}>Reset</button>
        {operation?.turbinePhase && <>
          <button type="button" onClick={simulation.startTurbine} disabled={!operation.canStartTurbine || runState === "error"}>Start turbine</button>
          <button type="button" className="secondary-button" onClick={simulation.shutdownTurbine}
            disabled={!operation.canShutDown || runState === "error"}>Shut down turbine</button>
        </>}
      </div>
      <div className="operation-summary">
        <span className={needsAttention ? "region-badge needs-attention" : "region-badge"} role="status">{operation?.region ?? "Loading"}</span>
        <span className="strategy-caption">{strategy}</span>
      </div>
      <div className="toolbar-clock"><span className={"run-state-pill run-state-" + runState}>{runState}</span>
        <span>{latestSample?.timeS.toFixed(1) ?? "0.0"} s</span></div>
    </div>
    {needsAttention && <p className="operation-alert" role="alert">{statusMessage ?? operation?.message}</p>}
    {operation?.turbinePhase && operation.turbinePhase !== "generating" &&
      <p className="setting-timing">{operation.message}</p>}
    <InfoDisclosure label="Run controls and model scope">
      <p>Stop pauses the clock; Start resumes. Reset returns to time zero and repeats the wind.
        With startup/shutdown enabled, Reset parks the rotor; Start turbine and Shut down turbine run the physical sequence.</p>
      <p>Gains apply live. Strategy, startup mode and coordinated pitch-limit changes require Reset.
        Numeric edits apply on Enter or leaving the field; Escape cancels.</p>
      <p>{operation?.message}</p>
      <p>Educational model: aerodynamic tables, rotor dynamics and one platform-pitch degree of freedom.
        Startup and shutdown loads are approximate.</p>
    </InfoDisclosure>
  </section>;
}
