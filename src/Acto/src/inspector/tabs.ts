import { hueOf } from '../board/hues';
import { pickKey } from '../board/picks';
import type { Pick as BoardPick, SelectionState } from '../board/selection';
import type { BoardState } from '../design/board';
import { reachOf, SLOT_FIELD, type Slot } from '../design/board';
import type { GhostStore } from '../design/ghosts';

/**
 * One top Inspector tab (spec §5). Step and Processor are the only parents [user, 2026-11-18]: each shows its own fields
 * and has a child row (Step: the assignments, Processor: the schemas).
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

/** The selected workflows: `workflows`, then any picked triangle not in it, once each. */
function triangles(sel: SelectionState): string[] {
  const ids = [...sel.workflows];
  for (const p of sel.picks) if (p.kind === 'workflow' && !ids.includes(p.id)) ids.push(p.id);
  return ids;
}

/**
 * The one thing the tabs are about (spec §5, [user, 2026-11-18]): the single pick that is not a triangle; else, with no
 * such pick, the one selected workflow. null: nothing, or a pick list (see listOf).
 */
export function focusOf(sel: SelectionState): BoardPick | null {
  const others = sel.picks.filter((p) => p.kind !== 'workflow');
  if (others.length > 1) return null;
  if (others.length === 1) return others[0]!;
  const wfs = triangles(sel);
  return wfs.length === 1 ? { kind: 'workflow', id: wfs[0]! } : null;
}

/**
 * The numbered pick list, or null when one thing (or nothing) is shown: two or more non-triangle picks list every pick,
 * triangles included; only triangles, two or more of them, list those workflows [user, 2026-11-18].
 */
export function listOf(sel: SelectionState): BoardPick[] | null {
  const others = sel.picks.filter((p) => p.kind !== 'workflow');
  if (others.length > 1) return sel.picks;
  if (others.length === 1) return null;
  const wfs = triangles(sel);
  return wfs.length > 1 ? wfs.map((id) => ({ kind: 'workflow', id })) : null;
}

/** A stable key of what the tabs are about; the chosen tab is kept while it stays the same. */
export const focusKey = (sel: SelectionState): string | null => {
  const f = focusOf(sel);
  return f === null ? null : pickKey(f);
};

/** The top tabs for a selection (spec §5 table). Empty: nothing to show, or a pick list. */
export function tabsOf(sel: SelectionState, b: BoardState, ghosts: GhostLookup): Tab[] {
  const f = focusOf(sel);
  if (f === null) return [];
  switch (f.kind) {
    case 'workflow': return b.workflows[f.id] ? [{ id: 'workflow', label: 'Workflow' }] : [];
    case 'cache': return b.caches[f.id] ? [{ id: 'cache', label: 'Cache' }] : [];
    case 'wire': case 'entry': case 'cacheLink': return [{ id: 'link', label: 'Link' }];
    case 'ghost': return ghosts.get(f.key) ? [{ id: 'ghost', label: 'Deleted' }] : [];
    case 'step': return b.steps[f.id] ? [{ id: 'step', label: 'Step' }, { id: 'processor', label: 'Processor' }] : [];
  }
}

/** Step's children: one assignment tab per selected workflow whose stream holds the step, in selection order, with its hue. */
export function stepTabsOf(sel: SelectionState, b: BoardState, stepId: string): ChildTab[] {
  if (!b.steps[stepId]) return [];
  const tabs: ChildTab[] = [];
  for (const wf of sel.workflows) {
    const w = b.workflows[wf];
    if (!w || !reachOf(b, wf).has(stepId)) continue;
    tabs.push({ id: `assignment:${wf}`, label: w.name, hue: hueOf(sel, wf) ?? undefined });
  }
  return tabs;
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

/** What the designer chose: a top tab and, under a parent, a child (null = the parent's own fields). */
export interface Chosen { key: string | null; tab: TabId; child: ChildId | null }

/** The top tab shown: the chosen one while the same thing stays picked and the tab is still there, else the first. */
export function activeTab(tabs: readonly Tab[], key: string | null, chosen: Chosen | null): TabId | null {
  if (chosen && chosen.key === key && tabs.some((t) => t.id === chosen.tab)) return chosen.tab;
  return tabs[0]?.id ?? null;
}

/** The child shown under the active parent: the chosen one while the pick, the parent and the child all stay; else none. */
export function activeChild(children: readonly ChildTab[], key: string | null, tab: TabId | null, chosen: Chosen | null): ChildId | null {
  if (!chosen || chosen.key !== key || chosen.tab !== tab || chosen.child === null) return null;
  return children.some((c) => c.id === chosen.child) ? chosen.child : null;
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
