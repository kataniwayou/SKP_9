import { useState } from 'react';
import type { Workspace } from '../app/workspace';
import { useWorkspace } from '../app/workspace';
import { canDeleteArrow, canDeleteAtom, CONSEQUENCE, goneArrows, type Removed, type Verdict } from '../molecule/deletion';
import { arrowRows, detailRows, editStates, rowOf, savedText, type FieldSpec, type Lock } from '../molecule/fields';
import { arrowKey, BOND, isArrowKey, KINDS, TYPES, type Molecule } from '../molecule/model';
import { tableFor } from '../molecule/rules';
import type { AtomVerdict, DryRunState } from '../molecule/verdict';
import { PaneNote } from './PaneNote';

/** Where the read-only section's open/closed state is kept (this browser; a convenience, not the session). */
const OPEN_KEY = 'skp.valence.inspector.readonly';
const readOpen = () => { try { return globalThis.localStorage?.getItem(OPEN_KEY) === 'open'; } catch { return false; } };
const writeOpen = (open: boolean) => { try { globalThis.localStorage?.setItem(OPEN_KEY, open ? 'open' : 'closed'); } catch { /* not kept */ } };

/**
 * The Inspector (spec §3c, approved 2026-10-15). Hovering an atom previews it; clicking it pins it, and the pinned atom
 * is edited while nothing is hovered. On top, open: the kind, then every writable field that is not an arrow (the schema's
 * definition opens only while no processor arrow points at the schema: BaseApi's freeze, judged on the virtual entities). Below, one show/hide "Read-only" section: the details, then the atom's arrows. An
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
  const created = useWorkspace(workspace, (s) => s.created);
  const rules = useWorkspace(workspace, (s) => s.rules);
  const dry = useWorkspace(workspace, (s) => s.dryRun);
  const dryRunWorks = useWorkspace(workspace, (s) => s.dryRunWorks);
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
  const made = created.some((c) => c.key === key);
  const changed = edits[key] ?? {};
  const dirty = Object.keys(changed).length > 0;
  const table = tableFor(rules, dryRunWorks);
  const verdict = dry.kind === 'done' ? dry.byAtom[key] : undefined;
  const refusedByBaseApi = !!verdict && !verdict.ok;
  const states = dirty ? editStates(table, molecule, { [key]: changed }, removed, refusedByBaseApi ? new Set([key]) : undefined) : null;
  const unfinished = !!states?.unfinished.has(key), frozen = !!states?.frozen.has(key);
  // the atom is in the planned changes: edited, deleted, or an arrow leaving it deleted
  const planned = dirty || ghost || molecule.arrows.some((x) => x.from === key && gone.has(arrowKey(x)));
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
        {made && !preview && (() => {
          const missing = table[atom.type].filter((spec) => spec.check(changed[spec.key] ?? savedText(row, spec)) !== null).map((s) => s.label);
          return (
            <div className={missing.length || refusedByBaseApi ? 'insp-virtual made unfinished' : 'insp-virtual made'}>
              <span>{missing.length ? `◐ New in Valence, unfinished: fill in ${missing.join(', ')}` : refusedByBaseApi ? "◐ New in Valence: BaseApi's dry run refuses it" : '● New in Valence only, not applied'}</span>
              <span className="insp-hint">Delete takes it back</span>
            </div>
          );
        })()}
        {(planned || made) && !preview && <DryRunNote state={dry} verdict={verdict} />}
        {!ghost && !preview && <DeleteVerdict verdict={canDeleteAtom(molecule, removed, key)} />}
        {dirty && !made && !preview && !ghost && (
          <div className={unfinished ? 'insp-virtual unfinished' : 'insp-virtual'}>
            <span>{frozen ? '◐ Unfinished edit: the definition is frozen again — a processor uses this schema, so BaseApi would refuse it. Revert it, or delete that arrow again'
              : refusedByBaseApi ? "◐ Unfinished edit: BaseApi's dry run refuses it — not a change, and apply waits, until it passes"
              : unfinished ? '◐ Unfinished edit: fix the marked field — not a change, and apply waits, until then' : '● Changed in Valence only, not applied'}</span>
            <button type="button" className="link" onClick={() => workspace.revert(key)}>Revert</button>
          </div>
        )}
        <section className="sec" aria-label="Writable">
          {table[atom.type].map((spec) => {
            const saved = savedText(row, spec);
            const value = changed[spec.key] ?? saved;
            const rule = spec.lock?.(molecule, removed, key);
            return (
              <Field key={`${key}:${spec.key}`} id={`insp-${spec.key}`} spec={spec} value={value} edited={spec.key in changed} rule={rule}
                remote={preview ? undefined : verdict?.fields[spec.key]}
                locked={ghost ? 'Deleted in Valence: undo the delete to edit' : preview ? 'Click the atom to pin it, then edit' : rule?.locked ? rule.note : undefined}
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

/**
 * BaseApi's dry run for this atom's changes (POST /model/validate): checking, passing, refused (problems that belong to
 * no one field; field problems show under their fields), or not available on this BaseApi.
 */
function DryRunNote({ state, verdict }: { state: DryRunState; verdict?: AtomVerdict }) {
  if (state.kind === 'checking') return <div className="insp-dry checking">BaseApi is checking the changes…</div>;
  if (state.kind === 'unavailable') return <div className="insp-dry off">Not checked by BaseApi: {state.reason}. The rules above still apply.</div>;
  if (state.kind !== 'done' || !verdict) return null;
  if (verdict.ok) return <div className="insp-dry ok">✓ BaseApi's dry run passes this change (nothing was written)</div>;
  return (
    <div className="insp-dry no">
      <b>BaseApi refuses it</b>
      {verdict.other.map((t, i) => <div key={i}>{t}</div>)}
      {verdict.other.length === 0 && <div>See the marked fields.</div>}
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
function Field({ id, spec, value, edited, locked, rule, remote, onChange }: {
  id: string; spec: FieldSpec; value: string; edited: boolean; locked?: string; rule?: Lock;
  /** BaseApi's dry-run problems for this field. */
  remote?: readonly string[];
  onChange: (text: string) => void;
}) {
  const problem = locked && !(edited && rule?.locked) ? null : spec.check(value);
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
    case 'choice':
      control = (
        <select {...common} disabled={!!locked} onChange={(e) => onChange(e.target.value)}>
          {(spec.options ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      );
      break;
  }
  return (
    <div className={spec.kind === 'json' || spec.kind === 'multiline' ? 'field tall' : 'field'}>
      <label htmlFor={id} className={edited ? 'insp-edited' : undefined}>{spec.label}</label>
      <div className="fval">
        {control}
        {rule && <div className={rule.locked ? 'fhint locked' : 'fhint open'}>{rule.note}</div>}
        {problem && <div className="ferr">{problem}</div>}
        {/* the dry run's own words, when the described rules see nothing wrong (a code rule, a key, a service rule) */}
        {!problem && remote?.map((m, i) => <div key={i} className="ferr remote">BaseApi: {m}</div>)}
      </div>
    </div>
  );
}
