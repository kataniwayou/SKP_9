import { useId } from 'react';
import { CONDITIONS, conditionInfo } from '../model/entryConditions';
import { jsonProblem, type FieldSpec } from '../store/entityForms';

/**
 * One writable field (spec §7.1). Free text: the server judges it; the browser only marks JSON that
 * does not parse and shows the saved Name or Version as the placeholder of a cleared one.
 */
export function FieldEditor({ spec, value, saved, errors, onChange }: {
  spec: FieldSpec;
  value: string;
  saved: string;
  errors: readonly string[];
  onChange: (text: string) => void;
}) {
  const id = useId();
  const json = spec.kind === 'json' ? jsonProblem(value) : null;
  const common = {
    id,
    className: spec.kind === 'json' ? 'input json' : 'input',
    'aria-invalid': errors.length > 0 || json !== null ? true : undefined,
    spellCheck: false,
  };
  let control;
  switch (spec.kind) {
    case 'text':
      control = <input {...common} type="text" value={value} placeholder={spec.required ? saved : undefined} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'multiline':
      control = <textarea {...common} rows={2} value={value} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'json':
      control = <textarea {...common} rows={6} value={value} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'condition': {
      const known = CONDITIONS.some((c) => String(c.value) === value);
      control = (
        <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          {!known && <option value={value} disabled>{`${conditionInfo(Number(value)).letter} · Invalid (${value})`}</option>}
          {CONDITIONS.map((c) => <option key={c.value} value={String(c.value)}>{`${c.letter} · ${c.name}`}</option>)}
        </select>
      );
      break;
    }
  }
  return (
    <div className={spec.kind === 'json' || spec.kind === 'multiline' ? 'field tall' : 'field'}>
      <label htmlFor={id}>{spec.label}</label>
      <div className="fval">
        {control}
        {json !== null && <div className="fnote">{json}</div>}
        {errors.map((message, i) => <div key={i} className="ferr">{message}</div>)}
      </div>
    </div>
  );
}
