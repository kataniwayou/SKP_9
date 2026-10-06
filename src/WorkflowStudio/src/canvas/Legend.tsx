import type { CSSProperties } from 'react';
import { CONDITIONS } from '../model/entryConditions';

/** The colour key (spec §5.1, §5.3): icons drawn like the canvas. Junctions join it with plan 7. */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value} className="lg-item">
          <span className="pill" style={{ background: c.colour }}>{c.letter}</span>
          <svg width="26" height="12" viewBox="0 0 26 12" className="lg-icon" style={{ '--nc': c.colour } as CSSProperties} aria-hidden="true">
            <circle className="lg-src" cx="3" cy="6" r="2" />
            <path className="lg-w" d="M5 6H23" stroke={c.colour} />
            <path className="lg-head" d="M18 2.5L23 6L18 9.5" stroke={c.colour} />
          </svg>
          {c.name}
        </span>
      ))}
      <span className="lg-item" title={'Broken wire: Out schema ≠ In schema.\nAny wire can break, whatever its colour.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <path className="lg-dash" d="M1 7H10 M20 7H29" />
          <text className="lg-warn" x="15" y="11" textAnchor="middle">⚠</text>
        </svg>
        broken
      </span>
      <span className="lg-item" title={'Parked step: placed but not wired in,\nso not part of the workflow.'}>
        <svg width="22" height="16" viewBox="0 0 22 16" className="lg-icon" aria-hidden="true">
          <path className="lg-parked" d="M3 1H8L9 2H13L14 1H19L21 3V13L19 15H14L13 14H9L8 15H3L1 13V3Z" />
        </svg>
        parked
      </span>
    </div>
  );
}
