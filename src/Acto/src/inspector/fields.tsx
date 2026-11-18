import type { ReactNode } from 'react';

/**
 * A labelled field: one row, the label left and the value right (the mock's .f; `tall` tops the label, for JSON and
 * long text). Controlled from the store: a refused edit shows the store value again.
 */
export function Field({ label, children, tall }: { label: string; children: ReactNode; tall?: boolean }) {
  return <label className={tall ? 'fld tall' : 'fld'}><span>{label}</span>{children}</label>;
}

/** Read-outs (the mock's .ro): a list of Rows. */
export const Ro = ({ children }: { children: ReactNode }) => <dl className="ro">{children}</dl>;
/** One read-out: its term, then its value (the next sibling). */
export const Row = ({ k, children, className }: { k: string; children: ReactNode; className?: string }) => <><dt>{k}</dt><dd className={className}>{children}</dd></>;
/** A section heading (the mock's .sec). */
export const Sec = ({ children }: { children: ReactNode }) => <div className="sec">{children}</div>;

export function TextField({ label, value, onChange, disabled }: { label: string; value: string | null; onChange: (v: string) => void; disabled?: boolean }) {
  return <Field label={label}><input className="in-in" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></Field>;
}

export function AreaField({ label, value, onChange, rows = 5, disabled }: { label: string; value: string; onChange: (v: string) => void; rows?: number; disabled?: boolean }) {
  return <Field label={label} tall><textarea className="in-in" rows={rows} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></Field>;
}

export function SelectField({ label, value, options, onChange, disabled }: {
  label: string; value: number; options: ReadonlyArray<{ value: number; label: string }>; onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <select className="in-in" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}
