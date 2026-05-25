import {
  computeAerodynamicOutputs,
  describeAeroTable,
  getAeroCoefficients,
  loadAeroTable,
} from "../sim/aero";

const AERO_PATH = "/iea15mw-aero-v1.json";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return value.toExponential(6);
}

async function runAeroChecks(): Promise<void> {
  console.group("Aero Step 4.1 validation");

  const table = await loadAeroTable(AERO_PATH);
  console.log("Loaded aero table:", describeAeroTable(table));

  assert(table.cp.length === table.nOmega * table.nPitch * table.nWind, "cp length mismatch.");
  assert(table.ct.length === table.nOmega * table.nPitch * table.nWind, "ct length mismatch.");
  if (table.cq !== undefined) {
    assert(table.cq.length === table.nOmega * table.nPitch * table.nWind, "cq length mismatch.");
  }

  const iOmegaMid = Math.floor(table.nOmega / 2);
  const iPitchMid = Math.floor(table.nPitch / 2);
  const iWindMid = Math.floor(table.nWind / 2);

  const nominalQuery = {
    rotorSpeedRadPerSec: table.rotorSpeedRadPerSec[iOmegaMid],
    pitchRad: table.pitchRad[iPitchMid],
    windSpeedMps: table.windSpeedMps[iWindMid],
  };

  const nominalCoeffs = getAeroCoefficients(table, nominalQuery);
  console.log("Nominal coefficient sample:", nominalCoeffs);

  assert(Number.isFinite(nominalCoeffs.cp), "Nominal Cp is not finite.");
  assert(Number.isFinite(nominalCoeffs.ct), "Nominal Ct is not finite.");
  if (nominalCoeffs.cq !== undefined) {
    assert(Number.isFinite(nominalCoeffs.cq), "Nominal Cq is not finite.");
  }

  const lowWindOutputs = computeAerodynamicOutputs(
    table,
    {
      rotorSpeedRadPerSec: nominalQuery.rotorSpeedRadPerSec,
      pitchRad: nominalQuery.pitchRad,
      windSpeedMps: 0.01,
    },
    {
      airDensityKgPerM3: 1.225,
      rotorRadiusM: 120,
    },
  );

  console.log("Low-wind guard sample:", lowWindOutputs);

  assert(lowWindOutputs.usedLowWindGuard, "Low-wind guard did not trigger.");
  assert(lowWindOutputs.powerW === 0, "Low-wind guard power is not zero.");
  assert(lowWindOutputs.thrustN === 0, "Low-wind guard thrust is not zero.");
  assert(lowWindOutputs.torqueNm === 0, "Low-wind guard torque is not zero.");

  const nominalOutputs = computeAerodynamicOutputs(
    table,
    nominalQuery,
    {
      airDensityKgPerM3: 1.225,
      rotorRadiusM: 120,
    },
  );

  console.log("Nominal output sample:", nominalOutputs);

  assert(Number.isFinite(nominalOutputs.powerW), "Nominal power is not finite.");
  assert(Number.isFinite(nominalOutputs.thrustN), "Nominal thrust is not finite.");
  assert(Number.isFinite(nominalOutputs.torqueNm), "Nominal torque is not finite.");
  assert(nominalOutputs.powerW >= 0, "Nominal power is negative.");
  assert(nominalOutputs.thrustN >= 0, "Nominal thrust is negative.");

  const windBoundaryIndex = Math.max(1, Math.min(table.nWind - 2, iWindMid));
  const windBoundary = table.windSpeedMps[windBoundaryIndex];
  const windEps = 1e-6;

  const cpLeftWind = getAeroCoefficients(table, {
    rotorSpeedRadPerSec: nominalQuery.rotorSpeedRadPerSec,
    pitchRad: nominalQuery.pitchRad,
    windSpeedMps: windBoundary - windEps,
  }).cp;

  const cpRightWind = getAeroCoefficients(table, {
    rotorSpeedRadPerSec: nominalQuery.rotorSpeedRadPerSec,
    pitchRad: nominalQuery.pitchRad,
    windSpeedMps: windBoundary + windEps,
  }).cp;

  const cpWindJump = Math.abs(cpRightWind - cpLeftWind);
  console.log("Continuity across wind cell boundary, |ΔCp| =", formatNumber(cpWindJump));
  assert(cpWindJump < 1e-4, `Cp jump across wind boundary too large: ${cpWindJump}.`);

  const omegaBoundaryIndex = Math.max(1, Math.min(table.nOmega - 2, iOmegaMid));
  const omegaBoundary = table.rotorSpeedRadPerSec[omegaBoundaryIndex];
  const omegaEps = 1e-6;

  const ctLeftOmega = getAeroCoefficients(table, {
    rotorSpeedRadPerSec: omegaBoundary - omegaEps,
    pitchRad: nominalQuery.pitchRad,
    windSpeedMps: nominalQuery.windSpeedMps,
  }).ct;

  const ctRightOmega = getAeroCoefficients(table, {
    rotorSpeedRadPerSec: omegaBoundary + omegaEps,
    pitchRad: nominalQuery.pitchRad,
    windSpeedMps: nominalQuery.windSpeedMps,
  }).ct;

  const ctOmegaJump = Math.abs(ctRightOmega - ctLeftOmega);
  console.log("Continuity across omega cell boundary, |ΔCt| =", formatNumber(ctOmegaJump));
  assert(ctOmegaJump < 1e-4, `Ct jump across omega boundary too large: ${ctOmegaJump}.`);

  const pitchBoundaryIndex = Math.max(1, Math.min(table.nPitch - 2, iPitchMid));
  const pitchBoundary = table.pitchRad[pitchBoundaryIndex];
  const pitchEps = 1e-6;

  const coeffsBelowPitch = getAeroCoefficients(table, {
    rotorSpeedRadPerSec: nominalQuery.rotorSpeedRadPerSec,
    pitchRad: pitchBoundary - pitchEps,
    windSpeedMps: nominalQuery.windSpeedMps,
  });

  const coeffsAbovePitch = getAeroCoefficients(table, {
    rotorSpeedRadPerSec: nominalQuery.rotorSpeedRadPerSec,
    pitchRad: pitchBoundary + pitchEps,
    windSpeedMps: nominalQuery.windSpeedMps,
  });

  const cpPitchJump = Math.abs(coeffsAbovePitch.cp - coeffsBelowPitch.cp);
  const ctPitchJump = Math.abs(coeffsAbovePitch.ct - coeffsBelowPitch.ct);

  console.log("Continuity across pitch cell boundary, |ΔCp| =", formatNumber(cpPitchJump));
  console.log("Continuity across pitch cell boundary, |ΔCt| =", formatNumber(ctPitchJump));

  assert(cpPitchJump < 1e-4, `Cp jump across pitch boundary too large: ${cpPitchJump}.`);
  assert(ctPitchJump < 1e-4, `Ct jump across pitch boundary too large: ${ctPitchJump}.`);

  const sweepWindStart = table.windSpeedMps[Math.max(0, iWindMid - 1)];
  const sweepWindEnd = table.windSpeedMps[Math.min(table.nWind - 1, iWindMid + 1)];
  const nSweep = 25;

  let previousCp: number | undefined;
  let maxSweepCpDelta = 0;

  for (let i = 0; i < nSweep; i += 1) {
    const alpha = i / (nSweep - 1);
    const wind = sweepWindStart + alpha * (sweepWindEnd - sweepWindStart);

    const coeffs = getAeroCoefficients(table, {
      rotorSpeedRadPerSec: nominalQuery.rotorSpeedRadPerSec,
      pitchRad: nominalQuery.pitchRad,
      windSpeedMps: wind,
    });

    assert(Number.isFinite(coeffs.cp), `Sweep Cp is not finite at wind=${wind}.`);
    assert(Number.isFinite(coeffs.ct), `Sweep Ct is not finite at wind=${wind}.`);

    if (previousCp !== undefined) {
      const delta = Math.abs(coeffs.cp - previousCp);
      if (delta > maxSweepCpDelta) {
        maxSweepCpDelta = delta;
      }
    }

    previousCp = coeffs.cp;
  }

  console.log("Smoothness sweep max adjacent |ΔCp| =", formatNumber(maxSweepCpDelta));

  const outsideRangeCoeffs = getAeroCoefficients(table, {
    rotorSpeedRadPerSec: table.rotorSpeedRadPerSec[0] - 10,
    pitchRad: table.pitchRad[table.nPitch - 1] + 10,
    windSpeedMps: table.windSpeedMps[table.nWind - 1] + 100,
  });

  console.log("Outside-range clamping sample:", outsideRangeCoeffs);

  assert(
    outsideRangeCoeffs.clampedRotorSpeedRadPerSec === table.rotorSpeedRadPerSec[0],
    "Lower omega clamping failed.",
  );
  assert(
    outsideRangeCoeffs.clampedPitchRad === table.pitchRad[table.nPitch - 1],
    "Upper pitch clamping failed.",
  );
  assert(
    outsideRangeCoeffs.clampedWindSpeedMps === table.windSpeedMps[table.nWind - 1],
    "Upper wind clamping failed.",
  );

  console.log("Aero Step 4.1 validation passed.");
  console.groupEnd();
}

if (import.meta.env.DEV) {
  void runAeroChecks().catch((error: unknown) => {
    console.error("Aero Step 4.1 validation failed:", error);
  });
}