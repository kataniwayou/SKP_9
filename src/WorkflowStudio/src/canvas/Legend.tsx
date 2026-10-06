import { CONDITIONS } from '../model/entryConditions';

/** The colour key (mockup v49, the legend builder): each entry condition, broken and parked. */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value}>
          <span className="pill" style={{ background: c.colour }}>{c.letter}</span>
          <i style={{ borderColor: c.colour }} />
          {c.name}
        </span>
      ))}
      <span title={'Broken wire: Out schema ≠ In schema.\nAny wire can break, whatever its colour.'}>
        <svg width="28" height="14" viewBox="0 0 28 14" style={{ verticalAlign: 'middle', marginRight: 6 }}>
          <path d="M1 7 H9 M19 7 H27" stroke="#9FB0C8" strokeWidth="2" strokeDasharray="4 2.5" />
          <text x="14" y="11" fontSize="10" textAnchor="middle" fill="#9FB0C8">⚠</text>
        </svg>
        broken
      </span>
      <span title={'Parked step: placed but not wired in,\nso not part of the workflow.'}>
        <svg width="20" height="14" viewBox="0 0 20 14" style={{ verticalAlign: 'middle', marginRight: 6 }}>
          <rect x="1.5" y="1.5" width="17" height="11" rx="2.5" fill="none" stroke="#6B7A90" strokeWidth="1.4" strokeDasharray="3 2" />
        </svg>
        parked
      </span>
    </div>
  );
}
