// Shared sRGB display cue for blade pitch [degrees]: blue at 0°, yellow at
// 14°, red at 28°. Only colour saturates; blade motion still reaches 90°.
export function pitchColour(pitchDeg: number): string {
  const fraction = Math.min(1, Math.max(0, pitchDeg / 28));
  const start = fraction < 0.5 ? [37, 99, 235] : [234, 179, 8];
  const end = fraction < 0.5 ? [234, 179, 8] : [220, 38, 38];
  const t = fraction < 0.5 ? fraction * 2 : (fraction - 0.5) * 2;
  const rgb = start.map((value, index) => Math.round(value + (end[index] - value) * t));
  return `rgb(${rgb.join(", ")})`;
}
