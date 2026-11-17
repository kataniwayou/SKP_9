import type { Id } from '../model/graph';
import type { Bar } from './selectionBar';

export interface BarActions {
  copy(): void;
  deleteParts(): void;
  start(ids: Id[]): void;
  stop(ids: Id[]): void;
  save(ids: Id[]): void;
  deleteWorkflows(): void;
}
export interface BarConfirm { text: string; onConfirm: () => void; onCancel: () => void }

/** The light bar for several picks, pinned top-centre of the board (inside a React Flow Panel). */
export function SelectionBar({ bar, actions, confirm }: { bar: Bar; actions: BarActions; confirm?: BarConfirm }) {
  return (
    <div className="selbar nodrag nopan" role="toolbar" aria-label="selection actions">
      <span className="selbar-pill">{bar.count} SELECTED</span>
      {bar.kind === 'mixed' && <span className="selbar-text">no action in common</span>}
      {bar.kind === 'parts' && <>
        <button type="button" onClick={actions.copy}>Copy</button>
        <button type="button" className="danger" onClick={actions.deleteParts}>Delete</button>
      </>}
      {bar.kind === 'workflows' && (confirm
        ? <>
          <span className="selbar-text">{confirm.text}</span>
          <button type="button" className="primary danger" onClick={confirm.onConfirm}>Delete</button>
          <button type="button" onClick={confirm.onCancel}>Cancel</button>
        </>
        : <>
          {bar.start.length > 0 && <button type="button" className="go" onClick={() => actions.start(bar.start)}>▶ Start {bar.start.length}</button>}
          {bar.stop.length > 0 && <button type="button" className="stop" onClick={() => actions.stop(bar.stop)}>■ Stop {bar.stop.length}</button>}
          {bar.start.length + bar.stop.length > 0 && <span className="sep" />}
          {bar.save.length > 0 && <button type="button" className="primary" onClick={() => actions.save(bar.save)}>Save {bar.save.length}</button>}
          <button type="button" className="danger" onClick={actions.deleteWorkflows}>Delete</button>
        </>)}
    </div>
  );
}
