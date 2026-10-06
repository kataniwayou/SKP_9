import type { ReactNode } from 'react';

/**
 * A pane with one line of text: empty states, and the Output and Toolbox notes of slice 3a.
 * `pane` names the pane it belongs to (data-pane), so tests and styles can find it.
 */
export function PaneNote({ pane, children }: { pane: string; children: ReactNode }) {
  return (
    <div className="paneBody" data-pane={pane}>
      <div className="pbody"><div className="note pane-note">{children}</div></div>
    </div>
  );
}

/** Output, a real pane with nothing to show yet (spec §10, slice 3a). */
export function Output() {
  return <PaneNote pane="output">Output will show save and orchestration messages in a later version.</PaneNote>;
}

/** Toolbox, a real pane with nothing to show yet (spec §10, slice 3a). */
export function Toolbox() {
  return <PaneNote pane="toolbox">The toolbox arrives in a later version.</PaneNote>;
}
