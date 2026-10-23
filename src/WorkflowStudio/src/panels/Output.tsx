import { useEffect, useMemo, useState } from 'react';
import { useGuard } from '../app/studioActions';
import type { StudioDocument } from '../app/document';
import type { DesignError } from '../model/graph';
import { errorPicks, errorTarget } from '../store/errorTarget';
import { entityLabel, problemsFrom, shownDesignOf } from '../store/problems';
import { selectionKey } from '../store/selection';
import { activeDocument, type OpenDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';

const timeOf = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};

const KIND: Readonly<Record<string, string>> = {
  workflow: 'Workflow', step: 'Step', processor: 'Processor', cache: 'Cache', assignment: 'Assignment', schema: 'Schema', wire: 'Wire',
};

/** The active document's problems, as `problemsFrom` lists them (store/problems.ts: the chat reads the same list). */
function useProblems(active: OpenDocument | null): { errors: DesignError[]; shown: StudioDocument | null } {
  const shown = useMemo(() => shownDesignOf(active), [active?.status, active?.design.draft, active?.edits]);
  const errors = useMemo(() => problemsFrom(active, shown), [shown, active?.status.kind, active?.errors]); // the draft is in `shown`'s inputs
  return { errors, shown };
}

/** The pinned problems: red rows at the top of Output; a row selects its entity, a wire row picks its wire(s). */
function PinnedProblems({ active, errors, shown }: { active: OpenDocument; errors: DesignError[]; shown: StudioDocument | null }) {
  const store = useStudioStore();
  const guard = useGuard();
  if (active.status.kind !== 'ready' || errors.length === 0) return null;
  // the drawing's graph: a pasted step's error is named as the canvas names it
  const { graph } = shown ?? active.status.doc;
  const loaded = active.status.doc.graph;
  return (
    <div className="pinned" role="list" aria-label="Problems">
      {errors.map((error, i) => {
        const target = errorTarget(error, graph, active.edits);
        // a wire row picks its wires on the canvas (both wires of an overlap)
        const picks = errorPicks(error);
        const choose = () => store.dispatch(picks ? { type: 'select', workflowId: active.workflowId, selection: null, picks } : { type: 'select', workflowId: active.workflowId, selection: target });
        // the selection it already is changes nothing, so it needs no asking; the dialog opens in this pane's window (spec §6.3)
        const select = picks ? (from: Element) => guard(active.workflowId, choose, from.ownerDocument)
          : target === null ? undefined
            : (from: Element) => (selectionKey(target) === selectionKey(active.selection) ? choose() : guard(active.workflowId, choose, from.ownerDocument));
        return (
          <div
            key={i}
            role="listitem"
            className={select ? 'prob err' : 'prob err static'}
            tabIndex={select ? 0 : undefined}
            onClick={select ? (e) => select(e.currentTarget) : undefined}
            onKeyDown={select ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e.currentTarget); } } : undefined}
            data-tip={select ? 'Select it' : undefined}
          >
            <span className="gate">{KIND[error.kind] ?? error.kind}</span>
            <b>{entityLabel(error, graph, shown, loaded)}{error.field ? ` · ${error.field}` : ''}</b>
            <div className="pd">{error.message}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Output (2026-10-09: the only message pane). Pinned at the top in red, the active document's current problems (as
 * the Problems pane listed them); below them the log of what Save, Start and Stop did and of every workflow that starts or
 * stops (2026-10-10), oldest first, each line with its
 * time and workflow, errors in red. The log is bounded and kept in the session.
 */
/** Output's own toolbar: Clear empties the log (all workflows); the pinned problems stay. */
const CLEAR_TIP = 'Clear the messages; current problems stay';

function OutputBar({ empty }: { empty: boolean }) {
  const store = useStudioStore();
  return (
    <div className="otools" role="toolbar" aria-label="Output">
      {empty
        // a disabled button shows no tip of its own: the span carries it
        ? <span data-tip={CLEAR_TIP}><button type="button" className="qb" aria-label="Clear output" disabled>Clear</button></span>
        : <button type="button" className="qb" aria-label="Clear output" data-tip={CLEAR_TIP} onClick={() => store.dispatch({ type: 'clearOutput' })}>Clear</button>}
    </div>
  );
}

export function Output() {
  const active = useStudio(activeDocument);
  const lines = useStudio((s) => s.output);
  const { errors, shown } = useProblems(active);
  const [log, setLog] = useState<HTMLDivElement | null>(null);
  // the newest line is at the bottom: every new line scrolls the log to its end (the user, 2026-10-12), even when it was
  // scrolled up to read; so does the log being shown or resized (a hidden tab brought forward, the pinned problems growing)
  const last = lines.length === 0 ? '' : `${lines.length}|${lines[lines.length - 1]!.at}|${lines[lines.length - 1]!.text}`;
  useEffect(() => {
    if (log) log.scrollTop = log.scrollHeight;
  }, [log, last]);
  useEffect(() => {
    if (!log) return undefined;
    const seen = new ResizeObserver(() => { log.scrollTop = log.scrollHeight; });
    seen.observe(log);
    return () => seen.disconnect();
  }, [log]);

  if (lines.length === 0 && errors.length === 0) {
    return (
      <div className="paneBody" data-pane="output">
        <OutputBar empty />
        <div className="pbody"><div className="note pane-note">Nothing yet. Each Save, Start and Stop says here what happened, and every workflow that starts or stops; current problems are pinned here.</div></div>
      </div>
    );
  }
  return (
    <div className="paneBody" data-pane="output">
      <OutputBar empty={lines.length === 0} />
      {active && <PinnedProblems active={active} errors={errors} shown={shown} />}
      <div
        ref={setLog}
        className="pbody"
        role="log"
        aria-label="Output"
      >
        {lines.map((l, i) => (
          <div key={i} className={l.level === 'error' ? 'outl err' : 'outl'} data-level={l.level}>
            <span className="t">{timeOf(l.at)}</span> <b>{l.name}</b> {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
