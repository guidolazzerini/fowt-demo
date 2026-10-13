import type { SimulationScenarioSample } from "../sim/simulation";
import { CollectivePitchGauge, RotorSpeedGauge } from "./FowtSchematic";
import { pitchColour } from "./pitchColour";

export function SceneGauges({ sample }: { sample: SimulationScenarioSample | undefined }) {
  const rpm = sample ? sample.rotorSpeedRadPerSec * 60 / (2 * Math.PI) : undefined;
  const pitch = sample ? sample.collectivePitchRad * 180 / Math.PI : undefined;
  return <svg className="scene-gauges" viewBox="0 0 275 160" role="img"
    aria-label={`Rotor speed ${rpm?.toFixed(2) ?? "unavailable"} rpm; blade pitch ${pitch?.toFixed(1) ?? "unavailable"} degrees`}>
    <rect width="275" height="160" rx="12" fill="#ffffffeb" />
    {/* Same 2D instruments, with a 0-rpm lower bound for parked operation. */}
    <RotorSpeedGauge sample={sample} centre={{ x: 72, y: 63 }} minRotorSpeedRpm={0} showReferenceLabels />
    {sample && <CollectivePitchGauge centre={{ x: 205, y: 72 }} collectivePitchDeg={pitch!}
      accentColour={pitchColour(pitch!)} />}
    {!sample && <text x="205" y="72" textAnchor="middle">Blade pitch —</text>}
    <text className="scene-gauge-scale" x="72" y="151" textAnchor="middle">0–10 rpm · 7.55 rated</text>
    <text className="scene-gauge-scale" x="205" y="151" textAnchor="middle">−5° to 90°</text>
  </svg>;
}
