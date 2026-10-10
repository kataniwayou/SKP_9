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
      <span className="lg-item" title={'Short circuit: one net carrying two meanings, drawn red:\n'
        + '• a junction joins wires of two families (e.g. Completed meets Failed)\n'
        + '• a junction closes a loop of wires\n'
        + '• a wire lies on a wire of another net (a grey wire on a coloured one too);\n'
        + '  wires of one net may share a line, and the router\'s own wires never count.\n'
        + 'Listed in red in Output. Save keeps BaseApi\'s next steps for the steps it touches;\n'
        + 'change an entry condition or move the wire.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <path className="lg-line" d="M1 7H29" />
          <circle className="lg-short" cx="15" cy="7" r="3.5" />
        </svg>
        short circuit
      </span>
    </div>
  );
}
