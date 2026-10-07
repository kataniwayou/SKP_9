import { CONDITIONS } from '../model/entryConditions';
import { ConditionMark } from './ConditionMark';

/** The colour key (spec §5.1, §5.3): icons drawn like the canvas. Junctions join it with plan 7. */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value} className="lg-item">
          <ConditionMark info={c} />
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
