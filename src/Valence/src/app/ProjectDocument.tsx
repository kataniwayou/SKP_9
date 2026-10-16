import { lazy, Suspense, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { readProject, type ProjectResult } from '../api/project';
import { goneArrows } from '../molecule/deletion';
import { editStates } from '../molecule/fields';
import { layoutMolecule, type Vec } from '../molecule/layout';
import { buildMolecule, reachOf, type Molecule } from '../molecule/model';
import { useHighlights, type Highlights } from './highlights';
import { useWorkspace, type Workspace } from './workspace';

// three.js is most of the bundle: it loads with the first molecule, not with the page
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
export function ProjectDocument({ workspace, highlights, read = readProject }: {
  workspace: Workspace; highlights: Highlights; read?: () => Promise<ProjectResult>;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const pinned = useWorkspace(workspace, (s) => s.pinned);
  const removed = useWorkspace(workspace, (s) => s.removed);
  const edits = useWorkspace(workspace, (s) => s.edits);
  // the labels show the virtual entities' names (decision 8)
  const names = useMemo(() => new Map(Object.entries(edits).flatMap(([k, f]) => (f.name !== undefined ? [[k, f.name] as const] : []))), [edits]);
  const events = useMemo(() => ({ hover: workspace.hover, pin: workspace.pin }), [workspace]);
  const [attempt, setAttempt] = useState(0);
  const picked = useHighlights(highlights);
  const lit = useMemo(() => (loaded.kind === 'ready' ? litOf(loaded.molecule, picked) : null), [loaded, picked]);
  // the virtual changes, not applied: deleted ones as red ghosts with every arrow that goes with them; atoms whose edits
  // are finished as amber update ghosts (an unfinished edit is no change yet, so it draws nothing)
  const ghosts = useMemo(() => (loaded.kind === 'ready'
    ? { atoms: new Set(removed.atoms), arrows: goneArrows(loaded.molecule, removed), updated: editStates(loaded.molecule, edits).finished }
    : undefined), [loaded, removed, edits]);

  useEffect(() => {
    let live = true;
    setLoaded({ kind: 'loading' });
    void read().then((r) => {
      if (!live) return;
      if (!r.ok) { setLoaded({ kind: 'failed', message: r.message }); return; }
      const molecule = buildMolecule(r.data);
      workspace.loaded(r.data, molecule);
      setLoaded({ kind: 'ready', molecule, positions: layoutMolecule(molecule) });
    });
    return () => { live = false; };
  }, [read, attempt, workspace]);

  // The canvas's keys, while it has focus (SKP Studio's, design/useDesignKeys.ts): Delete deletes the pinned atom or
  // arrow under the rules (spec §6); Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo, through edits and deletions alike.
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as Element).closest?.('input, textarea, select, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') { e.preventDefault(); if (e.shiftKey) workspace.redo(); else workspace.undo(); return; }
    if (mod && !e.altKey && key === 'y') { e.preventDefault(); workspace.redo(); return; }
    if (e.key === 'Delete' && !mod && !e.altKey) {
      e.preventDefault();
      workspace.remove(workspace.get().pinned);
    }
  };

  return (
    <div className="docpanel" onKeyDown={onKeyDown}>
      <div className="vcanvas" />
      {loaded.kind === 'ready' && (
        <Suspense fallback={<div className="doc-msg">Loading…</div>}>
          <MoleculeView molecule={loaded.molecule} positions={loaded.positions} highlighted={lit} pinned={pinned} names={names} events={events} ghosts={ghosts} />
        </Suspense>
      )}
      {loaded.kind === 'loading' && <div className="doc-msg">Reading the project…</div>}
      {loaded.kind === 'failed' && (
        <div className="doc-msg error" role="alert">{loaded.message}<button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>
      )}
    </div>
  );
}
