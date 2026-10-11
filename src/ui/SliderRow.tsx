import { useId, useState } from "react";

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
  const id = useId();
  // Keep incomplete numeric input local. Clearing a field must not silently
  // send NaN (and therefore a minimum/zero gain) to the running worker.
  const [draft, setDraft] = useState<string | undefined>();
  function commit() {
    if (draft !== undefined && draft.trim() !== "" && Number.isFinite(Number(draft))) {
      onChange(Math.min(max, Math.max(min, Number(draft))));
    }
    setDraft(undefined);
  }

  return (
    <div className={`slider-row${disabled ? " is-disabled" : ""}`}>
      <label className="slider-label" htmlFor={id}>{label}</label>
      <input
        type="range"
        aria-label={label + " slider" + (unit ? " (" + unit + ")" : "")}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
      <span className="slider-value">
        <input
          id={id}
          type="number"
          title="Press Enter or leave the field to apply. Escape cancels."
          min={min}
          max={max}
          step={step}
          aria-label={label + (unit ? " (" + unit + ")" : "")}
          value={draft ?? String(value)}
          disabled={disabled}
          onChange={event => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(undefined);
              event.preventDefault();
            }
          }}
        />
        {unit !== undefined ? <span>{unit}</span> : null}
      </span>
    </div>
  );
}
