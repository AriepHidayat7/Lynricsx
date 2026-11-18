import type { ReactNode } from "react";

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="row">
      <span className="row-label">
        {label}
        {hint && <span className="row-hint">{hint}</span>}
      </span>
      <span className="row-control">{children}</span>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? "on" : ""}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <span className="slider-wrap">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{format ? format(value) : value}</span>
    </span>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <span className="segmented">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          className={o.value === value ? "active" : ""}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/**
 * Preset / option cards. Bigger than `Segmented`, with a caption line under
 * each label, used for the appearance presets.
 *
 * `swatch` renders a compact row of colour samples (background, chrome, accent)
 * so a preset communicates its palette without a large preview surface.
 */
export function OptionCards<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; caption: string; swatch?: string[] }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="option-cards">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          className={`option-card ${o.value === value ? "active" : ""}`}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          <span className="option-card-head">
            <span className="option-card-label">{o.label}</span>
            <span className="option-card-mark" aria-hidden="true" />
          </span>
          {o.swatch && (
            <span className="option-swatch" aria-hidden="true">
              {o.swatch.map((c, i) => (
                <span key={i} style={{ background: c }} />
              ))}
            </span>
          )}
          <span className="option-card-caption">{o.caption}</span>
        </button>
      ))}
    </div>
  );
}

/** Muted explanatory line inside a section. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="note">{children}</p>;
}
