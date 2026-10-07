import type { CSSProperties } from 'react';
import type { ConditionInfo } from '../model/entryConditions';

/** An entry condition drawn as the legend draws it: its letter pill and a wire in its colour. */
export function ConditionMark({ info }: { info: ConditionInfo }) {
  return (
    <span className="cmark" aria-hidden="true">
      <span className="pill" style={{ background: info.colour }}>{info.letter}</span>
      <svg width="26" height="12" viewBox="0 0 26 12" className="lg-icon" style={{ '--nc': info.colour } as CSSProperties}>
        <circle className="lg-src" cx="3" cy="6" r="2" />
        <path className="lg-w" d="M5 6H23" stroke={info.colour} />
        <path className="lg-head" d="M18 2.5L23 6L18 9.5" stroke={info.colour} />
      </svg>
    </span>
  );
}
