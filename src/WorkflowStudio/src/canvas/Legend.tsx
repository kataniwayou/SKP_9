import { CONDITIONS } from '../model/entryConditions';
import { ConditionMark } from './ConditionMark';

/**
 * The colour key (spec §5.1, §5.3; plan 9 §5): the families and the short circuit. The undecided wire (grey, dashed)
 * is left out (the user, 2026-10-22); the canvas still draws it so.
 */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value} className="lg-item">
          <ConditionMark info={c} />
          {c.name}
        </span>
      ))}
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
