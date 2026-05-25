import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("checks") === "1") {
  void import("./dev/runWindChecks").then(({ runWindChecks }) => {
    runWindChecks();
  });

  void import("./dev/runWindResponseChecks").then(
    ({ runWindResponseChecks }) => {
      void runWindResponseChecks();
    },
  );

  void import("./dev/runControllerChecks").then(({ runControllerChecks }) => {
    runControllerChecks();
  });

  void import("./dev/runClosedLoopWindChecks").then(
    ({ runClosedLoopWindChecks }) => {
      void runClosedLoopWindChecks();
    },
  );

  void import("./dev/runSimulationScenarioChecks").then(
    ({ runSimulationScenarioChecks }) => {
      void runSimulationScenarioChecks();
    },
  );

  void import("./dev/runFloatingFeedbackChecks").then(
    ({ runFloatingFeedbackChecks }) => {
      void runFloatingFeedbackChecks();
    },
  );
}


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)