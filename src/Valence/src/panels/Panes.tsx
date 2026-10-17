import { useEffect, useRef } from 'react';
import { useWorkspace, type Workspace } from '../app/workspace';
import { PaneNote } from './PaneNote';
export { Toolbox } from './Toolbox';

/**
 * The Output pane: what Valence did and refused (spec §6) — deletions, refusals with their reason, undo and redo — one
 * line each, the newest at the bottom, scrolled into view.
 */
export function Output({ workspace }: { workspace: Workspace }) {
  const messages = useWorkspace(workspace, (s) => s.messages);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [messages]);
  if (messages.length === 0) return <PaneNote pane="output">No messages.</PaneNote>;
  return (
    <div className="paneBody" data-pane="output">
      <div className="pbody out-log" role="log" aria-label="Output">
        {messages.map((m) => (
          <div key={m.id} className={m.tone === 'refused' ? 'out-line refused' : 'out-line'}>
            <time dateTime={m.at}>{m.at.slice(11, 19)}</time><span>{m.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
