import type { ReactNode } from 'react';

/**
 * A pane with one line of text: empty states.
 * `pane` names the pane it belongs to (data-pane), so tests and styles can find it.
 */
export function PaneNote({ pane, children }: { pane: string; children: ReactNode }) {
  return (
    <div className="paneBody" data-pane={pane}>
      <div className="pbody"><div className="note pane-note">{children}</div></div>
    </div>
  );
}
