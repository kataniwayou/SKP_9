import type { StudioDocument } from '../app/document';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { entityName } from '../model/entityNames';

/**
 * A wire as the Inspector names it (plan 9): "{from} → {to}", a terminal by its unique name, a junction or an open end
 * by what it is. A wire the document does not draw is read from its id (`s->t`); null when even that says nothing.
 */
export function wireName(shown: StudioDocument | null, id: string): string | null {
  const graph = shown?.graph;
  const name = (stepId: string) => {
    if (stepId === WORKFLOW_SOURCE) return graph ? entityName(graph.workflow.name, graph.workflow.version, graph.workflow.id) : stepId;
    const s = graph?.steps.get(stepId);
    return s ? entityName(s.name, s.version, s.id) : stepId;
  };
  const w = shown?.wires.find((x) => x.id === id);
  if (!w) {
    const at = id.indexOf('->');
    return at > 0 ? `${name(id.slice(0, at))} → ${name(id.slice(at + 2))}` : null;
  }
  const from = w.source !== null ? name(w.source) : w.tailOn === 'junction' ? 'a junction' : 'an open end';
  const to = w.target !== null ? name(w.target) : w.headOn === 'junction' ? 'a junction' : 'an open end';
  return `${from} → ${to}`;
}
