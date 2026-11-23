import { useLayoutEffect, useRef } from 'react';
import { useOutputState, type Level } from './outputStore';
import { HideButton } from '../shell/HideButton';

const KIND: Record<Level, string> = { info: '', ok: 'k-ok', warn: 'k-warn', error: 'k-err' };

export function OutputPanel() {
  const { lines, newestFirst, store } = useOutputState();
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && !newestFirst) el.scrollTop = el.scrollHeight;
  }, [lines, newestFirst]);
  const shown = newestFirst ? [...lines].reverse() : lines;
  const count = lines.length === 0 ? '' : lines.length === 1 ? '1 message' : `${lines.length} messages`;
  return (
    <>
      <div className="ph">
        <span>Output</span>
        <span className="cnt">{count}</span>
        <span className="sp" />
        <span className="seg2">
          <button type="button" className={`pbtn${newestFirst ? '' : ' on'}`} aria-pressed={!newestFirst}
            onClick={() => store.setNewestFirst(false)}>Newest last</button>
          <button type="button" className={`pbtn${newestFirst ? ' on' : ''}`} aria-pressed={newestFirst}
            onClick={() => store.setNewestFirst(true)}>Newest first</button>
        </span>
        <button type="button" className="pbtn" onClick={() => store.clear()}>Clear all</button>
        <HideButton />
      </div>
      <div className="pb log" ref={body}>
        {lines.length === 0 ? <p className="none">No messages.</p> : (
          <div role="list">
            {shown.map((l, i) => (
              <div className="row" role="listitem" key={newestFirst ? lines.length - i : i}>
                <time>{l.at}</time><span className={KIND[l.level]}>{l.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
