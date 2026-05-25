interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function SliderRow(props: SliderRowProps) {
  const { label, value, min, max, step, unit, disabled, onChange } = props;

  return (
    <label className={`slider-row${disabled ? " is-disabled" : ""}`}>
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
      <span className="slider-value">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={formatInputValue(value, step)}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        />
        {unit !== undefined ? <span>{unit}</span> : null}
      </span>
    </label>
  );
}

function formatInputValue(value: number, step: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  if (step >= 1) {
    return value.toFixed(0);
  }

  if (step >= 0.01) {
    return value.toFixed(2);
  }

  return value.toFixed(3);
}
