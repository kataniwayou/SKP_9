import { useState } from 'react';
import { prettyJson, sameJson } from '../model/json';
import { Field } from './fields';

/**
 * A JSON text field: shown one field to a line (Studio's prettyJson) unless the designer is typing in it. What is typed
 * is kept as typed while it says the same as the stored value; typed back to the same JSON in any layout it is no edit
 * (`onChange` is called only for text that is not `sameJson` with the value). An edit the store refused or undid shows
 * the store's value again.
 */
export function JsonField({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft !== null && sameJson(draft, value) ? draft : prettyJson(value);
  const lines = shown.split('\n').length;
  return (
    <Field label={label}>
      <textarea className="in-in json" spellCheck={false} rows={Math.min(18, Math.max(3, lines))} value={shown} disabled={disabled}
        onChange={(e) => { const t = e.target.value; setDraft(t); if (!sameJson(t, value)) onChange(t); }}
        onBlur={() => setDraft(null)} />
    </Field>
  );
}

/** Read-only JSON, laid out as prettyJson. */
export const JsonView = ({ value }: { value: string }) => <pre className="json">{prettyJson(value)}</pre>;
