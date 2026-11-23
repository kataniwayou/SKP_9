import type { LiveStatus } from '../api/liveStatus';
import type { ItemRef } from '../design/board';
import type { Id } from '../model/graph';
import type { ToolbarItem } from './nodes/boardContext';
import { pickKey, type Pick } from './picks';

/** What the toolbars act through (App supplies it). */
export interface ToolbarDeps {
  /** The picks now: a triangle's toolbar shows only while it is picked. */
  picks: readonly Pick[];
  /** The workflow's run state now. */
  run(wf: Id): LiveStatus;
  start(wf: Id): void;
  stop(wf: Id): void;
  /** Copy of a triangle, step or cache for Ctrl+V. */
  copy(ref: ItemRef): void;
  /** Delete of a triangle, step, cache, wire, entry arrow or cache line: one board edit, a ghost until Save. */
  remove(p: Pick): void;
  /** Puts these ghosts back as one board edit (a refusal is an Output warning). */
  restore(keys: string[]): void;
  /** Drops these ghosts for this page session; not an undo step. */
  removeGhosts(keys: string[]): void;
}

/**
 * The toolbar over a lone pick (spec §6): triangle Start/Stop · Copy · Delete (a ghost, like every delete [user, 2026-11-23]); step and cache Copy · Delete [user, 2026-11-19]; wire, entry arrow and cache line Delete; ghost Restore · Remove.
 */
export function toolbarFor(p: Pick, d: ToolbarDeps): ToolbarItem[] | null {
  const del: ToolbarItem = { label: 'Delete', tone: 'danger', onClick: () => d.remove(p) };
  switch (p.kind) {
    case 'workflow': {
      if (!d.picks.some((x) => pickKey(x) === pickKey(p))) return null;
      const run = d.run(p.id);
      const runItem: ToolbarItem = run === 'running'
        ? { label: '■ Stop', tone: 'stop', onClick: () => d.stop(p.id) }
        : { label: '▶ Start', tone: 'go', disabled: run !== 'stopped', onClick: () => d.start(p.id) };
      return [runItem, { label: 'Copy', onClick: () => d.copy({ kind: 'workflow', id: p.id }) }, del];
    }
    case 'step': case 'cache': return [{ label: 'Copy', onClick: () => d.copy({ kind: p.kind, id: p.id }) }, del];
    case 'wire': case 'entry': case 'cacheLink': return [del];
    case 'ghost': return [
      { label: 'Restore', onClick: () => d.restore([p.key]) },
      { label: 'Remove', tone: 'danger', onClick: () => d.removeGhosts([p.key]) },
    ];
  }
}
