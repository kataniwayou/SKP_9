import { activeDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { inspectorView, type Row } from './inspectorView';
import { PaneNote } from './PaneNote';

/** Read-only text: one line, cut with an ellipsis, its full text a tooltip only when cut (spec §7). */
function Value({ row }: { row: Row }) {
  return (
    <span className={row.empty ? 'ro null' : 'ro'} data-tipcut={row.value}>
      {row.dot && <span className="dot" style={{ background: row.dot }} />}
      {row.value}
    </span>
  );
}

const field = (row: Row) => (
  <div key={row.label} className="field"><label>{row.label}</label><Value row={row} /></div>
);

/**
 * The shared Inspector, read-only in slice 3a (spec §7; editing is 3b). It follows the active
 * document's selection, whether the pane is docked, floating, popped out or auto-hidden.
 */
export function Inspector() {
  const active = useStudio(activeDocument);
  const showDetails = useStudio((s) => s.showDetails);
  const store = useStudioStore();

  if (active === null) return <PaneNote pane="inspector">Open a workflow to inspect it.</PaneNote>;
  if (active.status.kind === 'loading') return <PaneNote pane="inspector">Loading…</PaneNote>;
  if (active.status.kind === 'failed') return <PaneNote pane="inspector">{active.status.message}</PaneNote>;
  const view = inspectorView(active.status.doc, active.selection);
  if (view === null) return <PaneNote pane="inspector">Nothing selected. Click a step, a processor, a cache or the workflow.</PaneNote>;

  return (
    <div className="paneBody" data-pane="inspector">
      <div className="ph2"><span className="kindpill">{view.kind}</span></div>
      <div className="pbody">
        <div className="sec">
          <div className="uname" aria-label="Unique name"><span className="ro" data-tipcut={view.uniqueName}>{view.uniqueName}</span></div>
          <div className="sec-title">{view.title}</div>
          {view.head.map(field)}
          <div className="metatog">
            <button type="button" className="link" onClick={() => store.dispatch({ type: 'toggleDetails' })}>
              {showDetails ? '▾ hide details' : '▸ show all'}
            </button>
          </div>
          {showDetails && <div className="meta">{view.details.map(field)}</div>}
          {view.fields.map(field)}
          {view.note && <div className="note warn">{view.note}</div>}
        </div>
        {view.slots && (
          <div className="sec">
            <div className="sec-title">Schemas</div>
            {view.slots.map((slot) => (
              <div key={slot.label} className="slot">
                <span className="k">{slot.label}</span>
                <span className={slot.empty ? 'v null' : 'v'} data-tipcut={slot.value}>{slot.value}</span>
                <span />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
