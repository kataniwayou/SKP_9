import { hueOf } from '../board/hues';
import { pickKey } from '../board/picks';
import type { Pick as BoardPick, SelectionState } from '../board/selection';
import type { BoardState } from '../design/board';
import { reachOf, SLOT_FIELD, type Slot } from '../design/board';
import type { GhostStore } from '../design/ghosts';

/**
 * One top Inspector tab (spec §5). Step and Processor are the only parents [user, 2026-11-18]: each shows its own fields
 * and has a child row (Step: the one assignment, Processor: the schemas).
 */
export type TabId = 'workflow' | 'step' | 'processor' | 'cache' | 'link' | 'ghost';
export interface Tab { id: TabId; label: string }

/** A child tab: `assignment:<workflow id>` (under Step) is that workflow's payload on the step; `schema:<slot>` (under Processor) the schema in that slot. */
export type ChildId = `assignment:${string}` | `schema:${Slot}`;
export interface ChildTab { id: ChildId; label: string; hue?: string }

/** The processor's slots in tab order, and their tab labels. */
export const SLOTS: readonly Slot[] = ['input', 'output', 'config'];
export const SLOT_LABEL: Readonly<Record<Slot, string>> = { input: 'Input schema', output: 'Output schema', config: 'Config schema' };

type GhostLookup = Pick<GhostStore, 'get'>;

/**
 * The triangles picked with exactly one step, in pick order, when that is the whole selection and every one of their
 * streams reaches the step (spec §5, rule 2 [user, 2026-11-19: "only workflows+one step from the same stream apply the
 * step assignments"]); null for any other selection — one workflow off the step's stream makes the whole selection a list.
 */
export function assignmentWorkflowsOf(sel: SelectionState, b: BoardState): string[] | null {
  const steps = sel.picks.filter((p) => p.kind === 'step');
  const wfs = sel.picks.flatMap((p) => (p.kind === 'workflow' ? [p.id] : []));
  if (steps.length !== 1 || wfs.length === 0 || steps.length + wfs.length !== sel.picks.length) return null;
  const stepId = steps[0]!.kind === 'step' ? steps[0]!.id : '';
  return wfs.every((wf) => reachOf(b, wf).has(stepId)) ? wfs : null;
}

/**
 * What the Inspector shows for the picks (spec §5, rule 2): one thing alone → that thing; one or more triangles and one
 * step their streams all reach → the step (with each workflow's assignment under Step); nothing → null; anything else →
 * the pick list (see listOf).
 */
export function focusOf(sel: SelectionState, b: BoardState): BoardPick | null {
  const { picks } = sel;
  if (picks.length === 1) return picks[0]!;
  return assignmentWorkflowsOf(sel, b) === null ? null : picks.find((p) => p.kind === 'step')!;
}

/** The numbered pick list of everything selected (triangles included), or null when one thing (or nothing) is shown. */
export function listOf(sel: SelectionState, b: BoardState): BoardPick[] | null {
  return sel.picks.length > 0 && focusOf(sel, b) === null ? sel.picks : null;
}

/** A stable key of what the tabs are about; the chosen tab is kept while it stays the same. */
export const focusKey = (sel: SelectionState, b: BoardState): string | null => {
  const f = focusOf(sel, b);
  return f === null ? null : pickKey(f);
};

/** The top tabs for a selection (spec §5 table). Empty: nothing to show, or a pick list. */
export function tabsOf(sel: SelectionState, b: BoardState, ghosts: GhostLookup): Tab[] {
  const f = focusOf(sel, b);
  if (f === null) return [];
  switch (f.kind) {
    case 'workflow': return b.workflows[f.id] ? [{ id: 'workflow', label: 'Workflow' }] : [];
    case 'cache': return b.caches[f.id] ? [{ id: 'cache', label: 'Cache' }] : [];
    case 'wire': case 'entry': case 'cacheLink': return [{ id: 'link', label: 'Link' }];
    case 'schema': case 'processor': return []; // their tabs come with the Inspector work
    case 'ghost': return ghosts.get(f.key) ? [{ id: 'ghost', label: 'Deleted' }] : [];
    case 'step': return b.steps[f.id] ? [{ id: 'step', label: 'Step' }, { id: 'processor', label: 'Processor' }] : [];
  }
}

/**
 * Step's children: one assignment tab per triangle picked with the step (rule 3 [user, 2026-11-19]), in pick order, named
 * after the workflow, in its hue; none when no triangle is picked with it (or the selection is a list, see
 * assignmentWorkflowsOf).
 */
export function stepTabsOf(sel: SelectionState, b: BoardState, stepId: string): ChildTab[] {
  const wfs = assignmentWorkflowsOf(sel, b);
  if (wfs === null || !b.steps[stepId]) return [];
  return wfs.flatMap((id): ChildTab[] => {
    const w = b.workflows[id];
    return w ? [{ id: `assignment:${w.id}`, label: w.name, hue: hueOf(sel, w.id) ?? undefined }] : [];
  });
}

/** Processor's children: a schema tab per slot of the processor that holds a schema. Empty: none, or no such processor. */
export function processorTabsOf(b: BoardState, processorId: string | null): ChildTab[] {
  const p = processorId === null ? undefined : b.processors[processorId];
  if (!p) return [];
  return SLOTS.flatMap((slot): ChildTab[] => (p[SLOT_FIELD[slot]] !== null ? [{ id: `schema:${slot}`, label: SLOT_LABEL[slot] }] : []));
}

/**
 * The chosen tab as the pick moves on: kept while the same thing stays picked, dropped as soon as the pick key changes, so
 * coming back to an item later (step → triangle → the same step) is a new pick that opens its first tab.
 */
export function keepChosen<C extends { key: string | null }>(chosen: C | null, key: string | null): C | null {
  return chosen && chosen.key === key ? chosen : null;
}

/** A parent tab: the tabs with a child row. */
export type Parent = 'step' | 'processor';
const isParent = (t: TabId | null): t is Parent => t === 'step' || t === 'processor';

/**
 * What the designer chose for the current pick: a top tab and, per parent, its child (absent or null = the parent's own
 * fields). Each parent keeps its own child while the same pick stays, so Step's child survives a visit to Processor.
 */
export interface Chosen { key: string | null; tab: TabId; children: Partial<Record<Parent, ChildId | null>> }

/** A click on top tab `t` while `active` shows: a click on the shown parent returns it to its own fields; another tab keeps every child. */
export function chooseTab(chosen: Chosen | null, key: string | null, active: TabId | null, t: TabId): Chosen {
  const children = chosen && chosen.key === key ? chosen.children : {};
  return { key, tab: t, children: t === active && isParent(t) ? { ...children, [t]: null } : children };
}

/** A click on child `c` of the shown parent `tab`. */
export function chooseChild(chosen: Chosen | null, key: string | null, tab: Parent, c: ChildId): Chosen {
  const children = chosen && chosen.key === key ? chosen.children : {};
  return { key, tab, children: { ...children, [tab]: c } };
}

/** The top tab shown: the chosen one while the same thing stays picked and the tab is still there, else the first. */
export function activeTab(tabs: readonly Tab[], key: string | null, chosen: Chosen | null): TabId | null {
  if (chosen && chosen.key === key && tabs.some((t) => t.id === chosen.tab)) return chosen.tab;
  return tabs[0]?.id ?? null;
}

/** The child shown under the shown parent: its chosen one while the pick stays and the child still exists; else none. */
export function activeChild(children: readonly ChildTab[], key: string | null, tab: TabId | null, chosen: Chosen | null): ChildId | null {
  if (!chosen || chosen.key !== key || !isParent(tab)) return null;
  const c = chosen.children[tab] ?? null;
  return c !== null && children.some((x) => x.id === c) ? c : null;
}

const NONE = '—';

/**
 * `2026-10-05T12:00:00.123456Z` → `2026-10-05 12:00:00.123 UTC` (Studio's rule, always to the millisecond); "—" when
 * absent; another instant is read as a date and shown in UTC; anything else as it came.
 */
export function formatInstant(iso: string | null): string {
  if (iso === null || iso === '') return NONE;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(iso);
  if (m) return `${m[1]} ${m[2]}.${(m[3] ?? '').padEnd(3, '0').slice(0, 3)} UTC`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = new Date(t).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 23)} UTC`;
}
