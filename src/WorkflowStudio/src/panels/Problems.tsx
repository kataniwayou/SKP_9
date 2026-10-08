import { useMemo } from 'react';
import { useGuard } from '../app/studioActions';
import { applyDesign } from '../design/apply';
import { isShortCircuitError, shortCircuitErrors } from '../design/shortCircuits';
import { entityName } from '../model/entityNames';
import type { DesignError, Graph } from '../model/graph';
import { errorTarget } from '../store/errorTarget';
import { selectionKey } from '../store/selection';
import { activeDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { PaneNote } from './PaneNote';

const KIND: Readonly<Record<string, string>> = {
  workflow: 'Workflow', step: 'Step', processor: 'Processor', cache: 'Cache', assignment: 'Assignment', schema: 'Schema',
};

/** The entity a row names, by its unique name when this canvas holds it, else by its id. */
function entityLabel(e: DesignError, graph: Graph): string {
  const named = (x: { name: string; version: string; id: string } | undefined) => (x ? entityName(x.name, x.version, x.id) : e.id);
  switch (e.kind) {
    case 'workflow': return named(graph.workflow);
    case 'step': return named(graph.steps.get(e.id));
    case 'processor': return named(graph.processors.get(e.id));
    case 'cache': return named(graph.caches.get(e.id));
    default: return e.id;
  }
}

/**
 * Problems (plan 8 §4.1; plan 9 §2.2-7): the design's short circuits while they last, then the errors of the
 * active document's last Save, one row each: the entity, the field and the message. Clicking a row selects its
 * entity. Opening a workflow runs no dry run and errors are never stored, so only a short circuit shows then.
 */
export function Problems() {
  const active = useStudio(activeDocument);
  const store = useStudioStore();
  const guard = useGuard();
  // short circuits are the design's own (plan 9 §2.2-7): listed while they last, not only after a Save
  const live = useMemo(
    () => (active?.status.kind === 'ready' ? shortCircuitErrors(applyDesign(active.status.doc, active.design.draft, active.edits), active.design.draft) : []),
    [active?.status, active?.design.draft, active?.edits],
  );

  if (active === null) return <PaneNote pane="problems">Open a workflow to see its problems.</PaneNote>;
  if (active.status.kind === 'loading') return <PaneNote pane="problems">Loading…</PaneNote>;
  if (active.status.kind === 'failed') return <PaneNote pane="problems">Problems unavailable.</PaneNote>;
  const errors = [...live, ...(active.errors ?? []).filter((e) => !isShortCircuitError(e))];
  if (errors.length === 0) return <PaneNote pane="problems">No problems</PaneNote>;
  const { graph } = active.status.doc;

  return (
    <div className="paneBody" data-pane="problems">
      <div className="pbody" role="list" aria-label="Problems">
        {errors.map((error, i) => {
          const target = errorTarget(error, graph, active.edits);
          const choose = () => store.dispatch({ type: 'select', workflowId: active.workflowId, selection: target });
          // the selection it already is changes nothing, so it needs no asking; the dialog opens in this pane's window (spec §6.3)
          const select = target === null ? undefined
            : (from: Element) => (selectionKey(target) === selectionKey(active.selection) ? choose() : guard(active.workflowId, choose, from.ownerDocument));
          return (
            <div
              key={i}
              role="listitem"
              className={select ? 'prob' : 'prob static'}
              tabIndex={select ? 0 : undefined}
              onClick={select ? (e) => select(e.currentTarget) : undefined}
              onKeyDown={select ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e.currentTarget); } } : undefined}
              data-tip={select ? 'Select it' : undefined}
            >
              <span className="gate">{KIND[error.kind] ?? error.kind}</span>
              <b>{entityLabel(error, graph)}{error.field ? ` · ${error.field}` : ''}</b>
              <div className="pd">{error.message}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
