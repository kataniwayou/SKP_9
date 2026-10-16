import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { readProject, type ProjectResult } from '../api/project';
import { layoutMolecule, type Vec } from '../molecule/layout';
import { buildMolecule, type Molecule } from '../molecule/model';
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

/**
 * The whole-project document (spec §2): the molecule of every row BaseApi holds, on SKP Studio's document ground. No
 * toolbar on the canvas (the user, 2026-10-15): the workflow multi-select is off it, and nothing is highlighted, until
 * its new place is chosen.
 */
export function ProjectDocument({ workspace, read = readProject }: { workspace: Workspace; read?: () => Promise<ProjectResult> }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const pinned = useWorkspace(workspace, (s) => s.pinned);
  const edits = useWorkspace(workspace, (s) => s.edits);
  // the labels show the virtual entities' names (decision 8)
  const names = useMemo(() => new Map(Object.entries(edits).flatMap(([k, f]) => (f.name !== undefined ? [[k, f.name] as const] : []))), [edits]);
  const events = useMemo(() => ({ hover: workspace.hover, pin: workspace.pin }), [workspace]);
  const [attempt, setAttempt] = useState(0);

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

  return (
    <div className="docpanel">
      <div className="vcanvas" />
      {loaded.kind === 'ready' && (
        <Suspense fallback={<div className="doc-msg">Loading…</div>}>
          <MoleculeView molecule={loaded.molecule} positions={loaded.positions} highlighted={null} pinned={pinned} names={names} events={events} />
        </Suspense>
      )}
      {loaded.kind === 'loading' && <div className="doc-msg">Reading the project…</div>}
      {loaded.kind === 'failed' && (
        <div className="doc-msg error" role="alert">{loaded.message}<button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>
      )}
    </div>
  );
}
