import { useId, useLayoutEffect, useRef } from 'react';
import { ConditionPicker } from './ConditionPicker';
import { DictEditor } from './DictEditor';
import { jsonProblem, type FieldSpec } from '../store/entityForms';

/** A multi-line field opens as tall as its whole text (two lines at least), up to this share of the window, then scrolls. */
const MAX_FIELD_HEIGHT = 0.4;

/** Sizes a textarea to its content: on mount, whenever its text changes (a new entity shown included). */
function useFitToText(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, active: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    el.style.height = 'auto';
    const content = el.scrollHeight + (el.offsetHeight - el.clientHeight); // scrollHeight leaves the borders out
    if (content <= 0) return; // no layout (jsdom): keep the rows
    const cap = window.innerHeight * MAX_FIELD_HEIGHT;
    el.style.height = `${Math.max(el.offsetHeight, Math.min(content, cap))}px`;
    el.style.overflowY = content > cap ? 'auto' : 'hidden';
  }, [ref, value, active]);
}

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
  const area = useRef<HTMLTextAreaElement>(null);
  useFitToText(area, value, spec.kind === 'multiline');
  // a dictionary is a table of its own (2026-10-10)
  if (spec.kind === 'dict') return <DictEditor spec={spec} value={value} errors={errors} onChange={onChange} />;
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
      control = <textarea {...common} ref={area} rows={2} value={value} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'json':
      control = <textarea {...common} rows={6} value={value} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'condition':
      control = <ConditionPicker id={id} value={value} invalid={common['aria-invalid']} onChange={onChange} />;
      break;
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
