export interface TurbineState {
  timeS: number;

  rotorSpeedRadPerSec: number;
  rotorAzimuthRad: number;

  platformPitchRad: number;
  platformPitchRateRadPerSec: number;
}