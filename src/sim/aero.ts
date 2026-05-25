export interface AeroPerformanceTable {
  rotorSpeedRadPerSec: Float64Array;
  pitchRad: Float64Array;
  windSpeedMps: Float64Array;
  cp: Float64Array;
  ct: Float64Array;
  cq?: Float64Array;
  nOmega: number;
  nPitch: number;
  nWind: number;
}

export interface AeroQueryPoint {
  rotorSpeedRadPerSec: number;
  pitchRad: number;
  windSpeedMps: number;
}

export interface AeroCoefficients {
  cp: number;
  ct: number;
  cq?: number;
  clampedRotorSpeedRadPerSec: number;
  clampedPitchRad: number;
  clampedWindSpeedMps: number;
}

export interface AerodynamicComputationOptions {
  airDensityKgPerM3: number;
  rotorRadiusM: number;
  minWindSpeedMpsForAero?: number;
  minRotorSpeedRadPerSecForTorque?: number;
}

export interface AerodynamicOutputs extends AeroCoefficients {
  powerW: number;
  thrustN: number;
  torqueNm: number;
  usedLowWindGuard: boolean;
  usedTorqueFallbackFromCp: boolean;
  usedZeroTorqueGuard: boolean;
}

interface AxisBracket {
  i0: number;
  i1: number;
  weight: number;
  clampedValue: number;
}

const DEFAULT_MIN_WIND_SPEED_MPS_FOR_AERO = 0.1;
const DEFAULT_MIN_ROTOR_SPEED_RAD_PER_SEC_FOR_TORQUE = 0.05;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteFloat64Array(name: string, value: unknown): Float64Array {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }

  if (value.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }

  const out = new Float64Array(value.length);

  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new Error(`${name}[${i}] must be a finite number.`);
    }
    out[i] = entry;
  }

  return out;
}

function toFiniteFieldArray(
  name: string,
  value: unknown,
  expectedLength: number,
): Float64Array {
  const out = toFiniteFloat64Array(name, value);

  if (out.length !== expectedLength) {
    throw new Error(
      `${name} must have length ${expectedLength}, but has length ${out.length}.`,
    );
  }

  return out;
}

function assertAxisCanInterpolate(name: string, axis: Float64Array): void {
  if (axis.length < 2) {
    throw new Error(`${name} must contain at least 2 points for interpolation.`);
  }
}

function assertStrictlyIncreasing(name: string, axis: Float64Array): void {
  for (let i = 1; i < axis.length; i += 1) {
    if (!(axis[i] > axis[i - 1])) {
      throw new Error(
        `${name} must be strictly increasing. Problem between indices ${i - 1} and ${i}.`,
      );
    }
  }
}

function validateAndCanonicaliseAeroTable(raw: unknown): AeroPerformanceTable {
  if (!isPlainObject(raw)) {
    throw new Error("Aero table JSON must be an object.");
  }

  const rotorSpeedRadPerSec = toFiniteFloat64Array(
    "rotorSpeedRadPerSec",
    raw["rotorSpeedRadPerSec"],
  );
  const pitchRad = toFiniteFloat64Array("pitchRad", raw["pitchRad"]);
  const windSpeedMps = toFiniteFloat64Array("windSpeedMps", raw["windSpeedMps"]);

  assertAxisCanInterpolate("rotorSpeedRadPerSec", rotorSpeedRadPerSec);
  assertAxisCanInterpolate("pitchRad", pitchRad);
  assertAxisCanInterpolate("windSpeedMps", windSpeedMps);

  assertStrictlyIncreasing("rotorSpeedRadPerSec", rotorSpeedRadPerSec);
  assertStrictlyIncreasing("pitchRad", pitchRad);
  assertStrictlyIncreasing("windSpeedMps", windSpeedMps);

  const nOmega = rotorSpeedRadPerSec.length;
  const nPitch = pitchRad.length;
  const nWind = windSpeedMps.length;
  const expectedFieldLength = nOmega * nPitch * nWind;

  const cp = toFiniteFieldArray("cp", raw["cp"], expectedFieldLength);
  const ct = toFiniteFieldArray("ct", raw["ct"], expectedFieldLength);

  const cqRaw = raw["cq"];
  const cq =
    cqRaw === undefined
      ? undefined
      : toFiniteFieldArray("cq", cqRaw, expectedFieldLength);

  return {
    rotorSpeedRadPerSec,
    pitchRad,
    windSpeedMps,
    cp,
    ct,
    cq,
    nOmega,
    nPitch,
    nWind,
  };
}

export async function loadAeroTable(path: string): Promise<AeroPerformanceTable> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(
      `Failed to load aero table from "${path}". HTTP ${response.status} ${response.statusText}.`,
    );
  }

  let raw: unknown;
  try {
    raw = (await response.json()) as unknown;
  } catch (error) {
    throw new Error(
      `Aero table at "${path}" is not valid JSON. ${(error as Error).message}`,
    );
  }

  return validateAndCanonicaliseAeroTable(raw);
}

export function getFlatIndex(
  iOmega: number,
  iPitch: number,
  iWind: number,
  nPitch: number,
  nWind: number,
): number {
  return iOmega * (nPitch * nWind) + iPitch * nWind + iWind;
}

function findAxisBracket(axis: Float64Array, value: number): AxisBracket {
  if (!Number.isFinite(value)) {
    throw new Error("Interpolation query contains a non-finite value.");
  }

  const first = axis[0];
  const last = axis[axis.length - 1];

  if (value <= first) {
    return {
      i0: 0,
      i1: 1,
      weight: 0,
      clampedValue: first,
    };
  }

  if (value >= last) {
    return {
      i0: axis.length - 2,
      i1: axis.length - 1,
      weight: 1,
      clampedValue: last,
    };
  }

  let lo = 0;
  let hi = axis.length - 1;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (value < axis[mid]) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  const x0 = axis[lo];
  const x1 = axis[hi];

  return {
    i0: lo,
    i1: hi,
    weight: (value - x0) / (x1 - x0),
    clampedValue: value,
  };
}

function interpolateFlattenedField3D(
  field: Float64Array,
  table: AeroPerformanceTable,
  omegaBracket: AxisBracket,
  pitchBracket: AxisBracket,
  windBracket: AxisBracket,
): number {
  const { nPitch, nWind } = table;

  const i0 = omegaBracket.i0;
  const i1 = omegaBracket.i1;
  const j0 = pitchBracket.i0;
  const j1 = pitchBracket.i1;
  const k0 = windBracket.i0;
  const k1 = windBracket.i1;

  const wx = omegaBracket.weight;
  const wy = pitchBracket.weight;
  const wz = windBracket.weight;

  const c000 = field[getFlatIndex(i0, j0, k0, nPitch, nWind)];
  const c001 = field[getFlatIndex(i0, j0, k1, nPitch, nWind)];
  const c010 = field[getFlatIndex(i0, j1, k0, nPitch, nWind)];
  const c011 = field[getFlatIndex(i0, j1, k1, nPitch, nWind)];
  const c100 = field[getFlatIndex(i1, j0, k0, nPitch, nWind)];
  const c101 = field[getFlatIndex(i1, j0, k1, nPitch, nWind)];
  const c110 = field[getFlatIndex(i1, j1, k0, nPitch, nWind)];
  const c111 = field[getFlatIndex(i1, j1, k1, nPitch, nWind)];

  const c00 = c000 * (1 - wx) + c100 * wx;
  const c01 = c001 * (1 - wx) + c101 * wx;
  const c10 = c010 * (1 - wx) + c110 * wx;
  const c11 = c011 * (1 - wx) + c111 * wx;

  const c0 = c00 * (1 - wy) + c10 * wy;
  const c1 = c01 * (1 - wy) + c11 * wy;

  return c0 * (1 - wz) + c1 * wz;
}

export function getAeroCoefficients(
  table: AeroPerformanceTable,
  query: AeroQueryPoint,
): AeroCoefficients {
  const omegaBracket = findAxisBracket(
    table.rotorSpeedRadPerSec,
    query.rotorSpeedRadPerSec,
  );
  const pitchBracket = findAxisBracket(table.pitchRad, query.pitchRad);
  const windBracket = findAxisBracket(table.windSpeedMps, query.windSpeedMps);

  const cp = interpolateFlattenedField3D(
    table.cp,
    table,
    omegaBracket,
    pitchBracket,
    windBracket,
  );

  const ct = interpolateFlattenedField3D(
    table.ct,
    table,
    omegaBracket,
    pitchBracket,
    windBracket,
  );

  const cq =
    table.cq === undefined
      ? undefined
      : interpolateFlattenedField3D(
          table.cq,
          table,
          omegaBracket,
          pitchBracket,
          windBracket,
        );

  return {
    cp,
    ct,
    cq,
    clampedRotorSpeedRadPerSec: omegaBracket.clampedValue,
    clampedPitchRad: pitchBracket.clampedValue,
    clampedWindSpeedMps: windBracket.clampedValue,
  };
}

export function computeAerodynamicOutputs(
  table: AeroPerformanceTable,
  query: AeroQueryPoint,
  options: AerodynamicComputationOptions,
): AerodynamicOutputs {
  const minWindSpeedMpsForAero =
    options.minWindSpeedMpsForAero ?? DEFAULT_MIN_WIND_SPEED_MPS_FOR_AERO;
  const minRotorSpeedRadPerSecForTorque =
    options.minRotorSpeedRadPerSecForTorque ??
    DEFAULT_MIN_ROTOR_SPEED_RAD_PER_SEC_FOR_TORQUE;

  if (!Number.isFinite(options.airDensityKgPerM3) || options.airDensityKgPerM3 <= 0) {
    throw new Error("airDensityKgPerM3 must be a positive finite number.");
  }

  if (!Number.isFinite(options.rotorRadiusM) || options.rotorRadiusM <= 0) {
    throw new Error("rotorRadiusM must be a positive finite number.");
  }

  const coeffs = getAeroCoefficients(table, query);

  const effectiveWindSpeedMps = Math.max(0, query.windSpeedMps);
  const effectiveRotorSpeedRadPerSec = query.rotorSpeedRadPerSec;

  if (effectiveWindSpeedMps < minWindSpeedMpsForAero) {
    return {
      ...coeffs,
      powerW: 0,
      thrustN: 0,
      torqueNm: 0,
      usedLowWindGuard: true,
      usedTorqueFallbackFromCp: false,
      usedZeroTorqueGuard: false,
    };
  }

  const rotorAreaM2 = Math.PI * options.rotorRadiusM * options.rotorRadiusM;
  const dynamicPressureTimesArea =
    0.5 *
    options.airDensityKgPerM3 *
    rotorAreaM2 *
    effectiveWindSpeedMps *
    effectiveWindSpeedMps;

  const powerW = dynamicPressureTimesArea * effectiveWindSpeedMps * coeffs.cp;
  const thrustN = dynamicPressureTimesArea * coeffs.ct;

  if (coeffs.cq !== undefined) {
    const torqueNm =
      dynamicPressureTimesArea * options.rotorRadiusM * coeffs.cq;

    return {
      ...coeffs,
      powerW,
      thrustN,
      torqueNm,
      usedLowWindGuard: false,
      usedTorqueFallbackFromCp: false,
      usedZeroTorqueGuard: false,
    };
  }

  if (Math.abs(effectiveRotorSpeedRadPerSec) < minRotorSpeedRadPerSecForTorque) {
    return {
      ...coeffs,
      powerW,
      thrustN,
      torqueNm: 0,
      usedLowWindGuard: false,
      usedTorqueFallbackFromCp: true,
      usedZeroTorqueGuard: true,
    };
  }

  return {
    ...coeffs,
    powerW,
    thrustN,
    torqueNm: powerW / effectiveRotorSpeedRadPerSec,
    usedLowWindGuard: false,
    usedTorqueFallbackFromCp: true,
    usedZeroTorqueGuard: false,
  };
}

export function describeAeroTable(table: AeroPerformanceTable): string {
  const cqStatus = table.cq === undefined ? "absent" : "present";

  return [
    `nOmega=${table.nOmega}`,
    `nPitch=${table.nPitch}`,
    `nWind=${table.nWind}`,
    `omega=[${table.rotorSpeedRadPerSec[0]}, ${table.rotorSpeedRadPerSec[table.nOmega - 1]}]`,
    `pitch=[${table.pitchRad[0]}, ${table.pitchRad[table.nPitch - 1]}]`,
    `wind=[${table.windSpeedMps[0]}, ${table.windSpeedMps[table.nWind - 1]}]`,
    `cq=${cqStatus}`,
  ].join(", ");
}