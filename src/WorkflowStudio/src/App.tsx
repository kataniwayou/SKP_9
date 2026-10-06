import { useEffect, useMemo, useState } from 'react';
import { createApi, type ApiError, type StudioApi } from './api/client';
import type { WorkflowReadDto } from './api/types';
import type { StudioDocument } from './app/document';
import { loadDocument } from './app/loadDocument';
import { canvasMeasure, createTextFitter, loadMeasuredFonts, type TextFitter } from './canvas/fitText';
import { SvgDefs } from './canvas/SvgDefs';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';

function describe(error: ApiError): string {
  switch (error.kind) {
    case 'notFound': return 'Not found.';
    case 'network': return `Network error: ${error.message}`;
    default: return error.status === 0 ? error.detail : `${error.status}: ${error.detail}`;
  }
}

const workflowFromUrl = () => new URLSearchParams(window.location.search).get('workflow');

/**
 * The slice-2 page: a picker, a status line and the canvas. The open workflow is in the URL
 * (`?workflow=<id>`), so a reload or a shared link reopens it. The dock arrives in plan 5.
 */
export function App({ api: injected }: { api?: StudioApi }) {
  const api = useMemo(() => injected ?? createApi(), [injected]);
  const [workflows, setWorkflows] = useState<WorkflowReadDto[]>([]);
  const [selected, setSelected] = useState<string | null>(workflowFromUrl);
  const [doc, setDoc] = useState<StudioDocument | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  const [fitter, setFitter] = useState<TextFitter | null>(null);

  // Labels are measured with the real fonts, so the fitter is made once the fonts have loaded.
  useEffect(() => {
    let live = true;
    void loadMeasuredFonts().then(() => { if (live) setFitter(createTextFitter(canvasMeasure())); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    void api.listWorkflows().then((r) => {
      if (r.ok) setWorkflows([...r.value].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')));
      else setStatus({ text: describe(r.error), error: true });
    });
  }, [api]);

  useEffect(() => {
    if (!selected) { setDoc(null); return; }
    let live = true;
    setStatus({ text: 'Loading…', error: false });
    void loadDocument(api, selected).then((r) => {
      if (!live) return;
      if (r.ok) { setDoc(r.value); setStatus({ text: r.value.problems === null ? 'Problems unavailable.' : '', error: false }); }
      else { setDoc(null); setStatus({ text: describe(r.error), error: true }); }
    });
    return () => { live = false; };
  }, [api, selected]);

  const open = (id: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('workflow', id); else url.searchParams.delete('workflow');
    window.history.replaceState(null, '', url);
    setSelected(id || null);
  };

  return (
    <div className="app">
      <SvgDefs />
      <header className="app-bar">
        <h1>SKP STUDIO</h1>
        <select aria-label="Workflow" value={selected ?? ''} onChange={(e) => open(e.target.value)}>
          <option value="">Open a workflow…</option>
          {workflows.map((w) => <option key={w.id} value={w.id ?? ''}>{`${w.name} ${w.version}`}</option>)}
        </select>
        <span role="status" className={status.error ? 'app-status error' : 'app-status'}>{status.text}</span>
      </header>
      <main className="app-main">
        {doc && fitter ? <WorkflowCanvas doc={doc} fitter={fitter} /> : <div className="app-empty">{selected ? '' : 'Pick a workflow to open it.'}</div>}
      </main>
    </div>
  );
}
