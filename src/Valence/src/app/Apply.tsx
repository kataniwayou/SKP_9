import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apply as applyChanges, isStale, type Applied } from '../api/validate';
import { canvasBridge } from '../molecule/bridge';
import { createdStates, editStates } from '../molecule/fields';
import { TYPES } from '../molecule/model';
import { atomOfChange } from '../molecule/plan';
import { dryRunLine, verdictOf } from '../molecule/verdict';
import { appliedLine, summarize, type ApplySummary, type ChangeRow } from './changes';
import { useWorkspace, type Workspace } from './workspace';

/**
 * Where the project document reads the project again after an apply, keeping the canvas as it stands (the camera, every
 * atom's place, the made atoms' places under their real ids). Set by ProjectDocument while it is mounted.
 */
export const applyBridge: { reload: ((rename: ReadonlyMap<string, string>, line: string) => Promise<void>) | null } = { reload: null };

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const MODE: Readonly<Record<ChangeRow['mode'], { title: string; cls: string }>> = {
  new: { title: 'New — green halo · created', cls: 'n' },
  updated: { title: 'Updated — amber halo · its row rewritten', cls: 'u' },
  deleted: { title: 'Deleted — red ghost · removed, with its arrows', cls: 'd' },
};

/** Whether the changes may be applied now, and if not, why (the button's tooltip; the chat's refusal). */
export function readiness(workspace: Workspace, summary: ApplySummary | null): { ready: boolean; tip: string } {
  const s = workspace.get();
  const n = summary?.rows.length ?? 0;
  if (!summary || n === 0) return { ready: false, tip: 'Nothing to apply.' };
  const dry = s.dryRun;
  if (dry.kind === 'unavailable') return { ready: false, tip: `Apply waits for BaseApi's dry run, which is not available: ${dry.reason}` };
  if (dry.kind !== 'done') return { ready: false, tip: 'Checking the changes with BaseApi…' };
  if (!dry.ok) return { ready: false, tip: `BaseApi's dry run refuses ${dry.refused} change${dry.refused === 1 ? '' : 's'}: fix ${dry.refused === 1 ? 'it' : 'them'} first (the marked atoms say why).` };
  const table = s.rules.table;
  const createdKeys = new Set(s.created.map((c) => c.key));
  const plain = Object.fromEntries(Object.entries(s.edits).filter(([k]) => !createdKeys.has(k)));
  const unfinished = (s.molecule ? editStates(table, s.molecule, plain, s.removed, new Set()).unfinished.size : 0)
    + (s.data && s.molecule ? createdStates(table, s.data, s.molecule, s.edits, createdKeys, new Set()).unfinished.size : 0);
  if (unfinished > 0) return { ready: false, tip: `${unfinished} unfinished change${unfinished === 1 ? '' : 's'}: fill in the marked fields first.` };
  return { ready: true, tip: `Apply ${n} change${n === 1 ? '' : 's'} to BaseApi: all of them, or none.` };
}

/**
 * The Apply button, right of the menu strip beside the Workflows filter (the user, 2026-10-17, preview approved): the
 * number of changed atoms; greyed, with the reason as its tooltip, until BaseApi's dry run passes every change and
 * nothing is unfinished. A click opens the confirmation.
 */
export function ApplyButton({ workspace }: { workspace: Workspace }) {
  const data = useWorkspace(workspace, (s) => s.data);
  const molecule = useWorkspace(workspace, (s) => s.molecule);
  const edits = useWorkspace(workspace, (s) => s.edits);
  const removed = useWorkspace(workspace, (s) => s.removed);
  const created = useWorkspace(workspace, (s) => s.created);
  const added = useWorkspace(workspace, (s) => s.added);
  const rules = useWorkspace(workspace, (s) => s.rules);
  const dryRun = useWorkspace(workspace, (s) => s.dryRun);
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarize({ ...workspace.get(), data, molecule, edits, removed, created, added, rules }), [workspace, data, molecule, edits, removed, created, added, rules]);
  const { ready, tip } = useMemo(() => readiness(workspace, summary), [workspace, summary, dryRun]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = summary?.rows.length ?? 0;
  // a change while the confirmation is open makes it stale: it closes, and the button is read again
  useEffect(() => { if (!ready) setOpen(false); }, [ready]);
  return (
    <>
      <button type="button" className={ready ? 'ap-b' : 'ap-b off'} aria-disabled={!ready} data-tip={tip} aria-label={ready ? `Apply ${n} changes` : `Apply: ${tip}`}
        onClick={() => { if (ready) setOpen(true); }}>
        Apply{n > 0 ? ` ${n}` : ''}
      </button>
      {open && summary && <ApplyDialog workspace={workspace} summary={summary} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Sends every change to BaseApi (all or nothing) and says what came of it in the Output pane: applied (the project read
 * again, the made atoms under their real ids), refused (BaseApi's reasons on the atoms), or not available. The dialog's
 * Apply and the chat's apply_changes both end here. Returns whether it was applied, and the Output line.
 */
export async function applySummary(workspace: Workspace, summary: ApplySummary): Promise<{ applied: boolean; line: string }> {
  const { rows, planned } = summary;
  const s = workspace.get();
  const answer: Applied = await applyChanges(planned);
  const nameOf = (atom: string) => s.edits[atom]?.name || s.molecule?.atoms.get(atom)?.name || atom;
  if (answer.kind === 'applied') {
    // the made atoms' client keys → the keys BaseApi's ids give them
    const rename = new Map<string, string>();
    for (const [client, real] of Object.entries(answer.made)) {
      const c = s.created.find((x) => x.id === client);
      if (c) rename.set(c.key, `${c.type}:${real}`);
    }
    canvasBridge.get()?.rekey(rename);
    const line = appliedLine(rows);
    if (applyBridge.reload) await applyBridge.reload(rename, line);
    else workspace.applied(null, null, rename, line);
    return { applied: true, line };
  }
  if (answer.kind === 'refused') {
    const state = verdictOf(planned, { kind: 'done', ok: false, results: answer.results }, s.rules.fields);
    const stale = answer.results.filter(isStale).map((r) => nameOf(atomOfChange(r.table, r.id) ?? r.id));
    const line = stale.length
      ? `Nothing applied: ${stale.join(', ')} changed in BaseApi since you loaded ${stale.length === 1 ? 'it' : 'them'}. Refresh (your changes are kept), then apply again.`
      : `Apply refused, nothing applied: ${(dryRunLine(state, planned, nameOf) ?? '').replace(/^Dry run by BaseApi: /, '')}`;
    workspace.judged(state, line);
    return { applied: false, line };
  }
  const line = `Apply: not available (${answer.reason}); nothing applied.`;
  workspace.note(line, 'refused');
  return { applied: false, line };
}

/**
 * The confirmation: every change, grouped as the canvas shows it (green new, amber updated, red deleted), what changes
 * and the workflows it affects. Apply sends them all; BaseApi keeps all of them or none. Escape or Cancel closes it.
 */
function ApplyDialog({ workspace, summary, onClose }: { workspace: Workspace; summary: ApplySummary; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [busy, onClose]);
  const { rows, affects } = summary;
  const count = (m: ChangeRow['mode']) => rows.filter((r) => r.mode === m).length;

  const go = async () => {
    setBusy(true);
    try { await applySummary(workspace, summary); } finally { setBusy(false); }
    onClose();
  };

  return createPortal(
    <div className="ap-veil">
      <div className="ap-dlg" role="dialog" aria-modal="true" aria-label="Apply changes">
        <div className="ap-h">
          <div className="ap-t">Apply {rows.length} change{rows.length === 1 ? '' : 's'} to BaseApi?</div>
          <div className="ap-sum">
            {count('new') > 0 && <span className="ap-chip n">● {count('new')} new</span>}
            {count('updated') > 0 && <span className="ap-chip u">● {count('updated')} updated</span>}
            {count('deleted') > 0 && <span className="ap-chip d">● {count('deleted')} deleted</span>}
            <span className="ap-chip">{affects.length ? `affects ${affects.length} workflow${affects.length === 1 ? '' : 's'}` : 'affects no workflow'}</span>
            {affects.map((w) => <span key={w} className="ap-chip w">{w}</span>)}
          </div>
        </div>
        <div className="ap-body">
          {(['new', 'updated', 'deleted'] as const).filter((m) => count(m) > 0).map((m) => (
            <section key={m} className="ap-grp" aria-label={MODE[m].title}>
              <h3 className={`ap-gt ${MODE[m].cls}`}><span className="ap-halo" />{MODE[m].title}</h3>
              {rows.filter((r) => r.mode === m).map((r) => (
                <div key={r.key} className={`ap-row ${MODE[m].cls}`} data-atom={r.key}>
                  <div className="ap-who"><i className="ap-dot" style={{ background: hex(TYPES[r.type].color) }} /><span className="ap-nm">{r.name}</span><span className="ap-ty">{TYPES[r.type].label.toLowerCase()}</span></div>
                  <div className="ap-what">{r.what.join(' · ')}</div>
                  <div className="ap-aff">{r.affects.length ? r.affects.map((w) => <span key={w} className="ap-chip w">{w}</span>) : <span className="ap-none">no workflow yet</span>}</div>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="ap-f">
          <div className="ap-note">All or nothing: BaseApi applies every change in one transaction, or none. A row changed in BaseApi since you loaded it stops the apply (refresh, then apply again).</div>
          <button type="button" className="ap-btn" ref={cancel} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="ap-btn go" disabled={busy} onClick={() => void go()}>{busy ? 'Applying…' : `Apply ${rows.length} change${rows.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
