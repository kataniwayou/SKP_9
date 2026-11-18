import { hueOf } from '../board/hues';
import { pickKey } from '../board/picks';
import type { Pick as BoardPick, SelectionState } from '../board/selection';
import type { BoardState } from '../design/board';
import { reachOf } from '../design/board';
import type { GhostStore } from '../design/ghosts';

/** One Inspector tab (spec §5). `assignment:<workflow id>` is that workflow's payload on the picked step. */
export type TabId = 'workflow' | 'step' | 'processor' | 'cache' | 'link' | 'ghost' | `assignment:${string}`;
export interface Tab { id: TabId; label: string; hue?: string }

type GhostLookup = Pick<GhostStore, 'get'>;

/**
 * The one thing the tabs are about: the single pick that is not a triangle, else (only triangles, or none with
 * workflows selected) the last clicked triangle. null: nothing, or several non-triangle picks (the pick list).
 */
export function focusOf(sel: SelectionState): BoardPick | null {
  const others = sel.picks.filter((p) => p.kind !== 'workflow');
  if (others.length > 1) return null;
  if (others.length === 1) return others[0]!;
  const lastWf = [...sel.picks].reverse().find((p) => p.kind === 'workflow');
  if (lastWf) return lastWf;
  const wf = sel.workflows.at(-1);
  return wf === undefined ? null : { kind: 'workflow', id: wf };
}

/** A stable key of what the tabs are about; the chosen tab is kept while it stays the same. */
export const focusKey = (sel: SelectionState): string | null => {
  const f = focusOf(sel);
  return f === null ? null : pickKey(f);
};

/** The tabs for a selection (spec §5 table). Empty: nothing to show, or several picks (the numbered pick list). */
export function tabsOf(sel: SelectionState, b: BoardState, ghosts: GhostLookup): Tab[] {
  const f = focusOf(sel);
  if (f === null) return [];
  switch (f.kind) {
    case 'workflow': return b.workflows[f.id] ? [{ id: 'workflow', label: 'Workflow' }] : [];
    case 'cache': return b.caches[f.id] ? [{ id: 'cache', label: 'Cache' }] : [];
    case 'wire': case 'entry': case 'cacheLink': return [{ id: 'link', label: 'Link' }];
    case 'ghost': return ghosts.get(f.key) ? [{ id: 'ghost', label: 'Deleted' }] : [];
    case 'step': {
      if (!b.steps[f.id]) return [];
      const tabs: Tab[] = [{ id: 'step', label: 'Step' }, { id: 'processor', label: 'Processor' }];
      for (const wf of sel.workflows) {
        const w = b.workflows[wf];
        if (!w || !reachOf(b, wf).has(f.id)) continue;
        tabs.push({ id: `assignment:${wf}`, label: w.name, hue: hueOf(sel, wf) ?? undefined });
      }
      return tabs;
    }
  }
}

/**
 * The chosen tab as the pick moves on: kept while the same thing stays picked, dropped as soon as the pick key changes, so
 * coming back to an item later (step → triangle → the same step) is a new pick that opens its first tab.
 */
export function keepChosen<C extends { key: string | null }>(chosen: C | null, key: string | null): C | null {
  return chosen && chosen.key === key ? chosen : null;
}

/** The tab shown: the chosen one while the same thing stays picked and the tab is still there, else the first. */
export function activeTab(tabs: readonly Tab[], key: string | null, chosen: { key: string | null; tab: TabId } | null): TabId | null {
  if (chosen && chosen.key === key && tabs.some((t) => t.id === chosen.tab)) return chosen.tab;
  return tabs[0]?.id ?? null;
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
