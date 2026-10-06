import { useGuard } from '../app/studioActions';
import { problemTarget } from '../store/problemTarget';
import { selectionKey } from '../store/selection';
import { activeDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { PaneNote } from './PaneNote';

/**
 * Problems (spec §7.3, slice 3a): the active document's validate result, gate, title and detail.
 * A problem that names an entity of this document selects it when clicked; the Inspector follows.
 */
export function Problems() {
  const active = useStudio(activeDocument);
  const store = useStudioStore();
  const guard = useGuard();

  if (active === null) return <PaneNote pane="problems">Open a workflow to see its problems.</PaneNote>;
  if (active.status.kind === 'loading') return <PaneNote pane="problems">Loading…</PaneNote>;
  if (active.status.kind === 'failed') return <PaneNote pane="problems">Problems unavailable.</PaneNote>;
  const { doc } = active.status;
  if (doc.problems === null) return <PaneNote pane="problems">Problems unavailable.</PaneNote>;
  if (doc.problems.length === 0) return <PaneNote pane="problems">No problems</PaneNote>;

  return (
    <div className="paneBody" data-pane="problems">
      <div className="pbody" role="list" aria-label="Problems">
        {doc.problems.map((problem, i) => {
          const target = problemTarget(problem, doc.graph);
          const choose = () => store.dispatch({ type: 'select', workflowId: active.workflowId, selection: target });
          // the selection it already is changes nothing, so it needs no asking; the dialog opens in this pane's window (spec §6.3)
          const select = target === null ? undefined
            : (from: Element) => (selectionKey(target) === selectionKey(active.selection) ? choose() : guard(active.workflowId, choose, from.ownerDocument));
          return (
            <div
              key={i}
              role="listitem"
              className={target === null ? 'prob static' : 'prob'}
              tabIndex={select ? 0 : undefined}
              onClick={select ? (e) => select(e.currentTarget) : undefined}
              onKeyDown={select ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e.currentTarget); } } : undefined}
              data-tip={target === null ? undefined : 'Select it'}
            >
              <span className="gate">{problem.gate}</span>
              <b>{problem.title}</b>
              <div className="pd">{problem.detail}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
