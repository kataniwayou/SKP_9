import type { ReactNode } from 'react';

/** A labelled field. Controlled from the store: a refused edit shows the store value again. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="in-row"><span className="in-k">{label}</span><span className="in-v">{children}</span></label>;
}

export function TextField({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string) => void }) {
  return <Field label={label}><input className="in-in" value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>;
}

export function AreaField({ label, value, onChange, rows = 5 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return <Field label={label}><textarea className="in-in" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} /></Field>;
}

export function SelectField({ label, value, options, onChange }: {
  label: string; value: number; options: ReadonlyArray<{ value: number; label: string }>; onChange: (v: number) => void;
}) {
  return (
    <Field label={label}>
      <select className="in-in" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}
