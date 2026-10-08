import { CONDITIONS } from '../model/entryConditions';
import { ConditionMark } from './ConditionMark';

/** The colour key (spec §5.1, §5.3; plan 8 §5): loose wires; an unwired step looks like any other. */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value} className="lg-item">
          <ConditionMark info={c} />
          {c.name}
        </span>
      ))}
      <span className="lg-item" title={'Loose wire: dropped where it attaches to nothing.\nNot part of the workflow until its open end is dropped on a step.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <path className="lg-loose" d="M1 7H21" />
          <circle className="lg-open" cx="25" cy="7" r="3.5" />
        </svg>
        loose wire
      </span>
    </div>
  );
}
