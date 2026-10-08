import { useStudio } from '../store/studioStore';
import { PaneNote } from './PaneNote';

const timeOf = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};

/** Output (plan 8 §4.1): one line per Save answer, with its time and workflow, oldest first. */
export function Output() {
  const lines = useStudio((s) => s.output);
  if (lines.length === 0) return <PaneNote pane="output">Nothing yet. Each Save says here what happened.</PaneNote>;
  return (
    <div className="paneBody" data-pane="output">
      <div className="pbody" role="log" aria-label="Output">
        {lines.map((l, i) => (
          <div key={i} className="outl"><span className="t">{timeOf(l.at)}</span> <b>{l.name}</b> {l.text}</div>
        ))}
      </div>
    </div>
  );
}
