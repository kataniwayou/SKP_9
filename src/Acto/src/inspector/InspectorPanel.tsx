import { useState, useSyncExternalStore } from 'react';
import { pickKey } from '../board/picks';
import { synced, type Pick } from '../board/selection';
import type { BoardState, ItemRef, Slot } from '../design/board';
import type { BoardStore } from '../design/boardStore';
import type { GhostStore } from '../design/ghosts';
import { useLive, useLiveStore } from '../live/LiveContext';
import { statusOf } from '../live/liveState';
import { activeChild, activeTab, chooseChild, chooseTab, focusKey, focusOf, keepChosen, listOf, processorTabsOf, stepTabsOf, tabsOf, type ChildId, type Chosen, type TabId } from './tabs';
import { AssignmentTab } from './tabs/AssignmentTab';
import { CacheTab } from './tabs/CacheTab';
import { GhostTab, ghostName } from './tabs/GhostTab';
import { LinkTab } from './tabs/LinkTab';
import { ProcessorTab } from './tabs/ProcessorTab';
import { SchemaTab } from './tabs/SchemaTab';
import { stepName, type Edit, type Go } from './tabs/shared';
import { StepTab } from './tabs/StepTab';
import { WorkflowTab } from './tabs/WorkflowTab';

type Id = string;
export interface InspectorSelection { workflows: Id[]; picks: Pick[] }
type Ghosts = { get: GhostStore['get']; ghosts: GhostStore['ghosts']; subscribe: GhostStore['subscribe'] };

function BoardSummary({ state }: { state: BoardState }) {
  const live = useLiveStore();
  useLive((s) => s.running);
  useLive((s) => s.workflows);
  const ids = Object.keys(state.workflows);
  const running = ids.filter((id) => statusOf(live.getState(), id) === 'running').length;
  return (
    <p className="none">Select a workflow, step or wire to see and edit it here.<br /><br />
      <span>{`Board: ${ids.length} workflow${ids.length === 1 ? '' : 's'}, ${running} running`}</span>.</p>
  );
}

function pickName(p: Pick, b: BoardState, ghosts: Ghosts): string | null {
  switch (p.kind) {
    case 'workflow': return b.workflows[p.id]?.name ?? null;
    case 'step': return b.steps[p.id]?.name ?? null;
    case 'cache': return b.caches[p.id]?.name ?? null;
    case 'wire': return `${stepName(b, p.from)} → ${stepName(b, p.to)}`;
    case 'entry': return `${b.workflows[p.workflowId]?.name ?? p.workflowId} → ${stepName(b, p.stepId)}`;
    case 'cacheLink': return `${b.workflows[p.workflowId]?.name ?? p.workflowId} → ${b.caches[p.cacheId]?.name ?? p.cacheId}`;
    case 'ghost': { const g = ghosts.get(p.key); return g ? ghostName(g, b, ghosts) : null; }
  }
}

function PickList({ picks, state, ghosts }: { picks: Pick[]; state: BoardState; ghosts: Ghosts }) {
  return (
    <>
      <p className="none">{`${picks.length} things are selected. The toolbar acts on all of them; pick one alone to edit it here.`}</p>
      <ol className="in-picks">
        {picks.map((p) => {
          const n = pickName(p, state, ghosts);
          return n === null ? null : <li key={pickKey(p)} data-kind={p.kind}>{n}</li>;
        })}
      </ol>
    </>
  );
}

function Header({ store, kind }: { store: BoardStore; kind: string }) {
  return (
    <div className="ph"><span>Inspector</span><span className="cnt">{kind}</span><span className="sp" />
      <button type="button" className="pbtn" disabled={!store.canUndo()} onClick={() => store.undo()}>Undo</button>
      <button type="button" className="pbtn" disabled={!store.canRedo()} onClick={() => store.redo()}>Redo</button>
    </div>
  );
}

/** A row of tabs: the Inspector's own (`ins-tab`) or a parent's children (`ins-subtab`, a lighter second row; none chosen = null). */
function TabBar<T extends string>({ tabs, active, choose, label = 'Inspector tabs', cls = 'ins-tab', panel = 'ins-tabpanel' }: {
  tabs: readonly { id: T; label: string; hue?: string }[]; active: T | null; choose: (t: T) => void; label?: string; cls?: string; panel?: string;
}) {
  return (
    <div className={`${cls}s`} role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={`${cls}-${t.id}`} aria-selected={t.id === active} aria-controls={panel}
          className={t.id === active ? `${cls} on` : cls} onClick={() => choose(t.id)}>
          {t.hue && <i className="dot" style={{ background: t.hue }} />}{t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Step and Processor, the two parents [user, 2026-11-18]: the parent's own fields, or the chosen child's (Step: an
 * assignment, Processor: a schema). The child row is drawn only when it has tabs; none is chosen at first.
 */
function ParentTab({ tab, ctx, sel, stepId, child, choose }: {
  tab: 'step' | 'processor'; ctx: { state: BoardState; base: BoardState; edit: Edit; go?: Go }; sel: InspectorSelection; stepId: string;
  child: ChildId | null; choose: (c: ChildId) => void;
}) {
  const children = tab === 'step' ? stepTabsOf(sel, ctx.state, stepId) : processorTabsOf(ctx.state, ctx.state.steps[stepId]?.processorId ?? null);
  const own = tab === 'step' ? <StepTab {...ctx} id={stepId} sel={sel} /> : <ProcessorTab {...ctx} stepId={stepId} />;
  if (children.length === 0) return own;
  return (
    <>
      <TabBar tabs={children} active={child} choose={choose} label={tab === 'step' ? 'Step tabs' : 'Processor tabs'} cls="ins-subtab" panel="ins-subpanel" />
      {child === null ? own : (
        <div role="tabpanel" id="ins-subpanel" aria-labelledby={`ins-subtab-${child}`}>
          {child.startsWith('assignment:')
            ? <AssignmentTab key={child} {...ctx} stepId={stepId} workflowId={child.slice('assignment:'.length)} />
            : <SchemaTab key={child} {...ctx} stepId={stepId} slot={child.slice('schema:'.length) as Slot} />}
        </div>
      )}
    </>
  );
}

function TabBody({ tab, focus, state, base, edit, ghosts, sel, child, choose, go }: {
  tab: TabId; focus: Pick; state: BoardState; base: BoardState; edit: Edit; ghosts: Ghosts;
  sel: InspectorSelection; child: ChildId | null; choose: (c: ChildId) => void; go?: Go;
}) {
  const ctx = { state, base, edit, ...(go ? { go } : {}) };
  if (tab === 'workflow' && focus.kind === 'workflow') return <WorkflowTab {...ctx} id={focus.id} />;
  if (tab === 'cache' && focus.kind === 'cache') return <CacheTab {...ctx} id={focus.id} />;
  if (tab === 'link' && (focus.kind === 'wire' || focus.kind === 'entry' || focus.kind === 'cacheLink')) return <LinkTab state={state} pick={focus} />;
  if (tab === 'ghost' && focus.kind === 'ghost') {
    const g = ghosts.get(focus.key);
    return g ? <GhostTab state={state} ghosts={ghosts} item={g} /> : null;
  }
  if (focus.kind === 'step' && (tab === 'step' || tab === 'processor')) {
    return <ParentTab tab={tab} ctx={ctx} sel={sel} stepId={focus.id} child={child} choose={choose} />;
  }
  return null;
}

/**
 * The Inspector (spec §5): tabs for what is picked, read from and edited through the board store (one state, one
 * history). A new pick opens its first tab with no child; the chosen tab and child are kept while the same thing stays
 * picked and they still exist. Rule 2: one thing, or one triangle with one step, shows tabs; anything else the numbered pick list.
 */
export function InspectorPanel({ store, selection: given, ghosts, onPicks, onCenter }: {
  store: BoardStore; selection: InspectorSelection; ghosts: Ghosts; onPicks?: (picks: Pick[]) => void;
  /** Centres an item on the board: a chip's link centres the step (or cache) it opens [user, 2026-11-19]. */
  onCenter?: (ref: ItemRef) => void;
}) {
  // one shape: the selected workflows are the picked triangles (rule 1)
  const selection = synced(given);
  const state = useSyncExternalStore(store.subscribe, store.state);
  useSyncExternalStore(ghosts.subscribe, ghosts.ghosts);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const edit: Edit = (fn, merge) => store.edit(fn, merge);
  const focus = focusOf(selection, state);
  const key = focusKey(selection, state);
  // a new pick forgets the chosen tab, so the item opens on its first tab even when it was picked before (spec §5)
  const [seen, setSeen] = useState<string | null>(key);
  if (seen !== key) {
    setSeen(key);
    const kept = keepChosen(chosen, key);
    if (kept !== chosen) setChosen(kept);
  }
  const list = listOf(selection, state);
  const tabs = tabsOf(selection, state, ghosts);
  const tab = activeTab(tabs, key, chosen);
  const children = focus?.kind === 'step' && tab === 'step' ? stepTabsOf(selection, state, focus.id)
    : focus?.kind === 'step' && tab === 'processor' ? processorTabsOf(state, state.steps[focus.id]?.processorId ?? null) : [];
  const child = activeChild(children, key, tab, chosen);
  // a chip's name [user, 2026-11-19]: the selection moves to its picks, and the tab (and Step's child) it names opens
  const go: Go | undefined = onPicks && ((picks, open) => {
    const next = focusKey({ workflows: [], picks }, store.state());
    setChosen(open ? { key: next, tab: open.tab, children: open.child ? { step: open.child as ChildId } : {} } : null);
    setSeen(next);
    onPicks(picks);
    const target = picks.find((p) => p.kind === 'step') ?? picks.find((p) => p.kind === 'cache');
    if (target && (target.kind === 'step' || target.kind === 'cache')) onCenter?.({ kind: target.kind, id: target.id });
  });
  return (
    <>
      <Header store={store} kind={list ? `${list.length} selected` : tab !== null && focus ? focus.kind : ''} />
      {!list && tab !== null && focus && <TabBar tabs={tabs} active={tab} choose={(t) => setChosen(chooseTab(chosen, key, tab, t))} />}
      <div className="pb" {...(!list && tab !== null ? { role: 'tabpanel', id: 'ins-tabpanel', 'aria-labelledby': `ins-tab-${tab}` } : {})}>
        {list ? <PickList picks={list} state={state} ghosts={ghosts} />
          : tab !== null && focus ? <TabBody key={`${key}|${tab}|${child ?? ''}`} tab={tab} focus={focus} state={state} base={store.base()} edit={edit} ghosts={ghosts}
            sel={selection} child={child} choose={(c) => { if (tab === 'step' || tab === 'processor') setChosen(chooseChild(chosen, key, tab, c)); }}
            {...(go ? { go } : {})} />
          : <BoardSummary state={state} />}
      </div>
    </>
  );
}
