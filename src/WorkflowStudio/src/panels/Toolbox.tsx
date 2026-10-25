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
import { designLocked, type ToolboxPick } from '../store/studioState';
import { overlayCache, overlayProcessor, useActiveDesignGraph } from './toolboxView';
import { useStudio, useStudioStore } from '../store/studioStore';

/**
 * What the Toolbox lists (2026-10-11): every processor, cache and schema BaseApi holds, read when it opens and after each Save.
 * `usedBy` (2026-10-25): each cache's workflows by name, as BaseApi lists them; null when the workflows could not be read.
 */
interface Lists { processors: Processor[]; caches: Cache[]; schemas: Map<Id, Schema>; usedBy: Map<Id, string[]> | null }

/** The names, as a sentence lists them. */
const named = (names: string[]) => names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * Why a cache's Delete is disabled, or null when it is offered (2026-10-25, the user's rule: offered for an unused cache,
 * shown disabled for a used one). Used is listed by a workflow BaseApi holds, or linked by an open workflow's unsaved
 * design, whose Save would then fail. BaseApi refuses a used one again, whatever the Toolbox read.
 */
export function cacheDeleteBlocked(id: Id, usedBy: Map<Id, string[]> | null, linkedBy: Map<Id, string[]>): string | null {
  if (usedBy === null) return 'Cannot tell which workflows use it: the workflows could not be read';
  const saved = usedBy.get(id) ?? [], unsaved = linkedBy.get(id) ?? [];
  if (saved.length > 0) return `Used by ${named(saved)}: remove it from ${saved.length === 1 ? 'that workflow' : 'those workflows'} first`;
  if (unsaved.length > 0) return `Linked in the unsaved design of ${named(unsaved)}`;
  return null;
}

const NO_AUDIT = { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null };
/** The empty step tile's step: a new one has this name and no processor (the amber ⚠ slot). */
const EMPTY_STEP: Step = { id: '', name: 'empty step', version: '1.0.0', description: null, processorId: null, nextStepIds: [], entryCondition: 1, updatedAt: '', audit: NO_AUDIT };
const EMPTY_CACHE: Cache = { id: '', name: 'empty cache', version: '1.0.0', description: null, root: '', items: '{}', audit: NO_AUDIT };

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

/**
 * The undecided wire, as the legend and the canvas draw it: grey, dashed, open at both ends; in a processor tile's box
 * (184 by 88), its name under it (2026-10-22: the Blocks tiles size as the processors' do).
 */
function WireArt() {
  return (
    <svg className="tb-art tb-wire" viewBox="0 0 184 88" aria-hidden="true">
      <circle className="lg-ring" cx="22" cy="38" r="5" />
      <path className="lg-undecided" d="M27 38H158" />
      <path className="lg-arrow" d="M150 29L161 38L150 47" />
      <text className="tb-wire-name" x="92" y="70">undecided wire</text>
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

/** A press that moves less than this (screen px) before it is let go is a click, not a drag. */
const DRAG_START = 4;

/** The schemas a processor's slots name, as the lists hold them. */
const schemasOfList = (p: Processor, schemas: ReadonlyMap<Id, Schema>): Schema[] => [p.inputSchemaId, p.outputSchemaId, p.configSchemaId]
  .flatMap((id) => { const s = id ? schemas.get(id) : undefined; return s ? [s] : []; });

/** What a click on a tile picks for the Inspector: an existing processor or cache; a template picks nothing (null). */
export function pickOf(item: ToolItem): ToolboxPick | null {
  switch (item.kind) {
    case 'processor': return { kind: 'processor', processor: item.processor, schemas: item.schemas };
    case 'cache': return { kind: 'cache', cache: item.cache };
    default: return null;
  }
}

const pickKeyOf = (item: ToolItem): string | null =>
  item.kind === 'processor' ? `processor:${item.processor.id}` : item.kind === 'cache' ? `cache:${item.cache.id}` : null;

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
  // read again after a cache is deleted (2026-10-25)
  const [reads, setReads] = useState(0);

  useEffect(() => {
    if (!api?.listProcessors || !api.listCaches || !api.listSchemas) return undefined;
    let live = true;
    // a test's fake may lack it: then which workflows use a cache is not known
    const workflows = typeof api.listWorkflows === 'function' ? api.listWorkflows() : Promise.resolve(null);
    void Promise.all([api.listProcessors(), api.listCaches(), api.listSchemas(), workflows]).then(([p, c, s, w]) => {
      if (!live) return;
      if (!p.ok || !c.ok || !s.ok) {
        setError(describeError((!p.ok ? p.error : !c.ok ? c.error : (s as { ok: false; error: Parameters<typeof describeError>[0] }).error)));
        return;
      }
      setError(null);
      let usedBy: Map<Id, string[]> | null = null;
      if (w?.ok) {
        usedBy = new Map();
        for (const wf of w.value) for (const id of wf.cacheIds ?? []) usedBy.set(id, [...(usedBy.get(id) ?? []), wf.name ?? wf.id ?? 'a workflow']);
      }
      setLists({
        processors: p.value.map(processorFromDto).sort((a, b) => a.name.localeCompare(b.name)),
        caches: c.value.map(cacheFromDto).sort((a, b) => a.name.localeCompare(b.name)),
        schemas: new Map(s.value.map(schemaFromDto).map((x) => [x.id, x])),
        usedBy,
      });
    });
    return () => { live = false; };
  }, [api, generations, reads]);

  // the caches an open document's design links and has not saved: a Save would link them, so they are in use too
  const docs = useStudio((s) => s.docs);
  const linkedBy = useMemo(() => {
    const m = new Map<Id, string[]>();
    for (const d of docs) for (const id of Object.keys(d.design.draft.blocks.linked)) m.set(id, [...(m.get(id) ?? []), d.name]);
    return m;
  }, [docs]);

  // a cache's Delete (2026-10-25): asked on the tile, then sent; BaseApi's refusal is shown on it
  const [asking, setAsking] = useState<Id | null>(null);
  const [deleting, setDeleting] = useState<Id | null>(null);
  const [refused, setRefused] = useState<{ id: Id; text: string } | null>(null);
  const deleteCache = async (id: Id) => {
    if (!api?.deleteCache) return;
    setDeleting(id);
    const r = await api.deleteCache(id);
    setDeleting(null);
    setAsking(null);
    // gone already is what was asked
    if (r.ok || r.error.kind === 'notFound') { setRefused(null); setReads((n) => n + 1); return; }
    setRefused({ id, text: `Not deleted: ${describeError(r.error)}` });
  };

  const toolboxPick = useStudio((s) => s.toolboxPick);
  const picked = toolboxPick === null ? null : toolboxPick.kind === 'processor' ? `processor:${toolboxPick.processor.id}` : `cache:${toolboxPick.cache.id}`;
  // the lists read again: the picked entity's snapshot follows them (gone from BaseApi, the pick goes)
  useEffect(() => {
    const pick = store.getState().toolboxPick;
    if (!lists || pick === null) return;
    const fresh: ToolboxPick | null = pick.kind === 'processor'
      ? (() => { const p = lists.processors.find((x) => x.id === pick.processor.id); return p ? { kind: 'processor', processor: p, schemas: schemasOfList(p, lists.schemas) } : null; })()
      : (() => { const c = lists.caches.find((x) => x.id === pick.cache.id); return c ? { kind: 'cache', cache: c } : null; })();
    store.dispatch({ type: 'toolboxPick', pick: fresh });
  }, [lists, store]);

  const needle = q.trim().toLowerCase();
  // an entity the active document's design changed is shown as that design has it, marked unsaved (2026-10-11)
  const design = useActiveDesignGraph();
  const processors = useMemo(() => (lists?.processors ?? []).map((p) => ({ p, shown: overlayProcessor(p, design) }))
    .filter(({ shown }) => matches(needle, shown.value.name, shown.value.version)), [lists, design, needle]);
  const caches = useMemo(() => (lists?.caches ?? []).map((c) => ({ c, shown: overlayCache(c, design) }))
    .filter(({ shown }) => matches(needle, shown.value.name, shown.value.version, shown.value.root)), [lists, design, needle]);

  /**
   * A press on a tile: once the pointer has moved DRAG_START px it is a drag, which the window it runs in follows until
   * it is let go (or Escape); let go before that, it is a click (2026-10-11): an existing processor or cache is picked for
   * the Inspector (read-only, one at a time), a template (empty step, wire, empty cache) picks nothing.
   */
  const begin = (item: ToolItem) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const win = e.currentTarget.ownerDocument.defaultView ?? window;
    // a Save locks that document: nothing lands on it
    const isSaving = (id: Id) => { const d = store.getState().docs.find((x) => x.workflowId === id); return d ? designLocked(d) : false; };
    const from = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_START) return;
        dragging = true;
        toolDrag.start(item, from);
      }
      toolDrag.move(win.document, { x: ev.clientX, y: ev.clientY }, isSaving);
      // Visio's crosshair while a wire's end is placed over a canvas (plan 10 phase 2)
      if (item.kind === 'wire') win.document.body.classList.toggle('tool-cross', toolDrag.get()?.over != null);
    };
    const stop = () => {
      if (item.kind === 'wire') win.document.body.classList.remove('tool-cross');
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', cancel);
      win.removeEventListener('keydown', key, true);
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (!dragging) {
        // a click: the Inspector shows the tile's entity (the Inspector pane stays as it is, shown or hidden)
        store.dispatch({ type: 'toolboxPick', pick: pickOf(item) });
        return;
      }
      toolDrag.move(win.document, { x: ev.clientX, y: ev.clientY }, isSaving);
      const drop = toolDrag.end();
      if (!drop) return;
      store.dispatch({ type: 'activate', workflowId: drop.workflowId });
      store.dispatch({ type: 'toolDrop', workflowId: drop.workflowId, item: drop.item, at: drop.at, reach: drop.reach, newId, roots: (lists?.caches ?? []).map((c) => c.root) });
    };
    const cancel = () => { stop(); if (dragging) toolDrag.cancel(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', cancel);
    win.addEventListener('keydown', key, true);
  };

  const tile = (key: string, item: ToolItem, label: string, art: ReactNode, text: ReactNode, unsaved = false) => (
    <div key={key} className={picked !== null && picked === pickKeyOf(item) ? 'tb-tile picked' : 'tb-tile'} role="button" tabIndex={-1}
      aria-label={`Drag ${label}`} aria-pressed={picked !== null && picked === pickKeyOf(item)} data-tool={item.kind}
      data-id={item.kind === 'processor' ? item.processor.id : item.kind === 'cache' ? item.cache.id : undefined}
      onPointerDown={begin(item)}>
      {art}
      <div className="tb-text">{text}</div>
      {unsaved && <span className="tb-unsaved" title="Changed in this workflow's design, not saved yet" aria-label="unsaved changes">●</span>}
    </div>
  );

  /**
   * A cache tile's Delete (2026-10-25): offered when no workflow uses the cache, shown disabled with the reason when one
   * does; pressed, the tile asks first. A press here is not the tile's: it neither picks nor drags.
   */
  const deleteControls = (c: Cache, v: Cache) => {
    const blocked = !lists ? 'Reading which workflows use it…' : !api?.deleteCache ? 'Deleting is not available' : cacheDeleteBlocked(c.id, lists.usedBy, linkedBy);
    const busy = deleting === c.id;
    return (
      <div className="tb-del" onPointerDown={(e) => e.stopPropagation()}>
        {asking === c.id ? (
          <>
            <span className="tb-del-ask">Delete for good?</span>
            <button type="button" className="tb-del-go" disabled={busy} onClick={() => void deleteCache(c.id)}>{busy ? 'Deleting…' : 'Delete'}</button>
            <button type="button" disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
          </>
        ) : (
          // the reason on a wrapper: a disabled button shows no tooltip of its own in every browser
          <span title={blocked ?? 'No workflow uses it'}>
            <button type="button" aria-label={`Delete cache ${v.name} ${v.version}`} disabled={blocked !== null}
              onClick={() => { setRefused(null); setAsking(c.id); }}>Delete</button>
          </span>
        )}
        {refused?.id === c.id && <span className="tb-del-error" role="alert">{refused.text}</span>}
      </div>
    );
  };

  const schemasOf = (p: Processor): Schema[] => schemasOfList(p, lists?.schemas ?? new Map());
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
              {tile('step', { kind: 'step' }, 'an empty step', <StepArt fitter={fitter} />, null)}
              {tile('wire', { kind: 'wire' }, 'an undecided wire', <WireArt />, null)}
            </div>
            <div className="tb-h">Processors <span className="tb-count">{lists ? processors.length : '…'}</span></div>
            {error && <div className="note tb-error">Could not read the lists: {error}</div>}
            {processors.map(({ p, shown }) => tile(`p:${p.id}`, { kind: 'processor', processor: p, schemas: schemasOf(p) }, `processor ${shown.value.name} ${shown.value.version}`,
              <ProcessorArt p={shown.value} schemas={lists!.schemas} fitter={fitter} health={healthOf(p.id)} />, null, shown.unsaved))}
            <div className="tb-h">Caches <span className="tb-count">{lists ? caches.length : '…'}</span></div>
            {tile('newCache', { kind: 'newCache' }, 'an empty cache', <CacheArt c={EMPTY_CACHE} fitter={fitter} />, <><b>Empty cache</b><span>a new cache, no root yet</span></>)}
            {caches.map(({ c, shown: { value: v, unsaved } }) => tile(`c:${c.id}`, { kind: 'cache', cache: c }, `cache ${v.name} ${v.version}`, <CacheArt c={v} fitter={fitter} />,
              <><b>{v.name}</b><span>{v.version}</span><span className="tb-root">root {v.root}</span>{deleteControls(c, v)}</>, unsaved))}
          </>
        )}
      </div>
      {ghost && drag && doc.body && createPortal(
        <div className="tb-ghost" style={{ left: drag.client.x, top: drag.client.y }} aria-hidden="true">{ghost}</div>, doc.body,
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
