import type { LiveStore } from '../live/liveClient';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';

/** Output says when a workflow starts or stops running, whoever asked. Returns the unsubscribe. */
export function watchTransitions(live: LiveStore, output: OutputStore, nameOf: (id: Id) => string | null): () => void {
  return live.onWorkflowChange((changes) => {
    for (const c of changes) {
      const name = nameOf(c.workflowId) ?? c.workflowId;
      if (c.running) output.log(`${name} is running`, 'ok'); else output.log(`${name} stopped`);
    }
  });
}
