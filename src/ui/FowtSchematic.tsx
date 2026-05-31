import type { SimulationScenarioSample } from "../sim/simulation";

interface FowtSchematicProps {
  sample: SimulationScenarioSample | undefined;
  history: SimulationScenarioSample[];
}

interface Point {
  x: number;
  y: number;
}

interface MovingStats {
  standardDeviation: number;
}

const RAD_TO_DEG = 180 / Math.PI;
const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);

const SVG_WIDTH = 900;
const SVG_HEIGHT = 580;
const WATERLINE_Y = 340;
const SEABED_Y = 535;
const PITCH_PIVOT: Point = { x: 455, y: 324 };
const PLATFORM_PITCH_VISUAL_GAIN = 1.0;
const MAX_VISUAL_PITCH_DEG = 12;
const SCHEMATIC_MOVING_WINDOW_S = 30;

export function FowtSchematic(props: FowtSchematicProps) {
  const { sample, history } = props;

  const rotorAzimuthRad = sample?.rotorAzimuthRad ?? 0;
  const collectivePitchRad = sample?.collectivePitchRad ?? 0;
  const platformPitchRad = sample?.platformPitchRad ?? 0;
  const pitchVisualDeg = clamp(
    platformPitchRad * RAD_TO_DEG * PLATFORM_PITCH_VISUAL_GAIN,
    -MAX_VISUAL_PITCH_DEG,
    MAX_VISUAL_PITCH_DEG,
  );
  const pitchVisualRad = pitchVisualDeg / RAD_TO_DEG;

  const leftFairlead = transformLocalPoint({ x: -110, y: 3 }, pitchVisualRad);
  const rightFairlead = transformLocalPoint({ x: 110, y: 3 }, pitchVisualRad);

  const leftAnchor = { x: 130, y: SEABED_Y };
  const rightAnchor = { x: 780, y: SEABED_Y };

  const windArrow = getWindArrowStyle(sample?.windSpeedMps);

  return (
    <section className="panel schematic-panel" aria-labelledby="schematic-heading">
      <div className="panel-header">
        <div>
          <h2 id="schematic-heading">FOWT side-view schematic</h2>
        </div>
      </div>

      <svg
        className="fowt-svg"
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        role="img"
        aria-label="Animated side-view schematic of a floating offshore wind turbine"
      >
        <defs>
          <clipPath id="fowt-drawing-clip">
            <rect x="10" y="10" width={SVG_WIDTH - 20} height={SVG_HEIGHT - 20} rx="14" />
          </clipPath>
        </defs>

        <rect className="fowt-sky" x="0" y="0" width={SVG_WIDTH} height={WATERLINE_Y} />
        <rect className="fowt-water" x="0" y={WATERLINE_Y} width={SVG_WIDTH} height={SEABED_Y - WATERLINE_Y} />
        <rect className="fowt-soil" x="0" y={SEABED_Y} width={SVG_WIDTH} height={SVG_HEIGHT - SEABED_Y} />

        <path
          className="fowt-waterline"
          d={`M 0 ${WATERLINE_Y} C 95 ${WATERLINE_Y - 4}, 170 ${WATERLINE_Y + 4}, 245 ${WATERLINE_Y} S 410 ${WATERLINE_Y - 5}, 500 ${WATERLINE_Y} S 665 ${WATERLINE_Y + 5}, 760 ${WATERLINE_Y} S 850 ${WATERLINE_Y - 4}, 900 ${WATERLINE_Y}`}
        />
        <line className="fowt-seabed" x1="0" y1={SEABED_Y} x2={SVG_WIDTH} y2={SEABED_Y} />

        <g className="fowt-wind-arrow" aria-hidden="true">
          <text x="72" y="96">wind</text>
          <line
            x1={72}
            y1={124}
            x2={72 + windArrow.length - 36}
            y2={124}
            style={{ stroke: windArrow.color, strokeWidth: windArrow.strokeWidth }}
          />
          <path
            d={`M ${72 + windArrow.length - 38} ${124 - windArrow.headHalfHeight} L ${72 + windArrow.length} 124 L ${72 + windArrow.length - 38} ${124 + windArrow.headHalfHeight} Z`}
            style={{ fill: windArrow.color }}
          />
          <text className="fowt-wind-speed" x="72" y="168">
            {sample === undefined ? "--" : `${formatNumber(sample.windSpeedMps, 1)} m/s`}
          </text>
        </g>

        <g clipPath="url(#fowt-drawing-clip)">
          <g className="fowt-moorings">
            <path d={createCatenaryPath(leftFairlead, leftAnchor)} />
            <path d={createCatenaryPath(rightFairlead, rightAnchor)} />
          </g>
          <g className="fowt-anchors">
            <Anchor point={leftAnchor} />
            <Anchor point={rightAnchor} />
          </g>

          <g
            className="fowt-pitching-body"
            transform={`rotate(${pitchVisualDeg} ${PITCH_PIVOT.x} ${PITCH_PIVOT.y})`}
          >
            <Platform />
            <TowerAndNacelle rotorAzimuthRad={rotorAzimuthRad} collectivePitchRad={collectivePitchRad} />
            <g className="fowt-fairleads">
              <circle cx={PITCH_PIVOT.x - 110} cy={PITCH_PIVOT.y + 3} r="4.5" />
              <circle cx={PITCH_PIVOT.x + 110} cy={PITCH_PIVOT.y + 3} r="4.5" />
            </g>
          </g>
        </g>

        <InSvgReadouts sample={sample} />
        <RotorSpeedGauge sample={sample} centre={{ x: 680, y: 100 }} />

        <g className="fowt-mini-labels" aria-hidden="true">
          <text x="786" y={WATERLINE_Y - 11}>waterline</text>
          <text x="810" y={SEABED_Y - 11}>seabed</text>
        </g>
      </svg>

      <SchematicReadouts sample={sample} history={history} />
    </section>
  );
}

function Platform() {
  const x0 = PITCH_PIVOT.x;
  const y0 = PITCH_PIVOT.y;

  return (
    <g className="fowt-platform">
      <rect x={x0 - 110} y={y0 - 12} width="228" height="15" rx="4" />

      <rect x={x0 - 110} y={y0 + 3} width="34" height="76" rx="6" />
      <rect x={x0 + 76} y={y0 + 3} width="34" height="76" rx="6" />

      <rect x={x0 - 122} y={y0 + 78} width="58" height="10" rx="5" />
      <rect x={x0 + 64} y={y0 + 78} width="58" height="10" rx="5" />

      <rect x={x0 - 15} y={y0 - 20} width="30" height="8" rx="3" className="fowt-tower-seat" />
      <circle cx={x0} cy={y0} r="4" className="fowt-pitch-pivot" />
    </g>
  );
}

function TowerAndNacelle(props: {
  rotorAzimuthRad: number;
  collectivePitchRad: number;
}) {
  const { rotorAzimuthRad, collectivePitchRad } = props;
  const x0 = PITCH_PIVOT.x;
  const y0 = PITCH_PIVOT.y;
  const towerBaseY = y0 - 20;
  const towerTopY = y0 - 230;
  const nacelleCentreY = towerTopY - 2;
  const hub: Point = { x: x0 - 49, y: nacelleCentreY - 4 };
  const rotorTiltDeg = -4;

  return (
    <g className="fowt-turbine">
      <path
        className="fowt-tower-fill"
        d={`M ${x0 - 9} ${towerBaseY} L ${x0 - 5} ${towerTopY} L ${x0 + 5} ${towerTopY} L ${x0 + 9} ${towerBaseY} Z`}
      />
      <path
        className="fowt-tower-line"
        d={`M ${x0 - 9} ${towerBaseY} L ${x0 - 5} ${towerTopY} L ${x0 + 5} ${towerTopY} L ${x0 + 9} ${towerBaseY} Z`}
      />

      <rect className="fowt-nacelle" x={x0 - 42} y={nacelleCentreY - 12} width="84" height="24" rx="10" />

      <RotorSideProjection
        hub={hub}
        rotorAzimuthRad={rotorAzimuthRad}
        collectivePitchRad={collectivePitchRad}
        tiltDeg={rotorTiltDeg}
      />
    </g>
  );
}

function RotorSideProjection(props: {
  hub: Point;
  rotorAzimuthRad: number;
  collectivePitchRad: number;
  tiltDeg: number;
}) {
  const { hub, rotorAzimuthRad, collectivePitchRad, tiltDeg } = props;
  const bladeRadiusPx = 88;
  const bladeAngles = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
  const collectivePitchDeg = collectivePitchRad * RAD_TO_DEG;
  const pitchFraction = clamp(collectivePitchDeg / 28, 0, 1);
  const bladeColour = getCollectivePitchColour(pitchFraction);

  const projectedBlades = bladeAngles
    .map((offset) => {
      const theta = rotorAzimuthRad + offset;
      const projectedVertical = -Math.cos(theta) * bladeRadiusPx;
      const depthCue = Math.sin(theta);
      const tip: Point = {
        x: hub.x + 8 * depthCue,
        y: hub.y + projectedVertical,
      };
      const opacity = 0.25 + 0.7 * ((depthCue + 1) / 2);
      const width = 4.6 + 0.8 * Math.abs(depthCue);
      return { key: offset, tip, depthCue, opacity, width };
    })
    .sort((a, b) => a.depthCue - b.depthCue);

  return (
    <g className="fowt-edge-on-rotor" transform={`rotate(${tiltDeg} ${hub.x} ${hub.y})`}>
      <ellipse cx={hub.x} cy={hub.y} rx="10" ry={bladeRadiusPx} />
      {projectedBlades.map((blade) => (
        <line
          key={blade.key}
          className="fowt-blade"
          x1={hub.x}
          y1={hub.y}
          x2={blade.tip.x}
          y2={blade.tip.y}
          style={{
            opacity: blade.opacity,
            strokeWidth: blade.width,
            stroke: bladeColour,
          }}
        />
      ))}
      <CollectivePitchGauge
        centre={{ x: hub.x - 66, y: hub.y + 50 }}
        collectivePitchDeg={collectivePitchDeg}
        accentColour={bladeColour}
      />
    </g>
  );
}

function CollectivePitchGauge(props: {
  centre: Point;
  collectivePitchDeg: number;
  accentColour: string;
}) {
  const { centre, collectivePitchDeg, accentColour } = props;
  const minPitchDeg = -5;
  const maxPitchDeg = 30;
  const clampedPitchDeg = clamp(collectivePitchDeg, minPitchDeg, maxPitchDeg);
  const pitchFraction = (clampedPitchDeg - minPitchDeg) / (maxPitchDeg - minPitchDeg);
  const startAngleDeg = 210;
  const endAngleDeg = -30;
  const gaugeRadiusPx = 30;
  const needleLengthPx = 23;
  const needleAngleDeg = startAngleDeg + pitchFraction * (endAngleDeg - startAngleDeg);
  const outerArcPath = createArcPath(centre, gaugeRadiusPx, startAngleDeg, endAngleDeg);
  const filledArcPath = createArcPath(centre, gaugeRadiusPx, startAngleDeg, needleAngleDeg);
  const needleTip = pointOnCircle(centre, needleLengthPx, needleAngleDeg);

  return (
    <g className="fowt-collective-pitch-gauge" aria-hidden="true">
      <text className="fowt-gauge-label" x={centre.x} y={centre.y - 35} textAnchor="middle">Blade Pitch</text>
      <path className="fowt-gauge-ring" d={outerArcPath} />
      <path className="fowt-gauge-fill" d={filledArcPath} style={{ stroke: accentColour }} />
      <TickMark centre={centre} radiusPx={gaugeRadiusPx} angleDeg={startAngleDeg} />
      <TickMark centre={centre} radiusPx={gaugeRadiusPx} angleDeg={(startAngleDeg + endAngleDeg) / 2} />
      <TickMark centre={centre} radiusPx={gaugeRadiusPx} angleDeg={endAngleDeg} />
      <line
        className="fowt-gauge-needle"
        x1={centre.x}
        y1={centre.y}
        x2={needleTip.x}
        y2={needleTip.y}
        style={{ stroke: accentColour }}
      />
      <circle className="fowt-gauge-centre" cx={centre.x} cy={centre.y} r="4.8" style={{ fill: accentColour }} />
      <text className="fowt-gauge-value" x={centre.x} y={centre.y + 24} textAnchor="middle">
        {`${formatNumber(clampedPitchDeg, 1)}°`}
      </text>
    </g>
  );
}

function TickMark(props: {
  centre: Point;
  radiusPx: number;
  angleDeg: number;
  className?: string;
}) {
  const { centre, radiusPx, angleDeg, className } = props;
  const outer = pointOnCircle(centre, radiusPx + 1.5, angleDeg);
  const inner = pointOnCircle(centre, radiusPx - 7.5, angleDeg);

  return (
    <line
      className={`fowt-gauge-tick${className === undefined ? "" : ` ${className}`}`}
      x1={outer.x}
      y1={outer.y}
      x2={inner.x}
      y2={inner.y}
    />
  );
}

function createArcPath(
  centre: Point,
  radiusPx: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const start = pointOnCircle(centre, radiusPx, startAngleDeg);
  const end = pointOnCircle(centre, radiusPx, endAngleDeg);
  const deltaDeg = Math.abs(endAngleDeg - startAngleDeg);
  const largeArc = deltaDeg > 180 ? 1 : 0;
  const sweep = endAngleDeg > startAngleDeg ? 1 : 0;

  return `M ${round(start.x)} ${round(start.y)} A ${radiusPx} ${radiusPx} 0 ${largeArc} ${sweep} ${round(end.x)} ${round(end.y)}`;
}

function pointOnCircle(centre: Point, radiusPx: number, angleDeg: number): Point {
  const angleRad = angleDeg / RAD_TO_DEG;
  return {
    x: centre.x + radiusPx * Math.cos(angleRad),
    y: centre.y + radiusPx * Math.sin(angleRad),
  };
}

function InSvgReadouts(props: { sample: SimulationScenarioSample | undefined }) {
  const { sample } = props;

  return (
    <g className="fowt-inline-readouts" aria-hidden="true">
      <g className="fowt-platform-pitch-readout" transform="translate(585 236)">
        <rect width="190" height="56" rx="10" />
        <text className="fowt-inline-readout-label" x="14" y="22">Platform pitch</text>
        <text className="fowt-inline-readout-value" x="14" y="42">
          {sample === undefined ? "--" : `${formatNumber(sample.platformPitchRad * RAD_TO_DEG, 2)} deg`}
        </text>
      </g>
    </g>
  );
}

function RotorSpeedGauge(props: {
  sample: SimulationScenarioSample | undefined;
  centre: Point;
}) {
  const { sample, centre } = props;
  const ratedRotorSpeedRpm = 7.55;
  const minRotorSpeedRpm = 5.0;
  const maxRotorSpeedRpm = 10.0;
  const currentRotorSpeedRpm = sample === undefined
    ? ratedRotorSpeedRpm
    : sample.rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM;
  const clampedRotorSpeedRpm = clamp(currentRotorSpeedRpm, minRotorSpeedRpm, maxRotorSpeedRpm);
  const speedFraction = (clampedRotorSpeedRpm - minRotorSpeedRpm) / (maxRotorSpeedRpm - minRotorSpeedRpm);
  const ratedFraction = (ratedRotorSpeedRpm - minRotorSpeedRpm) / (maxRotorSpeedRpm - minRotorSpeedRpm);
  const startAngleDeg = 210;
  const endAngleDeg = -30;
  const gaugeRadiusPx = 42;
  const needleLengthPx = 33;
  const needleAngleDeg = startAngleDeg + speedFraction * (endAngleDeg - startAngleDeg);
  const ratedAngleDeg = startAngleDeg + ratedFraction * (endAngleDeg - startAngleDeg);
  const outerArcPath = createArcPath(centre, gaugeRadiusPx, startAngleDeg, endAngleDeg);
  const filledArcPath = createArcPath(centre, gaugeRadiusPx, startAngleDeg, needleAngleDeg);
  const needleTip = pointOnCircle(centre, needleLengthPx, needleAngleDeg);
  const gaugeColour = getRotorSpeedGaugeColour(currentRotorSpeedRpm, ratedRotorSpeedRpm);

  return (
    <g className="fowt-rotor-speed-gauge" aria-hidden="true">
      <text className="fowt-gauge-label" x={centre.x} y={centre.y - 40} textAnchor="middle">Rotor Speed</text>
      <path className="fowt-gauge-ring" d={outerArcPath} />
      <path className="fowt-gauge-fill" d={filledArcPath} style={{ stroke: gaugeColour }} />
      <TickMark centre={centre} radiusPx={gaugeRadiusPx} angleDeg={startAngleDeg} />
      <TickMark centre={centre} radiusPx={gaugeRadiusPx} angleDeg={(startAngleDeg + endAngleDeg) / 2} />
      <TickMark centre={centre} radiusPx={gaugeRadiusPx} angleDeg={endAngleDeg} />
      <TickMark centre={centre} radiusPx={gaugeRadiusPx} angleDeg={ratedAngleDeg} className="fowt-gauge-target-tick" />
      <line
        className="fowt-gauge-needle"
        x1={centre.x}
        y1={centre.y}
        x2={needleTip.x}
        y2={needleTip.y}
        style={{ stroke: gaugeColour }}
      />
      <circle className="fowt-gauge-centre" cx={centre.x} cy={centre.y} r="5.8" style={{ fill: gaugeColour }} />
      <text className="fowt-rpm-gauge-value" x={centre.x} y={centre.y + 65} textAnchor="middle">
        {sample === undefined ? "-- rpm" : `${formatNumber(currentRotorSpeedRpm, 2)} RPM`}
      </text>
    </g>
  );
}

function Anchor(props: { point: Point }) {
  const { point } = props;
  return (
    <g transform={`translate(${point.x} ${point.y})`}>
      <path d="M -17 0 L 17 0 L 9 14 L -9 14 Z" />
      <circle cx="0" cy="0" r="4.5" />
    </g>
  );
}

function SchematicReadouts(props: {
  sample: SimulationScenarioSample | undefined;
  history: SimulationScenarioSample[];
}) {
  const { sample, history } = props;

  const readouts = [
    createReadout(
      "Wind",
      sample === undefined ? undefined : sample.windSpeedMps,
      history,
      (entry) => entry.windSpeedMps,
      "m/s",
      2,
    ),
    createReadout(
      "Rotor speed",
      sample === undefined ? undefined : sample.rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM,
      history,
      (entry) => entry.rotorSpeedRadPerSec * RAD_PER_SEC_TO_RPM,
      "rpm",
      2,
    ),
    createReadout(
      "Collective pitch",
      sample === undefined ? undefined : sample.collectivePitchRad * RAD_TO_DEG,
      history,
      (entry) => entry.collectivePitchRad * RAD_TO_DEG,
      "deg",
      2,
    ),
    createReadout(
      "Platform pitch",
      sample === undefined ? undefined : sample.platformPitchRad * RAD_TO_DEG,
      history,
      (entry) => entry.platformPitchRad * RAD_TO_DEG,
      "deg",
      2,
    ),
    createReadout(
      "Power",
      sample === undefined ? undefined : sample.aerodynamicPowerW / 1e6,
      history,
      (entry) => entry.aerodynamicPowerW / 1e6,
      "MW",
      2,
    ),
    createReadout(
      "Thrust",
      sample === undefined ? undefined : sample.thrustN / 1e6,
      history,
      (entry) => entry.thrustN / 1e6,
      "MN",
      3,
    ),
  ];

  return (
    <dl className="schematic-readouts">
      {readouts.map((readout) => (
        <div className="schematic-readout-card" key={readout.label}>
          <dt>{readout.label}</dt>
          <dd>
            <strong>{readout.value}</strong>
            <small>30 s std {readout.standardDeviation}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function createReadout(
  label: string,
  instantaneousValue: number | undefined,
  history: SimulationScenarioSample[],
  pickValue: (sample: SimulationScenarioSample) => number,
  unit: string,
  digits: number,
) {
  const stats = getMovingStats(history, pickValue);

  return {
    label,
    value: instantaneousValue === undefined ? "--" : `${formatNumber(instantaneousValue, digits)} ${unit}`,
    standardDeviation: `${formatNumber(stats.standardDeviation, digits)} ${unit}`,
  };
}

function getMovingStats(
  history: SimulationScenarioSample[],
  pickValue: (sample: SimulationScenarioSample) => number,
): MovingStats {
  const latestSample = history.length === 0 ? undefined : history[history.length - 1];

  if (latestSample === undefined) {
    return { standardDeviation: Number.NaN };
  }

  const minTimeS = latestSample.timeS - SCHEMATIC_MOVING_WINDOW_S;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const candidate = history[i];

    if (candidate.timeS < minTimeS) {
      break;
    }

    const value = pickValue(candidate);

    if (Number.isFinite(value)) {
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }

  if (count === 0) {
    return { standardDeviation: Number.NaN };
  }

  const average = sum / count;
  const variance = Math.max(0, sumSquares / count - average * average);

  return {
    standardDeviation: Math.sqrt(variance),
  };
}

function transformLocalPoint(localPoint: Point, angleRad: number): Point {
  const cosAngle = Math.cos(angleRad);
  const sinAngle = Math.sin(angleRad);

  return {
    x: PITCH_PIVOT.x + localPoint.x * cosAngle - localPoint.y * sinAngle,
    y: PITCH_PIVOT.y + localPoint.x * sinAngle + localPoint.y * cosAngle,
  };
}

function createCatenaryPath(fairlead: Point, anchor: Point): string {
  const direction = anchor.x >= fairlead.x ? 1 : -1;
  const horizontalDistance = Math.abs(anchor.x - fairlead.x);
  const touchdown: Point = {
    x: anchor.x - direction * clamp(0.26 * horizontalDistance, 56, 110),
    y: SEABED_Y - 1.5,
  };

  const control1: Point = {
    x: fairlead.x + direction * clamp(0.16 * horizontalDistance, 28, 62),
    y: fairlead.y + 96,
  };
  const control2: Point = {
    x: touchdown.x - direction * clamp(0.2 * horizontalDistance, 50, 100),
    y: SEABED_Y - 12,
  };

  return `M ${round(fairlead.x)} ${round(fairlead.y)} C ${round(control1.x)} ${round(control1.y)}, ${round(control2.x)} ${round(control2.y)}, ${round(touchdown.x)} ${round(touchdown.y)} L ${round(anchor.x)} ${round(anchor.y)}`;
}

function getCollectivePitchColour(fraction: number): string {
  const t = clamp(fraction, 0, 1);

  if (t < 0.5) {
    return interpolateRgb(
      { r: 37, g: 99, b: 235 },
      { r: 234, g: 179, b: 8 },
      t / 0.5,
    );
  }

  return interpolateRgb(
    { r: 234, g: 179, b: 8 },
    { r: 220, g: 38, b: 38 },
    (t - 0.5) / 0.5,
  );
}

function getRotorSpeedGaugeColour(currentRotorSpeedRpm: number, ratedRotorSpeedRpm: number): string {
  if (!Number.isFinite(currentRotorSpeedRpm)) {
    return "rgb(148, 163, 184)";
  }

  if (currentRotorSpeedRpm >= ratedRotorSpeedRpm) {
    return interpolateRgb(
      { r: 34, g: 197, b: 94 },
      { r: 220, g: 38, b: 38 },
      clamp((currentRotorSpeedRpm - ratedRotorSpeedRpm) / 1.5, 0, 1),
    );
  }

  return interpolateRgb(
    { r: 34, g: 197, b: 94 },
    { r: 234, g: 179, b: 8 },
    clamp((ratedRotorSpeedRpm - currentRotorSpeedRpm) / 1.5, 0, 1),
  );
}

function getWindArrowStyle(windSpeedMps: number | undefined) {
  const fraction = clamp(((windSpeedMps ?? 11) - 11) / 9, 0, 1);
  return {
    length: 120 + 55 * fraction,
    strokeWidth: 8 + 4 * fraction,
    headHalfHeight: 16 + 6 * fraction,
    color: interpolateRgb({ r: 245, g: 177, b: 88 }, { r: 231, g: 111, b: 44 }, fraction),
  };
}

function interpolateRgb(
  start: { r: number; g: number; b: number },
  end: { r: number; g: number; b: number },
  fraction: number,
): string {
  const mix = clamp(fraction, 0, 1);
  const r = Math.round(start.r + (end.r - start.r) * mix);
  const g = Math.round(start.g + (end.g - start.g) * mix);
  const b = Math.round(start.b + (end.b - start.b) * mix);
  return `rgb(${r}, ${g}, ${b})`;
}

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
