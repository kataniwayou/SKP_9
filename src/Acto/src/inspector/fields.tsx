import type { ReactNode } from 'react';
import type { BoardStore } from '../design/boardStore';
import type { EntityKey } from '../design/shared';

/** A labelled field. Controlled from the store: a refused edit shows the store value again. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="in-row"><span className="in-k">{label}</span><span className="in-v">{children}</span></label>;
}

export function TextField({ label, value, onChange, disabled }: { label: string; value: string | null; onChange: (v: string) => void; disabled?: boolean }) {
  return <Field label={label}><input className="in-in" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></Field>;
}

export function AreaField({ label, value, onChange, rows = 5, disabled }: { label: string; value: string; onChange: (v: string) => void; rows?: number; disabled?: boolean }) {
  return <Field label={label}><textarea className="in-in" rows={rows} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></Field>;
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

/** The workflow holding an unsaved change to a shared entity, by name; null when this workflow may change it (`lockedBy`). */
export function lockerName(store: BoardStore, key: EntityKey, workflowId: string): string | null {
  const other = store.lockedBy(key, workflowId);
  return other === null ? null : store.entry(other)?.history.present.fields.name ?? other;
}

export const LockNote = ({ by }: { by: string | null }) => (by === null ? null : <p className="in-note in-lock">{`being changed in ${by}`}</p>);
