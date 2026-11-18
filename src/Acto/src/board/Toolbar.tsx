import type { LiveStatus } from '../api/liveStatus';
import type { Id } from '../model/graph';
import type { DeletePlan } from '../operate/deleteWorkflow';
import type { ToolbarItem } from './nodes/boardContext';
import { pickKey, type Pick } from './picks';

/** What the toolbars act through (App supplies it). */
export interface ToolbarDeps {
  /** The picks now: a triangle's toolbar shows only while it is picked. */
  picks: readonly Pick[];
  /** The workflow's run state now. */
  run(wf: Id): LiveStatus;
  /** A triangle delete waiting for its confirm. */
  pending: DeletePlan | null;
  start(wf: Id): void;
  stop(wf: Id): void;
  copy(stepId: Id): void;
  /** Delete of a step, cache, wire, entry arrow or cache line: one board edit. */
  remove(p: Pick): void;
  /** A triangle's Delete: the dry run first, then the confirm. */
  askDelete(wf: Id): void;
  confirmDelete(): void;
  cancelDelete(): void;
}

/** The confirm's question, from the dry run's list of what goes. */
export const confirmText = (plan: DeletePlan) => `Delete ${plan.lines.join(', ')}? Its steps and caches stay.`;

/**
 * The toolbar over a lone pick (spec §6): triangle Start/Stop · Delete (a pending delete shows its confirm instead);
 * step Copy · Delete; cache, wire, entry arrow and cache line Delete.
 */
export function toolbarFor(p: Pick, d: ToolbarDeps): ToolbarItem[] | null {
  const del: ToolbarItem = { label: 'Delete', tone: 'danger', onClick: () => d.remove(p) };
  switch (p.kind) {
    case 'workflow': {
      if (!d.picks.some((x) => pickKey(x) === pickKey(p))) return null;
      if (d.pending && d.pending.workflowId === p.id) {
        return [
          { label: confirmText(d.pending), note: true, onClick: () => {} },
          { label: 'Delete', tone: 'danger', onClick: d.confirmDelete },
          { label: 'Cancel', onClick: d.cancelDelete },
        ];
      }
      const run = d.run(p.id);
      const runItem: ToolbarItem = run === 'running'
        ? { label: '■ Stop', tone: 'stop', onClick: () => d.stop(p.id) }
        : { label: '▶ Start', tone: 'go', disabled: run !== 'stopped', onClick: () => d.start(p.id) };
      return [runItem, { label: 'Delete', tone: 'danger', onClick: () => d.askDelete(p.id) }];
    }
    case 'step': return [{ label: 'Copy', onClick: () => d.copy(p.id) }, del];
    case 'cache': case 'wire': case 'entry': case 'cacheLink': return [del];
  }
}
