import type { Bar } from './selectionBar';

export interface BarActions { copy(): void; del(): void }

/** The light bar for several picks, pinned top-centre of the board (inside a React Flow Panel). */
export function SelectionBar({ bar, actions }: { bar: Bar; actions: BarActions }) {
  return (
    <div className="selbar nodrag nopan" role="toolbar" aria-label="selection actions">
      <span className="selbar-pill">{bar.count} SELECTED</span>
      {!bar.copy && !bar.del && <span className="selbar-text">no action in common</span>}
      {bar.copy && <button type="button" onClick={actions.copy}>Copy</button>}
      {bar.del && <button type="button" className="danger" onClick={actions.del}>Delete</button>}
    </div>
  );
}
