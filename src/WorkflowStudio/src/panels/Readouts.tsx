import { useMemo } from 'react';
import { wireName } from '../design/wireName';
import type { OpenDocument } from '../store/studioState';
import { graphReadout, readoutModel, wireReadout, type GraphLink } from './readout';

/**
 * The model of the read-outs, built only while one is shown, and again only when the drawing changes (a committed
 * canvas change, an Inspector edit, a reload): a gesture's preview never reaches the store, so it costs nothing.
 */
function useReadoutModel(open: OpenDocument) {
  const base = open.status.kind === 'ready' ? open.status.doc : null;
  return useMemo(() => (base ? readoutModel(base, open.design.draft, open.edits) : null), [base, open.design.draft, open.edits]);
}

/** The picked wire read as text (the user's request, 2026-10-09): plain rows, names as plain text. */
export function WireReadoutPane({ open, id }: { open: OpenDocument; id: string }) {
  const model = useReadoutModel(open);
  const r = useMemo(() => (model ? wireReadout(model, id) : null), [model, id]);
  return (
    <div className="paneBody" data-pane="inspector">
      <div className="ph2"><span className="kindpill">WIRE</span></div>
      <div className="pbody">
        <div className="sec readout">
          {r === null ? (
            // undo or redo can leave a pick naming a wire that is gone: named from its id
            <>
              <div className="uname" aria-label="Wire name"><span className="rt">{(model && wireName(model.shown, id)) ?? id}</span></div>
              <p className="note">This wire is not drawn.</p>
            </>
          ) : (
            <>
              <div className="uname" aria-label="Wire name"><span className="rt">{r.name}</span></div>
              <dl aria-label="Wire read-out">
                {r.rows.map((row) => (
                  <div key={row.label} className="rrow" data-row={row.label}>
                    <dt>{row.label}</dt>
                    {Array.isArray(row.value)
                      ? <dd><ul>{row.value.map((v, i) => <li key={i}>{v}</li>)}</ul></dd>
                      : <dd>{row.value}</dd>}
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const Links = ({ links }: { links: readonly GraphLink[] }) => (links.length === 0 ? <span className="none">none</span> : (
  <ul className="links">
    {links.map((l) => (
      <li key={`${l.id}${l.held ? ':held' : ''}`} data-step={l.id} className={l.held ? 'held' : undefined}>
        {l.name}{l.held ? ' (held back)' : ''}
      </li>
    ))}
  </ul>
));

const HELD_NOTE = 'held back by a short circuit: Save keeps BaseApi\'s list';

/** The workflow's graph read as text, under its fields (the user's request, 2026-10-09). */
export function GraphReadoutSection({ open }: { open: OpenDocument }) {
  const model = useReadoutModel(open);
  const g = useMemo(() => (model ? graphReadout(model) : null), [model]);
  if (g === null) return null;
  return (
    <section className="sec readout" aria-label="Graph">
      <div className="sec-title">Graph</div>
      <dl>
        <div className="rrow" data-row="Entry steps">
          <dt>Entry steps</dt>
          <dd>
            {g.entries.length === 0 ? <span className="none">none</span> : (
              <ul className="links">
                {g.entries.map((l) => (
                  <li key={`${l.id}${l.held ? ':held' : ''}`} data-step={l.id} className={l.held ? 'held' : undefined}>
                    {l.name} · {l.condition}{l.held ? ' (held back)' : ''}
                  </li>
                ))}
              </ul>
            )}
            {g.entriesHeldBack && <div className="rnote">{HELD_NOTE}</div>}
          </dd>
        </div>
      </dl>
      <table className="rtable" aria-label="Steps">
        <thead><tr><th scope="col">Step</th><th scope="col">Entry</th><th scope="col">Next steps</th></tr></thead>
        <tbody>
          {g.steps.map((s) => (
            <tr key={s.id} data-step={s.id}>
              <th scope="row">{s.name}</th>
              <td>{s.condition}</td>
              <td><Links links={s.next} />{s.heldBack && <div className="rnote">{HELD_NOTE}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl aria-label="Graph problems">
        {g.problems.length === 0
          ? <div className="rrow" data-row="Problems"><dt>Problems</dt><dd>none</dd></div>
          : g.problems.map((p) => (
            <div key={p.label} className="rrow" data-row={p.label}>
              <dt>{p.label}</dt>
              <dd>{p.names.length}<ul>{p.names.map((n, i) => <li key={i}>{n}</li>)}</ul></dd>
            </div>
          ))}
      </dl>
    </section>
  );
}
