import { useState, useSyncExternalStore } from 'react';
import { pickKey } from '../board/picks';
import type { Pick } from '../board/selection';
import type { BoardState } from '../design/board';
import type { BoardStore } from '../design/boardStore';
import type { GhostStore } from '../design/ghosts';
import { useLive, useLiveStore } from '../live/LiveContext';
import { statusOf } from '../live/liveState';
import { activeTab, focusKey, focusOf, tabsOf, type Tab, type TabId } from './tabs';
import { AssignmentTab } from './tabs/AssignmentTab';
import { CacheTab } from './tabs/CacheTab';
import { GhostTab, ghostName } from './tabs/GhostTab';
import { LinkTab } from './tabs/LinkTab';
import { ProcessorTab } from './tabs/ProcessorTab';
import { stepName, type Edit } from './tabs/shared';
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

function TabBar({ tabs, active, choose }: { tabs: readonly Tab[]; active: TabId; choose: (t: TabId) => void }) {
  return (
    <div className="ins-tabs" role="tablist" aria-label="Inspector tabs">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={`ins-tab-${t.id}`} aria-selected={t.id === active} aria-controls="ins-tabpanel"
          className={t.id === active ? 'ins-tab on' : 'ins-tab'} onClick={() => choose(t.id)}>
          {t.hue && <i className="dot" style={{ background: t.hue }} />}{t.label}
        </button>
      ))}
    </div>
  );
}

function TabBody({ tab, focus, state, edit, ghosts }: { tab: TabId; focus: Pick; state: BoardState; edit: Edit; ghosts: Ghosts }) {
  if (tab === 'workflow' && focus.kind === 'workflow') return <WorkflowTab state={state} edit={edit} id={focus.id} />;
  if (tab === 'cache' && focus.kind === 'cache') return <CacheTab state={state} edit={edit} id={focus.id} />;
  if (tab === 'link' && (focus.kind === 'wire' || focus.kind === 'entry' || focus.kind === 'cacheLink')) return <LinkTab state={state} pick={focus} />;
  if (tab === 'ghost' && focus.kind === 'ghost') {
    const g = ghosts.get(focus.key);
    return g ? <GhostTab state={state} ghosts={ghosts} item={g} /> : null;
  }
  if (focus.kind !== 'step') return null;
  if (tab === 'step') return <StepTab state={state} edit={edit} id={focus.id} />;
  if (tab === 'processor') return <ProcessorTab state={state} edit={edit} stepId={focus.id} />;
  if (tab.startsWith('assignment:')) return <AssignmentTab state={state} edit={edit} stepId={focus.id} workflowId={tab.slice('assignment:'.length)} />;
  return null;
}

/**
 * The Inspector (spec §5): tabs for what is picked, read from and edited through the board store (one state, one
 * history). The first tab opens on a new pick; the chosen tab is kept while the same thing stays picked. Several
 * non-triangle picks show the numbered pick list.
 */
export function InspectorPanel({ store, selection, ghosts }: { store: BoardStore; selection: InspectorSelection; ghosts: Ghosts }) {
  const state = useSyncExternalStore(store.subscribe, store.state);
  useSyncExternalStore(ghosts.subscribe, ghosts.ghosts);
  const [chosen, setChosen] = useState<{ key: string | null; tab: TabId } | null>(null);
  const edit: Edit = (fn, merge) => store.edit(fn, merge);
  const focus = focusOf(selection);
  const key = focusKey(selection);
  const tabs = tabsOf(selection, state, ghosts);
  const tab = activeTab(tabs, key, chosen);
  const list = selection.picks.filter((p) => p.kind !== 'workflow').length > 1;
  return (
    <>
      <Header store={store} kind={list ? `${selection.picks.length} selected` : tab !== null && focus ? focus.kind : ''} />
      {tab !== null && focus && <TabBar tabs={tabs} active={tab} choose={(t) => setChosen({ key, tab: t })} />}
      <div className="pb" {...(tab !== null ? { role: 'tabpanel', id: 'ins-tabpanel', 'aria-labelledby': `ins-tab-${tab}` } : {})}>
        {list ? <PickList picks={selection.picks} state={state} ghosts={ghosts} />
          : tab !== null && focus ? <TabBody key={`${key}|${tab}`} tab={tab} focus={focus} state={state} edit={edit} ghosts={ghosts} />
          : <BoardSummary state={state} />}
      </div>
    </>
  );
}
