import type { Bar } from './selectionBar';

export interface BarActions {
  copy(): void; del(): void;
  restore(): void; remove(): void;
  start(): void; stop(): void;
}

/** The light bar for several picks, pinned top-centre of the board (inside a React Flow Panel). */
export function SelectionBar({ bar, actions }: { bar: Bar; actions: BarActions }) {
  const any = bar.copy || bar.del || bar.restore || bar.remove || bar.run;
  return (
    <div className="selbar nodrag nopan" role="toolbar" aria-label="selection actions">
      <span className="selbar-pill">{bar.count} SELECTED</span>
      {!any && <span className="selbar-text">no action in common</span>}
      {bar.restore && <button type="button" onClick={actions.restore}>Restore</button>}
      {bar.remove && <button type="button" className="danger" onClick={actions.remove}>Remove</button>}
      {bar.run && <button type="button" className="go" onClick={actions.start}>▶ Start</button>}
      {bar.run && <button type="button" className="stop" onClick={actions.stop}>■ Stop</button>}
      {bar.copy && <button type="button" onClick={actions.copy}>Copy</button>}
      {bar.del && <button type="button" className="danger" onClick={actions.del}>Delete</button>}
    </div>
  );
}
