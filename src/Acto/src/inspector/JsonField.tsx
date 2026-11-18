import { useState } from 'react';
import { prettyJson, sameJson } from '../model/json';
import { Field } from './fields';

/**
 * A JSON text field: shown one field to a line (Studio's prettyJson) unless the designer is typing in it; what is typed
 * stays on screen while it says the same as the value. Studio's rule: text that says the same as the `saved` value
 * (BaseAPI's, from the board's base) is written as the saved text itself, so typing back to it in any layout leaves
 * nothing unsaved; other text is written as typed, and only when it does not say the same as the current value. An
 * edit the store refused or undid shows the store's value again.
 */
export function JsonField({ label, value, saved, onChange, disabled }: {
  label: string; value: string; saved?: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft !== null && sameJson(draft, value) ? draft : prettyJson(value);
  const lines = shown.split('\n').length;
  const type = (t: string) => {
    setDraft(t);
    const next = saved !== undefined && sameJson(t, saved) ? saved : t;
    if (next === saved ? next !== value : !sameJson(next, value)) onChange(next);
  };
  return (
    <Field label={label} tall>
      <textarea className="in-in json" spellCheck={false} rows={Math.min(18, Math.max(3, lines))} value={shown} disabled={disabled}
        onChange={(e) => type(e.target.value)} onBlur={() => setDraft(null)} />
    </Field>
  );
}

/** Read-only JSON, laid out as prettyJson, in a labelled row. */
export const JsonView = ({ label, value }: { label: string; value: string }) => (
  <div className="fld tall"><span>{label}</span><pre className="json" aria-label={label}>{prettyJson(value)}</pre></div>
);
