import { useEffect, useMemo, useRef, useState } from 'react';
import { createHighlights } from './app/highlights';
import { browserTabStorage, createSaver, readTabSession, SESSION_VERSION, writeTabSession } from './app/session';
import { ProjectDocument, PROJECT_ID, PROJECT_NAME } from './app/ProjectDocument';
import { WorkflowFilter } from './app/WorkflowFilter';
import { DockShell, type DockDocument } from './dock/DockShell';
import type { ToolId } from './dock/ids';
import { browserStorage, type SavedLayout } from './dock/layoutPersistence';
import { Inspector } from './panels/Inspector';
import { Output, Toolbox } from './panels/Panes';
import { createWorkspace, useWorkspace } from './app/workspace';

/** The one document: the whole project, always open (spec §2.3); its tab is marked while edits are not applied. */
const documentOf = (dirty: boolean): DockDocument[] => [{ id: PROJECT_ID, name: PROJECT_NAME, version: '', tooltip: 'Every row of the project, as one molecule', pinned: true, dirty }];

export interface AppProps {
  /** The browser's storage: the saved window layout, and the session's mirror. Default: localStorage. */
  storage?: Storage | null;
  /** This tab's storage, where its session lives. Default: sessionStorage. */
  tabStorage?: Storage | null;
}

/**
 * SKP Valence (spec §2): SKP Studio's dock and theme around one pinned document, the whole project. Nothing is loaded
 * and nothing is closed; a refresh keeps the dock, the pinned atom and the unapplied edits (the session, as SKP Studio
 * keeps its).
 */
export function App({ storage, tabStorage }: AppProps) {
  const resolved = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage]);
  const tab = useMemo(() => (tabStorage === undefined ? browserTabStorage() : tabStorage), [tabStorage]);
  // the session is read once: the page starts from what it was left as
  const session = useMemo(() => readTabSession(tab, resolved), []);
  // the workflow filter (the main menu strip, 2026-10-16): the session keeps the picked workflows
  const highlights = useMemo(() => createHighlights(session?.highlighted ?? []), []);
  const workspace = useMemo(() => createWorkspace({ pinned: session?.pinned ?? null, edits: session?.edits ?? {}, removed: session?.removed, history: session?.history, created: session?.created, added: session?.added }), []);
  const pinned = useWorkspace(workspace, (s) => s.pinned);
  const dirty = useWorkspace(workspace, (s) => Object.keys(s.edits).length > 0 || s.removed.atoms.length > 0 || s.removed.arrows.length > 0);
  const documents = useMemo(() => documentOf(dirty), [dirty]);
  const [notice, setNotice] = useState<{ id: number; text: string } | undefined>(undefined);

  const dockState = useRef<SavedLayout | null>(session?.dock ?? null);
  const refused = useRef(false);
  const saver = useMemo(() => createSaver(() => {
    const { pinned: pin, edits, removed, history, created, added } = workspace.get();
    const kept = writeTabSession(tab, resolved, { version: SESSION_VERSION, dock: dockState.current, highlighted: [...highlights.get()], pinned: pin, edits: { ...edits }, removed, history, created: [...created], added: [...added] });
    if (!kept && !refused.current) setNotice((n) => ({ id: (n?.id ?? 0) + 1, text: 'This browser would not keep the session: a refresh may lose the layout' }));
    refused.current = !kept;
  }), [tab, resolved]);
  // each change of the highlighted workflows is kept, as the dock's are
  useEffect(() => highlights.subscribe(() => saver.schedule()), [highlights, saver]);
  // the pin, the edits, the deletions and their history too (a refresh keeps them); hovering changes none, so it writes nothing
  useEffect(() => {
    let last = workspace.get();
    return workspace.subscribe(() => { const now = workspace.get(); if (now.pinned !== last.pinned || now.edits !== last.edits || now.removed !== last.removed || now.history !== last.history || now.created !== last.created || now.added !== last.added) saver.schedule(); last = now; });
  }, [workspace, saver]);
  const renderTool = (id: ToolId) => {
    switch (id) {
      case 'inspector': return <Inspector workspace={workspace} />;
      case 'output': return <Output workspace={workspace} />;
      case 'toolbox': return <Toolbox workspace={workspace} />;
    }
  };
  useEffect(() => {
    const flush = () => saver.flush();
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); saver.flush(); };
  }, [saver]);

  return (
    <DockShell
      documents={documents}
      activeDocumentId={PROJECT_ID}
      notice={notice}
      status={<WorkflowFilter workspace={workspace} highlights={highlights} />}
      onActivateDocument={() => {}}
      onCloseDocument={() => {}}
      onOpenWorkflow={() => {}}
      renderDocument={() => <ProjectDocument workspace={workspace} highlights={highlights} />}
      renderTool={renderTool}
      inspectorKey={pinned ?? ''}
      onEscape={() => {}}
      storage={resolved}
      restore={session?.dock ?? null}
      onLayoutChange={(dock) => { dockState.current = dock; saver.schedule(); }}
    />
  );
}
