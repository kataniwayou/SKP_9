import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { describeError } from '../api/describeError';
import type { Health } from '../api/liveness';
import { cacheFromDto, processorFromDto, schemaFromDto } from '../api/toModel';
import { useStudioActionsOrNull } from '../app/studioActions';
import type { TextFitter } from '../canvas/fitText';
import { CacheView } from '../canvas/nodes/CacheNode';
import { ChipView } from '../canvas/nodes/Chip';
import { StepView } from '../canvas/nodes/StepNode';
import { cacheData, processorView, stepLabels } from '../canvas/toFlow';
import { useFitter } from '../canvas/useFitter';
import { newId } from '../design/ids';
import { toolDrag, useToolDrag } from '../design/toolDrag';
import type { ToolItem } from '../design/toolDrop';
import { useHealthOf } from '../live/LiveContext';
import { conditionInfo } from '../model/entryConditions';
import type { Cache, Id, Processor, Schema, Step } from '../model/graph';
import { useStudio, useStudioStore } from '../store/studioStore';

/** What the Toolbox lists (2026-10-11): every processor, cache and schema BaseApi holds, read when it opens and after each Save. */
interface Lists { processors: Processor[]; caches: Cache[]; schemas: Map<Id, Schema> }

const NO_AUDIT = { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null };
/** The empty step tile's step: a new one has this name and no processor (the amber ⚠ slot). */
const EMPTY_STEP: Step = { id: '', name: 'empty step', version: '1.0.0', description: null, processorId: null, nextStepIds: [], entryCondition: 1, updatedAt: '', audit: NO_AUDIT };
const EMPTY_CACHE: Cache = { id: '', name: 'empty cache', version: '1.0.0', description: null, root: 'new root', items: '{}', audit: NO_AUDIT };

/** The empty step as the canvas draws a step with no processor. */
function StepArt({ fitter }: { fitter: TextFitter }) {
  const c = conditionInfo(EMPTY_STEP.entryCondition);
  return (
    <svg className="tb-art tb-step" viewBox="-2 -2 228 164" aria-hidden="true">
      <StepView {...stepLabels(EMPTY_STEP, fitter)} letter={c.letter} colour={c.colour} assignment={null} tip="A new step with no processor"
        fanIn={0} ins={[]} outs={[]} processor={null} health="undetermined" />
    </svg>
  );
}

/** The undecided wire, as the legend and the canvas draw it: grey, dashed, open at both ends. */
function WireArt() {
  return (
    <svg className="tb-art tb-wire" viewBox="0 0 120 40" aria-hidden="true">
      <circle className="lg-ring" cx="10" cy="20" r="4" />
      <path className="lg-undecided" d="M14 20H104" />
      <path className="lg-arrow" d="M96 12L106 20L96 28" />
    </svg>
  );
}

/** A processor as the step's panel draws it, its liveness ring in its health colour. */
function ProcessorArt({ p, schemas, fitter, health }: { p: Processor; schemas: Map<Id, Schema>; fitter: TextFitter; health: Health }) {
  return (
    <svg className="tb-art tb-proc" viewBox="20 52 184 88" aria-hidden="true">
      <ChipView p={processorView(p, { schemas }, fitter)} ins={[40]} outs={[40]} health={health} />
    </svg>
  );
}

/** A cache as the canvas draws it: the honeycomb, its name, version and root. */
function CacheArt({ c, fitter }: { c: Cache; fitter: TextFitter }) {
  return (
    <svg className="tb-art tb-cache" viewBox="-2 -2 164 164" aria-hidden="true">
      <CacheView {...cacheData(c, fitter)} />
    </svg>
  );
}

const matches = (q: string, ...texts: (string | null)[]) => q === '' || texts.some((t) => t !== null && t.toLowerCase().includes(q));

/**
 * The Toolbox (2026-10-11): what can be dragged onto a workflow's canvas. Blocks: an empty step and an undecided wire (each
 * dropped is a new virtual entity, as a paste makes). Processors: every processor BaseApi holds, drawn as a step draws it
 * with its liveness ring (live, from the liveness store); dropped on a step, the step points at it (the same entity).
 * Caches: an empty one (a new virtual cache) and every cache BaseApi holds (dropped, linked to the workflow: the same
 * entity). The drag is the pointer's: a ghost follows it, the canvas under it shows where it lands, Escape cancels.
 */
export function Toolbox() {
  const api = useStudioActionsOrNull()?.api;
  const store = useStudioStore();
  // read again when the pane opens and after every Save that was answered (a document read again)
  const generations = useStudio((s) => s.docs.map((d) => d.generation).join(','));
  const [lists, setLists] = useState<Lists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Document>(document);
  useEffect(() => { if (root.current) setDoc(root.current.ownerDocument); }, []);
  const fitter = useFitter(doc);
  const healthOf = useHealthOf();
  const drag = useToolDrag();

  useEffect(() => {
    if (!api?.listProcessors || !api.listCaches || !api.listSchemas) return undefined;
    let live = true;
    void Promise.all([api.listProcessors(), api.listCaches(), api.listSchemas()]).then(([p, c, s]) => {
      if (!live) return;
      if (!p.ok || !c.ok || !s.ok) {
        setError(describeError((!p.ok ? p.error : !c.ok ? c.error : (s as { ok: false; error: Parameters<typeof describeError>[0] }).error)));
        return;
      }
      setError(null);
      setLists({
        processors: p.value.map(processorFromDto).sort((a, b) => a.name.localeCompare(b.name)),
        caches: c.value.map(cacheFromDto).sort((a, b) => a.name.localeCompare(b.name)),
        schemas: new Map(s.value.map(schemaFromDto).map((x) => [x.id, x])),
      });
    });
    return () => { live = false; };
  }, [api, generations]);

  const needle = q.trim().toLowerCase();
  const processors = useMemo(() => (lists?.processors ?? []).filter((p) => matches(needle, p.name, p.version)), [lists, needle]);
  const caches = useMemo(() => (lists?.caches ?? []).filter((c) => matches(needle, c.name, c.version, c.root)), [lists, needle]);

  /** A press on a tile starts the drag; the window it runs in follows the pointer until it is let go (or Escape). */
  const begin = (item: ToolItem) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const win = e.currentTarget.ownerDocument.defaultView ?? window;
    const isSaving = (id: Id) => store.getState().docs.find((d) => d.workflowId === id)?.saving ?? false;
    toolDrag.start(item, { x: e.clientX, y: e.clientY });
    const move = (ev: PointerEvent) => toolDrag.move(win.document, { x: ev.clientX, y: ev.clientY }, isSaving);
    const stop = () => {
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', cancel);
      win.removeEventListener('keydown', key, true);
    };
    const up = (ev: PointerEvent) => {
      toolDrag.move(win.document, { x: ev.clientX, y: ev.clientY }, isSaving);
      stop();
      const drop = toolDrag.end();
      if (!drop) return;
      store.dispatch({ type: 'activate', workflowId: drop.workflowId });
      store.dispatch({ type: 'toolDrop', workflowId: drop.workflowId, item: drop.item, at: drop.at, newId, roots: (lists?.caches ?? []).map((c) => c.root) });
    };
    const cancel = () => { stop(); toolDrag.cancel(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', cancel);
    win.addEventListener('keydown', key, true);
  };

  const tile = (key: string, item: ToolItem, label: string, art: ReactNode, text: ReactNode) => (
    <div key={key} className="tb-tile" role="button" tabIndex={-1} aria-label={`Drag ${label}`} data-tool={item.kind}
      data-id={item.kind === 'processor' ? item.processor.id : item.kind === 'cache' ? item.cache.id : undefined}
      onPointerDown={begin(item)}>
      {art}
      <div className="tb-text">{text}</div>
    </div>
  );

  const schemasOf = (p: Processor): Schema[] => [p.inputSchemaId, p.outputSchemaId, p.configSchemaId]
    .flatMap((id) => { const s = id ? lists?.schemas.get(id) : undefined; return s ? [s] : []; });
  const ghost = drag && fitter ? ghostArt(drag.item, fitter, lists?.schemas ?? new Map(), healthOf) : null;

  return (
    <div className="paneBody" data-pane="toolbox" ref={root}>
      <div className="tb-search">
        <input type="search" aria-label="Search the toolbox" placeholder="search processors and caches…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="pbody toolbox">
        {!fitter ? <div className="note pane-note">Loading…</div> : (
          <>
            <div className="tb-h">Blocks</div>
            <div className="tb-row">
              {tile('step', { kind: 'step' }, 'an empty step', <StepArt fitter={fitter} />, <><b>Empty step</b><span>a new step, no processor</span></>)}
              {tile('wire', { kind: 'wire' }, 'an undecided wire', <WireArt />, <><b>Wire</b><span>undecided, open at both ends</span></>)}
            </div>
            <div className="tb-h">Processors <span className="tb-count">{lists ? processors.length : '…'}</span></div>
            {error && <div className="note tb-error">Could not read the lists: {error}</div>}
            {processors.map((p) => tile(`p:${p.id}`, { kind: 'processor', processor: p, schemas: schemasOf(p) }, `processor ${p.name} ${p.version}`,
              <ProcessorArt p={p} schemas={lists!.schemas} fitter={fitter} health={healthOf(p.id)} />, null))}
            <div className="tb-h">Caches <span className="tb-count">{lists ? caches.length : '…'}</span></div>
            {tile('newCache', { kind: 'newCache' }, 'an empty cache', <CacheArt c={EMPTY_CACHE} fitter={fitter} />, <><b>Empty cache</b><span>a new cache, no items</span></>)}
            {caches.map((c) => tile(`c:${c.id}`, { kind: 'cache', cache: c }, `cache ${c.name} ${c.version}`, <CacheArt c={c} fitter={fitter} />,
              <><b>{c.name}</b><span>{c.version}</span><span className="tb-root">root {c.root}</span></>))}
          </>
        )}
      </div>
      {ghost && drag && doc.body && createPortal(
        <div className="tb-ghost" style={{ left: drag.client.x + 10, top: drag.client.y + 10 }} aria-hidden="true">{ghost}</div>, doc.body,
      )}
    </div>
  );
}

/** What follows the pointer while a tile is dragged: a small copy of its art. */
function ghostArt(item: ToolItem, fitter: TextFitter, schemas: Map<Id, Schema>, healthOf: (id: string) => Health): ReactNode {
  switch (item.kind) {
    case 'step': return <StepArt fitter={fitter} />;
    case 'wire': return <WireArt />;
    case 'newCache': return <CacheArt c={EMPTY_CACHE} fitter={fitter} />;
    case 'cache': return <CacheArt c={item.cache} fitter={fitter} />;
    case 'processor': return <ProcessorArt p={item.processor} schemas={schemas} fitter={fitter} health={healthOf(item.processor.id)} />;
  }
}
