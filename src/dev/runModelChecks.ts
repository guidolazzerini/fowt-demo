import { loadAeroTable } from "../sim/aero";
import { DEFAULT_TUNABLE_PARAMETERS } from "../sim/defaults";
import type { ControlInputs, EnvironmentInputs } from "../sim/inputs";
import { stepSimulation } from "../sim/model";
import type { TurbineState } from "../sim/state";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFinite(name: string, value: number): void {
  assert(Number.isFinite(value), `${name} is not finite: ${value}`);
}

async function runModelChecks(): Promise<void> {
  console.group("Model Step 4.2 validation");

  const params = DEFAULT_TUNABLE_PARAMETERS;
  const aeroTable = await loadAeroTable(params.aero.filePath);

  const initialState: TurbineState = {
    timeS: 0,
    rotorSpeedRadPerSec: params.ratedRotorSpeedRadPerSec,
    rotorAzimuthRad: 0,
    platformPitchRad: 0,
    platformPitchRateRadPerSec: 0,
  };

  const environment: EnvironmentInputs = {
    windSpeedMps: 12,
    wavePitchMomentNm: 0,
  };

  const control: ControlInputs = {
    collectivePitchRad: 0.145,
    generatorTorqueNm: 1.5e7,
  };

  const first = stepSimulation(
    initialState,
    environment,
    control,
    params,
    aeroTable,
    { dtS: 0.01 },
  );

  console.log("Single-step output:", first);

  assert(first.timeS > initialState.timeS, "Time did not advance.");

  assertFinite("rotorSpeedRadPerSec", first.state.rotorSpeedRadPerSec);
  assertFinite("rotorAzimuthRad", first.state.rotorAzimuthRad);
  assertFinite("platformPitchRad", first.state.platformPitchRad);
  assertFinite(
    "platformPitchRateRadPerSec",
    first.state.platformPitchRateRadPerSec,
  );

  assertFinite("effectiveWindSpeedMps", first.outputs.effectiveWindSpeedMps);
  assertFinite("aerodynamicPowerW", first.outputs.aerodynamicPowerW);
  assertFinite("aerodynamicTorqueNm", first.outputs.aerodynamicTorqueNm);
  assertFinite("thrustN", first.outputs.thrustN);
  assertFinite("cp", first.outputs.cp);
  assertFinite("ct", first.outputs.ct);

  assert(
    first.state.rotorSpeedRadPerSec >= 0,
    "Rotor speed became negative.",
  );

  let state = initialState;

  for (let k = 0; k < 3000; k += 1) {
    const snapshot = stepSimulation(
      state,
      environment,
      control,
      params,
      aeroTable,
      { dtS: 0.01 },
    );

    state = snapshot.state;

    assertFinite("multi-step rotorSpeedRadPerSec", state.rotorSpeedRadPerSec);
    assertFinite("multi-step platformPitchRad", state.platformPitchRad);
    assertFinite(
      "multi-step platformPitchRateRadPerSec",
      state.platformPitchRateRadPerSec,
    );
  }

  console.log("Multi-step final state:", state);
  console.log("Model Step 4.2 validation passed.");
  console.groupEnd();
}

if (import.meta.env.DEV) {
  void runModelChecks().catch((error: unknown) => {
    console.error("Model Step 4.2 validation failed:", error);
  });
}