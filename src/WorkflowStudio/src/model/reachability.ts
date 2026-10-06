import type { Id, Step } from './graph';

/**
 * The step set a workflow start sees: breadth first from the entry steps over nextStepIds, each
 * step once, ids that name no step skipped. Mirrors WorkflowGraphLoader.LoadL1Async, so the order
 * is BFS wave order.
 */
export function reachableStepIds(entryStepIds: Id[], steps: ReadonlyMap<Id, Pick<Step, 'nextStepIds'>>): Id[] {
  const seen = new Set<Id>();
  const order: Id[] = [];
  let wave = entryStepIds.filter((id) => steps.has(id));

  while (wave.length > 0) {
    const next: Id[] = [];
    for (const id of wave) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      for (const child of steps.get(id)!.nextStepIds) {
        if (steps.has(child) && !seen.has(child)) next.push(child);
      }
    }
    wave = next;
  }

  return order;
}
