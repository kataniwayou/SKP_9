import { useState } from 'react';
import type { Workspace } from '../app/workspace';
import { useWorkspace } from '../app/workspace';
import { canDeleteArrow, canDeleteAtom, CONSEQUENCE, goneArrows, type Removed, type Verdict } from '../molecule/deletion';
import { arrowRows, CONDITIONS, detailRows, FIELDS, rowOf, savedText, type FieldSpec } from '../molecule/fields';
import { arrowKey, BOND, isArrowKey, KINDS, TYPES, type Molecule } from '../molecule/model';
import { PaneNote } from './PaneNote';

/** Where the read-only section's open/closed state is kept (this browser; a convenience, not the session). */
const OPEN_KEY = 'skp.valence.inspector.readonly';
const readOpen = () => { try { return globalThis.localStorage?.getItem(OPEN_KEY) === 'open'; } catch { return false; } };
const writeOpen = (open: boolean) => { try { globalThis.localStorage?.setItem(OPEN_KEY, open ? 'open' : 'closed'); } catch { /* not kept */ } };

/**
 * The Inspector (spec §3c, approved 2026-10-15). Hovering an atom previews it; clicking it pins it, and the pinned atom
 * is edited while nothing is hovered. On top, open: the kind, then every writable field that is not an arrow (the schema's
 * definition is read-only for now). Below, one show/hide "Read-only" section: the details, then the atom's arrows. An
 * edit changes the virtual entity only (decision 8): nothing reaches BaseApi until an apply step exists. A pinned atom
 * says whether Delete may delete it (spec §6); a deleted one is a ghost, read-only until undone. An arrow hovered or
 * pinned shows its two ends, where it is held, whether it can be deleted and what deleting it changes (§6b).
 */
export function Inspector({ workspace }: { workspace: Workspace }) {
  const data = useWorkspace(workspace, (s) => s.data);
  const molecule = useWorkspace(workspace, (s) => s.molecule);
  const hovered = useWorkspace(workspace, (s) => s.hovered);
  const pinned = useWorkspace(workspace, (s) => s.pinned);
  const edits = useWorkspace(workspace, (s) => s.edits);
  const removed = useWorkspace(workspace, (s) => s.removed);
  const [open, setOpen] = useState(readOpen);

  if (!data || !molecule) return <PaneNote pane="inspector">Reading the project…</PaneNote>;
  const key = hovered ?? pinned;
  if (key === null) return <PaneNote pane="inspector">Nothing selected. Hover an atom or arrow to preview it; click it to pin it.</PaneNote>;
  if (isArrowKey(key)) return <ArrowInspector molecule={molecule} removed={removed} arrow={key} preview={key !== pinned} />;
  const atom = molecule.atoms.get(key);
  const row = atom ? rowOf(data, atom.type, atom.id) : undefined;
  if (!atom || !row) return <PaneNote pane="inspector">This row is no longer in the project.</PaneNote>;

  const preview = key !== pinned;
  const ghost = removed.atoms.includes(key);
  const gone = goneArrows(molecule, removed);
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
        {ghost && (
          <div className="insp-virtual ghost">
            <span>● Deleted in Valence only, not applied</span><span className="insp-hint">Ctrl+Z on the canvas undoes it</span>
          </div>
        )}
        {!ghost && !preview && <DeleteVerdict verdict={canDeleteAtom(molecule, removed, key)} />}
        {dirty && !preview && !ghost && (
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
                locked={ghost ? 'Deleted in Valence: undo the delete to edit' : preview ? 'Click the atom to pin it, then edit' : spec.readOnly}
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
              {arrows.map((a) => (
                <div key={a.key} className={gone.has(a.key) ? 'field gone' : 'field'}><label>{a.label}</label><span className="ro">→ {a.target}</span></div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Whether Delete may delete what is pinned, and what goes with it (spec §6). */
function DeleteVerdict({ verdict }: { verdict: Verdict }) {
  if (!verdict.ok) return <div className="insp-delete no"><b>Delete</b> ✗ {verdict.reason}</div>;
  const n = verdict.taking.length;
  const taking = n === 0 ? '' : n === 1 ? ' — the arrow pointing at it goes with it' : ` — the ${n} arrows pointing at it go with it`;
  return <div className="insp-delete ok"><b>Delete</b> ✓ allowed{taking}. Press Delete on the canvas.</div>;
}

/** A hovered or pinned arrow (spec §6b): its two ends, where it is held, whether it can be deleted and what that changes. */
function ArrowInspector({ molecule, removed, arrow, preview }: { molecule: Molecule; removed: Removed; arrow: string; preview: boolean }) {
  const x = molecule.arrows.find((a) => arrowKey(a) === arrow);
  if (!x) return <PaneNote pane="inspector">This arrow is no longer in the project.</PaneNote>;
  const kind = KINDS[x.kind];
  const ghost = goneArrows(molecule, removed).has(arrow);
  const end = (k: string) => { const a = molecule.atoms.get(k); return a ? `${TYPES[a.type].label} ${a.name}` : k; };
  return (
    <div className="paneBody" data-pane="inspector">
      <div className="ph2 insp-head">
        <span className="kindpill">ARROW</span>
        <span className={preview ? 'insp-state' : 'insp-state is-pinned'}>{preview ? 'Preview · click the arrow to pin it' : 'Pinned'}</span>
      </div>
      <div className="pbody">
        {ghost && (
          <div className="insp-virtual ghost">
            <span>● Deleted in Valence only, not applied</span><span className="insp-hint">Ctrl+Z on the canvas undoes it</span>
          </div>
        )}
        {!ghost && !preview && <DeleteVerdict verdict={canDeleteArrow(molecule, removed, arrow)} />}
        <section className="sec" aria-label="Arrow">
          <div className="field"><label>Kind</label><span className="ro">{kind.label}</span></div>
          <div className="field"><label>From</label><span className="ro insp-wrap">{end(x.from)}</span></div>
          <div className="field"><label>To</label><span className="ro insp-wrap">{end(x.to)}</span></div>
          <div className="field"><label>Held in</label><span className="ro insp-wrap">{kind.where}</span></div>
          <div className="field"><label>Bond</label><span className="ro insp-wrap">{BOND[kind.bond].name}: {BOND[kind.bond].note}</span></div>
          <div className="field tall"><label>If deleted</label><span className="ro insp-wrap">{CONSEQUENCE[x.kind]}</span></div>
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
