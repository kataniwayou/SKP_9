import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { readFields, type RulesSource } from '../api/fields';
import { readProject, type ProjectResult } from '../api/project';
import { dryRun, type DryRun } from '../api/validate';
import { goneArrows } from '../molecule/deletion';
import { createdStates, editStates } from '../molecule/fields';
import { layoutMolecule, type Vec } from '../molecule/layout';
import { buildMolecule, reachOf, type Molecule } from '../molecule/model';
import { planChanges, type PlannedChange } from '../molecule/plan';
import { tableFor } from '../molecule/rules';
import { dryRunLine, NO_DRY_RUN, verdictOf } from '../molecule/verdict';
import { useHighlights, type Highlights } from './highlights';
import { Placer } from '../panels/Toolbox';
import { applyBridge } from './Apply';
import type { Copied } from './virtual';
import type { CanvasView } from '../molecule/view';
import { useWorkspace, type Workspace } from './workspace';

// three.js is most of the bundle: it loads with the first molecule, not with the page
/** A shortcut's letter: the typed one, or under another keyboard layout (Hebrew types ב for C) the physical key's. */
const keyOf = (e: { key: string; code: string }) => (/^Key[A-Z]$/.test(e.code) && !/^[a-z]$/i.test(e.key) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase());

const MoleculeView = lazy(() => import('../molecule/MoleculeView').then((m) => ({ default: m.MoleculeView })));

/** The one document's id and name: the whole project, always open (spec §2.3). */
export const PROJECT_ID = 'project';
export const PROJECT_NAME = 'Canvas';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; molecule: Molecule; positions: Map<string, Vec> };

/** What the picked workflows reach, together; null (nothing fades) when none of them is in the molecule. */
export function litOf(molecule: Molecule, workflowKeys: readonly string[]): ReadonlySet<string> | null {
  const lit = new Set<string>();
  for (const key of workflowKeys) if (molecule.atoms.get(key)?.type === 'wf') reachOf(molecule, key).forEach((k) => lit.add(k));
  return lit.size > 0 ? lit : null;
}

/**
 * The whole-project document (spec §2): the molecule of every row BaseApi holds, on SKP Studio's document ground. No
 * toolbar on the canvas (the user, 2026-10-15); the workflow filter is on the main menu strip (2026-10-16) and sets the
 * molecule's base state: what the picked workflows reach stays, the rest fades.
 */
export function ProjectDocument({ workspace, highlights, view = null, onView, read = readProject, readRules = readFields, check = dryRun }: {
  workspace: Workspace; highlights: Highlights; read?: () => Promise<ProjectResult>; readRules?: () => Promise<RulesSource>;
  /** The view kept in this browser (the camera and every atom's place), to open on. */
  view?: CanvasView | null;
  /** The view settled (`closing`: the page is closing): to keep in this browser. */
  onView?: (view: CanvasView, closing: boolean) => void;
  check?: (changes: readonly PlannedChange[], fetchFn?: typeof fetch, signal?: AbortSignal) => Promise<DryRun>;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const pinned = useWorkspace(workspace, (s) => s.pinned);
  const removed = useWorkspace(workspace, (s) => s.removed);
  const edits = useWorkspace(workspace, (s) => s.edits);
  const rules = useWorkspace(workspace, (s) => s.rules);
  // the project as Valence shows it: BaseApi's rows with what was made from the Toolbox
  const molecule = useWorkspace(workspace, (s) => s.molecule);
  const created = useWorkspace(workspace, (s) => s.created);
  const createdKeys = useMemo(() => new Set(created.map((c) => c.key)), [created]);
  // made atoms sit where they were dropped; the rest keep the layout of the project as read
  const positions = useMemo(() => {
    if (loaded.kind !== 'ready') return null;
    if (created.length === 0) return loaded.positions;
    const all = new Map(loaded.positions);
    created.forEach((c) => all.set(c.key, c.pos));
    return all;
  }, [loaded, created]);
  const judged = useWorkspace(workspace, (s) => s.dryRun);
  const dryRunWorks = useWorkspace(workspace, (s) => s.dryRunWorks);
  // set when BaseApi answered that it has no dry run: not asked again until the page reloads
  const missing = useRef<string | null>(null);
  // the labels show the virtual entities' names (decision 8)
  const names = useMemo(() => new Map(Object.entries(edits).flatMap(([k, f]) => (f.name !== undefined ? [[k, f.name] as const] : []))), [edits]);
  const events = useMemo(() => ({ hover: workspace.hover, pin: workspace.pin, view: onView }), [workspace, onView]);
  const [attempt, setAttempt] = useState(0);
  const picked = useHighlights(highlights);
  const lit = useMemo(() => (loaded.kind === 'ready' && molecule ? litOf(molecule, picked) : null), [loaded, molecule, picked]);
  // the virtual changes, not applied: deleted ones as red ghosts with every arrow that goes with them; atoms whose edits
  // are finished as amber update ghosts (an unfinished edit — or one BaseApi's dry run refused — is no change yet, so it
  // draws nothing)
  const ghosts = useMemo(() => {
    const data = workspace.get().data;
    if (loaded.kind !== 'ready' || !molecule || !data) return undefined;
    const refused = new Set(judged.kind === 'done' ? Object.entries(judged.byAtom).filter(([, v]) => !v.ok).map(([k]) => k) : []);
    const table = tableFor(rules, dryRunWorks);
    const plainEdits = Object.fromEntries(Object.entries(edits).filter(([k]) => !createdKeys.has(k)));
    const updated = new Set(editStates(table, molecule, plainEdits, removed, refused).finished);
    // a drawn arrow updates its tail's row (the user, 2026-10-17: a drop in the right place halos), so the tail breathes
    // amber like an edited atom; a made tail is green already, a refused or deleted one is no update
    const made = createdStates(table, data, molecule, edits, createdKeys, refused);
    for (const key of workspace.get().added) {
      const [, tail, head] = key.split('|') as [string, string, string];
      if (createdKeys.has(tail) || removed.atoms.includes(tail)) continue;
      // an arrow to a made atom that does not pass yet is refused as a missing foreign key: that is the head's fault (it
      // has its own note), not the tail's, so the tail still halos — any other refusal of the tail is its own
      const v = judged.kind === 'done' ? judged.byAtom[tail] : undefined;
      const headsFault = !!v && createdKeys.has(head) && !made.finished.has(head)
        && Object.keys(v.fields).length === 0 && v.other.length > 0 && v.other.every((m) => /foreign key/i.test(m));
      if (!refused.has(tail) || headsFault) updated.add(tail);
    }
    return { atoms: new Set(removed.atoms), arrows: goneArrows(molecule, removed), updated, created: made.finished, making: made.unfinished };
  }, [loaded, molecule, removed, edits, rules, judged, dryRunWorks, createdKeys, workspace]);

  // BaseApi's dry run of the virtual changes (POST /model/validate), shortly after they settle: every rule BaseApi has,
  // its services' and the database's included, judges them as the apply would — and nothing is written
  useEffect(() => {
    if (loaded.kind !== 'ready' || !molecule) return;
    const data = workspace.get().data;
    if (!data) return;
    const planned = planChanges(data, molecule, edits, removed, rules.fields, createdKeys, workspace.get().added);
    if (planned.length === 0) { workspace.judged(NO_DRY_RUN); return; }
    if (missing.current) { workspace.judged({ kind: 'unavailable', reason: missing.current }); return; } // already said at load
    const abort = new AbortController();
    // the last answer was about other changes: it goes at once, not when the next one arrives
    workspace.judged({ kind: 'checking', planned: planned.length });
    const timer = setTimeout(() => {
      check(planned, fetch, abort.signal).then((run) => {
        if (run.kind === 'unavailable' && run.missing) missing.current = run.reason;
        const state = verdictOf(planned, run, rules.fields);
        workspace.judged(state, dryRunLine(state, planned, (a) => molecule.atoms.get(a)?.name ?? a));
      }).catch(() => { /* superseded by a newer change */ });
    }, 600);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [loaded, molecule, createdKeys, edits, removed, rules, workspace, check]); // `added` changes `molecule` too

  useEffect(() => {
    let live = true;
    setLoaded({ kind: 'loading' });
    // the rules come from BaseApi with the rows (decision 5); until then, and on an older BaseApi, the snapshot
    void readRules().then((source) => { if (live) workspace.rulesLoaded(source); });
    // does this BaseApi have the dry run? An empty one says so before the first edit: then the code rules are BaseApi's
    // alone from the start, with no stand-in showing first
    void check([]).then((run) => {
      if (run.kind === 'unavailable' && run.missing) missing.current = run.reason;
      if (!live || workspace.get().dryRun.kind !== 'idle') return;
      // said once, here: a BaseApi without the dry run stays without it until the page reloads
      if (run.kind === 'done') workspace.judged({ kind: 'idle' }, null, true);
      else workspace.judged({ kind: 'unavailable', reason: run.reason }, `Dry run: not available (${run.reason}); edits are checked by the rules alone.`, false);
    }).catch(() => { /* superseded */ });
    void read().then((r) => {
      if (!live) return;
      if (!r.ok) { setLoaded({ kind: 'failed', message: r.message }); return; }
      const molecule = buildMolecule(r.data);
      workspace.loaded(r.data, molecule);
      setLoaded({ kind: 'ready', molecule, positions: layoutMolecule(molecule) });
    });
    return () => { live = false; };
  }, [read, readRules, check, attempt, workspace]);

  // After an apply (approved 2026-10-17): the project as BaseApi now holds it, read without the loading state, so the
  // canvas stays as it stands — the camera, every atom's place, the made atoms' places under their real ids
  useEffect(() => {
    applyBridge.reload = async (rename, line) => {
      const r = await read();
      if (!r.ok) {
        workspace.applied(null, null, rename, `${line} The project could not be read again (${r.message}): reading it afresh.`);
        setAttempt((a) => a + 1);
        return;
      }
      const molecule = buildMolecule(r.data);
      setLoaded({ kind: 'ready', molecule, positions: layoutMolecule(molecule) });
      workspace.applied(r.data, molecule, rename, line);
    };
    return () => { applyBridge.reload = null; };
  }, [read, workspace]);

  // The canvas's keys, while it has focus (SKP Studio's, design/useDesignKeys.ts): Delete deletes the pinned atom or
  // arrow under the rules (spec §6); Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo, through edits and deletions alike.
  const [pasting, setPasting] = useState<Copied | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // Copy/paste (the user, 2026-10-17) answer wherever the focus is — the canvas, the Project list, the Toolbox — except in
  // a text field or over selected text, where Ctrl+C and Ctrl+V are the browser's: Ctrl+C copies the pinned atom; Ctrl+V
  // puts its copy on the pointer, to drop.
  useEffect(() => {
    const win = window;
    const track = (e: PointerEvent) => { pointer.current = { x: e.clientX, y: e.clientY }; };
    const keys = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const key = keyOf(e);
      if (key !== 'c' && key !== 'v') return;
      if ((e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (key === 'c' && !(win.getSelection()?.isCollapsed ?? true)) return;
      e.preventDefault();
      if (key === 'c') workspace.copy(workspace.get().pinned);
      else if (workspace.canPaste()) setPasting(workspace.get().clipboard);
    };
    win.addEventListener('pointermove', track);
    win.addEventListener('keydown', keys);
    return () => { win.removeEventListener('pointermove', track); win.removeEventListener('keydown', keys); };
  }, [workspace]);
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as Element).closest?.('input, textarea, select, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = keyOf(e);
    if (mod && !e.altKey && key === 'z') { e.preventDefault(); if (e.shiftKey) workspace.redo(); else workspace.undo(); return; }
    if (mod && !e.altKey && key === 'y') { e.preventDefault(); workspace.redo(); return; }
    if (e.key === 'Delete' && !mod && !e.altKey) {
      e.preventDefault();
      workspace.remove(workspace.get().pinned);
    }
  };

  return (
    <div className="docpanel" onKeyDown={onKeyDown}>
      {pasting && <Placer workspace={workspace} copy={pasting} at={pointer.current} onDone={() => setPasting(null)} />}
      <div className="vcanvas" />
      {loaded.kind === 'ready' && (
        <Suspense fallback={<div className="doc-msg">Loading…</div>}>
          <MoleculeView molecule={molecule ?? loaded.molecule} positions={positions ?? loaded.positions} highlighted={lit} pinned={pinned} names={names} events={events} ghosts={ghosts} view={view} />
        </Suspense>
      )}
      {loaded.kind === 'loading' && <div className="doc-msg">Reading the project…</div>}
      {loaded.kind === 'failed' && (
        <div className="doc-msg error" role="alert">{loaded.message}<button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>
      )}
    </div>
  );
}
