import { CONDITIONS } from '../model/entryConditions';
import { ConditionMark } from './ConditionMark';

/** The colour key (spec §5.1, §5.3; plan 9 §5): the families, the undecided wire and the short circuit. */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value} className="lg-item">
          <ConditionMark info={c} />
          {c.name}
        </span>
      ))}
      <span className="lg-item" title={'Undecided: no head on a step decides this wire\'s family yet.\nGrey and dashed; it joins any wire, and takes the colour of the first that decides.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <circle className="lg-ring" cx="3" cy="7" r="2.2" />
          <path className="lg-undecided" d="M5 7H26" />
          <path className="lg-arrow" d="M21 3L26 7L21 11" />
        </svg>
        undecided
      </span>
      <span className="lg-item" title={'Short circuit: wires of two families meet at a junction.\nIts links are not written on Save; change an entry condition or move the wire.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <path className="lg-line" d="M1 7H29" />
          <circle className="lg-short" cx="15" cy="7" r="3.5" />
        </svg>
        short circuit
      </span>
    </div>
  );
}
