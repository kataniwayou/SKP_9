import { useState } from 'react';
import type { Workspace } from '../app/workspace';
import { useWorkspace } from '../app/workspace';
import { arrowRows, CONDITIONS, detailRows, FIELDS, rowOf, savedText, type FieldSpec } from '../molecule/fields';
import { TYPES } from '../molecule/model';
import { PaneNote } from './PaneNote';

/** Where the read-only section's open/closed state is kept (this browser; a convenience, not the session). */
const OPEN_KEY = 'skp.valence.inspector.readonly';
const readOpen = () => { try { return globalThis.localStorage?.getItem(OPEN_KEY) === 'open'; } catch { return false; } };
const writeOpen = (open: boolean) => { try { globalThis.localStorage?.setItem(OPEN_KEY, open ? 'open' : 'closed'); } catch { /* not kept */ } };

/**
 * The Inspector (spec §3c, approved 2026-10-15). Hovering an atom previews it; clicking it pins it, and the pinned atom
 * is edited while nothing is hovered. On top, open: the kind, then every writable field that is not an arrow (the schema's
 * definition is read-only for now). Below, one show/hide "Read-only" section: the details, then the atom's arrows. An
 * edit changes the virtual entity only (decision 8): nothing reaches BaseApi until an apply step exists.
 */
export function Inspector({ workspace }: { workspace: Workspace }) {
  const data = useWorkspace(workspace, (s) => s.data);
  const molecule = useWorkspace(workspace, (s) => s.molecule);
  const hovered = useWorkspace(workspace, (s) => s.hovered);
  const pinned = useWorkspace(workspace, (s) => s.pinned);
  const edits = useWorkspace(workspace, (s) => s.edits);
  const [open, setOpen] = useState(readOpen);

  if (!data || !molecule) return <PaneNote pane="inspector">Reading the project…</PaneNote>;
  const key = hovered ?? pinned;
  if (key === null) return <PaneNote pane="inspector">Nothing selected. Hover an atom to preview it; click it to pin it.</PaneNote>;
  const atom = molecule.atoms.get(key);
  const row = atom ? rowOf(data, atom.type, atom.id) : undefined;
  if (!atom || !row) return <PaneNote pane="inspector">This row is no longer in the project.</PaneNote>;

  const preview = key !== pinned;
  const changed = edits[key] ?? {};
  const dirty = Object.keys(changed).length > 0;
  const toggle = () => { setOpen((o) => { writeOpen(!o); return !o; }); };
  const details = detailRows(molecule, row, key);
  const arrows = arrowRows(molecule, key);

  return (
    <div className="paneBody" data-pane="inspector">
      <div className="ph2 insp-head">
        <span className="kindpill">{TYPES[atom.type].label.toUpperCase()}</span>
        <span className={preview ? 'insp-state' : 'insp-state is-pinned'}>{preview ? 'Preview · click the atom to pin it' : 'Pinned'}</span>
      </div>
      <div className="pbody">
        {dirty && !preview && (
          <div className="insp-virtual">
            <span>● Changed in Valence only, not applied</span>
            <button type="button" className="link" onClick={() => workspace.revert(key)}>Revert</button>
          </div>
        )}
        <section className="sec" aria-label="Writable">
          {FIELDS[atom.type].map((spec) => {
            const saved = savedText(row, spec);
            const value = changed[spec.key] ?? saved;
            return (
              <Field key={`${key}:${spec.key}`} id={`insp-${spec.key}`} spec={spec} value={value} edited={spec.key in changed}
                locked={preview ? 'Click the atom to pin it, then edit' : spec.readOnly}
                onChange={(text) => workspace.edit(key, spec.key, text, saved)} />
            );
          })}
        </section>
        <section className="sec">
          <button type="button" className="sec-title insp-toggle" aria-expanded={open} onClick={toggle}>
            <span>{open ? '▾' : '▸'} Read-only</span>
          </button>
          {open && (
            <div className="insp-ro">
              {details.map((d) => (
                <div key={d.label} className="field"><label>{d.label}</label><span className="ro insp-wrap">{d.value}</span></div>
              ))}
              <div className="insp-divider">arrows</div>
              {arrows.length === 0 && <div className="note">No arrows leave it.</div>}
              {arrows.map((a, i) => (
                <div key={i} className="field"><label>{a.label}</label><span className="ro">→ {a.target}</span></div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** One writable field: its editor, BaseApi's rule for it as a note while typing, and a mark once it is edited. */
function Field({ id, spec, value, edited, locked, onChange }: {
  id: string; spec: FieldSpec; value: string; edited: boolean; locked?: string; onChange: (text: string) => void;
}) {
  const problem = locked ? null : spec.check(value);
  const common = {
    id, value, readOnly: !!locked, title: locked, spellCheck: false,
    className: spec.kind === 'json' ? 'input json' : 'input',
    'aria-invalid': problem !== null ? true : undefined,
  };
  let control;
  switch (spec.kind) {
    case 'text': control = <input {...common} type="text" onChange={(e) => onChange(e.target.value)} />; break;
    case 'multiline': control = <textarea {...common} rows={2} onChange={(e) => onChange(e.target.value)} />; break;
    case 'json': control = <textarea {...common} rows={8} onChange={(e) => onChange(e.target.value)} />; break;
    case 'condition':
      control = (
        <select {...common} disabled={!!locked} onChange={(e) => onChange(e.target.value)}>
          {CONDITIONS.map((c) => <option key={c.value} value={String(c.value)}>{c.label}</option>)}
        </select>
      );
      break;
  }
  return (
    <div className={spec.kind === 'json' || spec.kind === 'multiline' ? 'field tall' : 'field'}>
      <label htmlFor={id} className={edited ? 'insp-edited' : undefined}>{spec.label}</label>
      <div className="fval">
        {control}
        {spec.readOnly && <div className="fhint">{spec.readOnly}</div>}
        {problem && <div className="ferr">{problem}</div>}
      </div>
    </div>
  );
}
