import { useCallback, useEffect, useRef, useState } from "react";
import type { SimulationScenarioSample } from "../sim/simulation";
import {
  DEFAULT_SIMULATION_UI_SETTINGS,
  type ControllerBandwidthEstimate,
  type SimulationUiSettings,
  type SimulationWorkerRequest,
  type SimulationWorkerResponse,
  type SimulationWorkerStatus,
} from "../sim/workerMessages";

const HISTORY_WINDOW_S = 90;
const MAX_HISTORY_SAMPLES = 600;

export type SimulationRunState = "loading" | "stopped" | "running" | "reset" | "error";

export interface UseSimulationResult {
  latestSample: SimulationScenarioSample | undefined;
  history: SimulationScenarioSample[];
  controllerBandwidthEstimate: ControllerBandwidthEstimate | undefined;
  settings: SimulationUiSettings;
  status: SimulationWorkerStatus;
  statusMessage: string | undefined;
  runState: SimulationRunState;
  isRunning: boolean;
  startSimulation: () => void;
  stopSimulation: () => void;
  resetSimulation: () => void;
  updateSettings: (settings: Partial<SimulationUiSettings>) => void;
}

export function useSimulation(): UseSimulationResult {
  const workerRef = useRef<Worker | undefined>(undefined);
  const [latestSample, setLatestSample] = useState<SimulationScenarioSample>();
  const [history, setHistory] = useState<SimulationScenarioSample[]>([]);
  const [settings, setSettings] = useState<SimulationUiSettings>({
    ...DEFAULT_SIMULATION_UI_SETTINGS,
  });
  const [controllerBandwidthEstimate, setControllerBandwidthEstimate] =
    useState<ControllerBandwidthEstimate>();
  const [status, setStatus] = useState<SimulationWorkerStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string>();
  const [runState, setRunState] = useState<SimulationRunState>("loading");
  const [isRunning, setIsRunning] = useState(false);

  const updateRunStateFromWorker = useCallback(
    (nextStatus: SimulationWorkerStatus, nextIsRunning: boolean): void => {
      if (nextIsRunning || nextStatus === "running") {
        setRunState("running");
        return;
      }

      if (nextStatus === "loading") {
        setRunState("loading");
        return;
      }

      if (nextStatus === "error") {
        setRunState("error");
        return;
      }

      setRunState((previousRunState) =>
        previousRunState === "reset" ? "reset" : "stopped",
      );
    },
    [],
  );

  const handleWorkerResponse = useCallback(
    (response: SimulationWorkerResponse): void => {
      setIsRunning(response.isRunning);

      switch (response.type) {
        case "status":
          setStatus(response.status);
          setStatusMessage(response.message);
          updateRunStateFromWorker(response.status, response.isRunning);
          break;
        case "ready":
          setStatus(response.isRunning ? "running" : "ready");
          setStatusMessage(undefined);
          setSettings(response.settings);
          setControllerBandwidthEstimate(response.controllerBandwidthEstimate);
          setLatestSample(response.sample);
          setHistory([response.sample]);
          updateRunStateFromWorker(response.isRunning ? "running" : "ready", response.isRunning);
          break;
        case "sample":
          setStatus(response.isRunning ? "running" : "ready");
          setStatusMessage(undefined);
          setSettings(response.settings);
          setControllerBandwidthEstimate(response.controllerBandwidthEstimate);
          setLatestSample(response.sample);
          setHistory((previousHistory) => appendHistorySample(previousHistory, response.sample));
          updateRunStateFromWorker(response.isRunning ? "running" : "ready", response.isRunning);
          break;
        case "error":
          setStatus("error");
          setStatusMessage(response.message);
          setRunState("error");
          break;
      }
    },
    [updateRunStateFromWorker],
  );

  useEffect(() => {
    const worker = new Worker(new URL("../sim/simulationWorker.ts", import.meta.url), {
      type: "module",
    });

    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = event.data;

      if (!isSimulationWorkerResponse(response)) {
        setStatus("error");
        setStatusMessage("Received an unknown message from the simulation worker.");
        setRunState("error");
        return;
      }

      handleWorkerResponse(response);
    };

    postToWorker(worker, { type: "initialise" });

    return () => {
      worker.terminate();
      workerRef.current = undefined;
    };
  }, [handleWorkerResponse]);

  const postRequest = useCallback((request: SimulationWorkerRequest) => {
    const worker = workerRef.current;

    if (worker === undefined) {
      setStatus("error");
      setStatusMessage("Simulation worker is not available.");
      setRunState("error");
      return;
    }

    postToWorker(worker, request);
  }, []);

  const startSimulation = useCallback(() => {
    setRunState("running");
    postRequest({ type: "start" });
  }, [postRequest]);

  const stopSimulation = useCallback(() => {
    setRunState("stopped");
    postRequest({ type: "stop" });
  }, [postRequest]);

  const resetSimulation = useCallback(() => {
    setRunState("reset");
    postRequest({ type: "reset" });
  }, [postRequest]);

  const updateSettings = useCallback(
    (partialSettings: Partial<SimulationUiSettings>) => {
      setSettings((previousSettings) => ({ ...previousSettings, ...partialSettings }));
      postRequest({ type: "update-settings", settings: partialSettings });
    },
    [postRequest],
  );

  return {
    latestSample,
    history,
    controllerBandwidthEstimate,
    settings,
    status,
    statusMessage,
    runState,
    isRunning,
    startSimulation,
    stopSimulation,
    resetSimulation,
    updateSettings,
  };
}

function postToWorker(worker: Worker, request: SimulationWorkerRequest): void {
  worker.postMessage(request);
}

function appendHistorySample(
  previousHistory: SimulationScenarioSample[],
  sample: SimulationScenarioSample,
): SimulationScenarioSample[] {
  const nextHistory = [...previousHistory, sample];
  const filteredHistory = nextHistory.filter(
    (candidate) => sample.timeS - candidate.timeS <= HISTORY_WINDOW_S,
  );

  if (filteredHistory.length > MAX_HISTORY_SAMPLES) {
    return filteredHistory.slice(filteredHistory.length - MAX_HISTORY_SAMPLES);
  }

  return filteredHistory;
}

function isSimulationWorkerResponse(value: unknown): value is SimulationWorkerResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { type?: unknown; isRunning?: unknown };

  return (
    typeof candidate.type === "string" &&
    typeof candidate.isRunning === "boolean" &&
    ["status", "ready", "sample", "error"].includes(candidate.type)
  );
}
