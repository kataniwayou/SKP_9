import type { LiveStatus } from '../api/liveStatus';
import { ZoomControls } from '../canvas/ZoomControls';
import { entityName } from '../model/entityNames';
import type { Workflow } from '../model/graph';
import type { RunOp } from '../store/run';
import { Spinner, useMinShown } from './Spinner';

const NOT_YET = 'Not available yet';

function StatusPill({ status, pending }: { status: LiveStatus; pending: RunOp | null }) {
  if (pending === 'start') return <span className="unknown">starting…</span>;
  if (pending === 'stop') return <span className="unknown">stopping…</span>;
  switch (status) {
    case 'running': return <span className="run-chip">▶ running</span>;
    case 'stopped': return <span className="stopped">■ stopped</span>;
    case 'unknown': return <span className="unknown" data-tip="BaseApi could not say whether it runs">status unknown</span>;
    case 'checking': return <span className="unknown">checking…</span>;
  }
}

/** Start's and Stop's tips while they can be pressed: both act on what BaseApi holds, not on the drawing. */
const RUN_TIP: Readonly<Record<RunOp, string>> = {
  start: 'Start the saved workflow (what BaseApi holds, not the drawing) (F5)',
  stop: 'Stop the workflow (Shift+F5)',
};

/**
 * A document's capsule toolbar (spec §6.1, mockup v49 .docbar): its name, cron, run status, Save,
 * Start and Stop, and its own zoom and Fit. Save stores the design (plan 8 §4.1); Start and Stop act on the
 * saved workflow (2026-10-09). It must be rendered inside the document's WorkflowCanvas, for ZoomControls.
 */
export function CapsuleToolbar({ workflow, status, save, design, run, ai }: {
  workflow: Workflow; status: LiveStatus;
  /**
   * Start and Stop (2026-10-09): why each cannot be pressed now (null: it can), the press in progress, and the
   * presses. Absent: both disabled.
   */
  run?: { blocked: Readonly<Record<RunOp, string | null>>; pending: RunOp | null; onStart: () => void; onStop: () => void };
  /** The design's Save (plan 8 §4.1): enabled when the design differs from the base; read-only while it runs. */
  save?: { blocked: string | null; changed: boolean; saving: boolean; onSave: () => void };
  /** The design draft (plan 4): its mark, Undo, Redo and Discard. */
  design?: { dirty: boolean; /** A Save is in flight. */ locked: boolean; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onDiscard: () => void };
  /** AI drawing (2026-10-11): the model redraws the design; applied only if the relations stay the same. */
  ai?: { running: boolean; seconds: number; blocked: string | null; onDraw: () => void; onCancel: () => void };
}) {
  return (
    <div className="docbar" role="toolbar" aria-label="Workflow">
      <div className="cap-b crumb" data-tip={entityName(workflow.name, workflow.version, workflow.id)}>
        <b>{workflow.name}</b><span className="ver">_{workflow.version}</span>
      </div>
      <span className="cap-b chip">⏱ {workflow.cronExpression || 'not scheduled'}</span>
      <div className="cap-b stat" aria-label="Status"><StatusPill status={status} pending={run?.pending ?? null} /></div>
      {design?.dirty && <span className="cap-b dirtyl">● design draft</span>}
      <span className="spacer" />
      <div className="docact">
        {design && (
          <>
            <button type="button" className="qb" disabled={design.locked || !design.canUndo} onClick={design.onUndo} data-tip="Undo (Ctrl+Z)">↶ Undo</button>
            <button type="button" className="qb" disabled={design.locked || !design.canRedo} onClick={design.onRedo} data-tip="Redo (Ctrl+Y)">↷ Redo</button>
            <button type="button" className="qb" disabled={design.locked || !design.dirty} onClick={design.onDiscard} data-tip="Drop every design change in this workflow">Discard design</button>
            <span className="qsep" />
            {ai && (ai.running
              ? <button type="button" className="qb" aria-busy aria-label="AI drawing: cancel" onClick={ai.onCancel} data-tip="The model is drawing; click to cancel"><Spinner /> Cancel · {ai.seconds} s</button>
              : <button type="button" className="qb" aria-label="AI drawing" disabled={design.locked || ai.blocked !== null} onClick={ai.onDraw}
                data-tip={ai.blocked ?? 'AI drawing: redraw the workflow by the drawing rules (applied only if every relation between the steps stays the same)'}><WandIcon /></button>)}
            {ai && <span className="qsep" />}
          </>
        )}
        <SaveButton save={save} />
        <span className="qsep" />
        <RunButton op="start" run={run} />
        <RunButton op="stop" run={run} />
      </div>
      <ZoomControls />
    </div>
  );
}

/** Start or Stop: enabled whatever the live status (both idempotent); only while loaded, not saving, no press in progress. */
function RunButton({ op, run }: { op: RunOp; run: Parameters<typeof CapsuleToolbar>[0]['run'] }) {
  const label = op === 'start' ? (run?.pending === 'start' ? '▶ Starting…' : '▶ Start') : (run?.pending === 'stop' ? '■ Stopping…' : '■ Stop');
  const cls = op === 'start' ? 'qb run' : 'qb stop';
  const blocked = run ? run.blocked[op] : NOT_YET;
  if (run && blocked === null) {
    return <button type="button" className={cls} onClick={op === 'start' ? run.onStart : run.onStop} data-tip={RUN_TIP[op]}>{label}</button>;
  }
  // a disabled button shows no tip of its own: the span carries it
  return <span data-tip={blocked ?? undefined}><button type="button" className={cls} disabled>{label}</button></span>;
}

/**
 * Save (plan 8 §4.1). While a Save runs (from the click through BaseApi's answer, the re-read and the alignment) a
 * spinner replaces the ⤓ and the button is busy; once shown it stays MIN_SPIN_MS so a fast Save does not flicker.
 */
function SaveButton({ save }: { save: Parameters<typeof CapsuleToolbar>[0]['save'] }) {
  const busy = useMinShown(save?.saving === true);
  // the tooltip says why (2026-10-11): what stops it, or what this Save will do
  if (!save) return <span data-tip={NOT_YET}><button type="button" className="qb" disabled>⤓ Save</button></span>;
  if (save.blocked !== null && !busy) return <span data-tip={save.blocked}><button type="button" className="qb" disabled>⤓ Save</button></span>;
  const tip = save.changed
    ? 'Store the design; BaseApi applies it when it finds no errors, and the dashboard gets its drawing'
    : 'Nothing changed since the last Save: Save stores it again and publishes its drawing to the dashboard';
  return (
    <button type="button" className="qb" disabled={busy} aria-busy={busy} onClick={save.onSave} data-tip={busy ? 'Saving…' : tip}>
      {busy ? <><Spinner /> Saving…</> : '⤓ Save'}
    </button>
  );
}

/** The AI drawing button's magic wand (2026-10-11): a small stroke icon in the toolbar's own colour. */
function WandIcon() {
  return (
    <svg className="qicon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 4 }}>
      <path d="M2.5 13.5 10 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M10 6l1.6-1.6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M12.5 1.2v2.2M11.4 2.3h2.2M14.3 6.1v1.6M13.5 6.9h1.6M7.2 1.6v1.4M6.5 2.3h1.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none" />
    </svg>
  );
}

