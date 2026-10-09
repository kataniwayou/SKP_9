import { useEffect, useMemo } from 'react';
import type { StudioApi } from '../api/client';
import { healthOf } from '../api/liveness';
import type { LiveArt } from '../canvas/liveArt';
import type { SavedView } from '../canvas/savedView';
import { useFitter } from '../canvas/useFitter';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import type { Pick } from '../store/picks';
import { runBlocked, type RunOp } from '../store/run';
import type { Selection } from '../store/selection';
import { canSave, designDirty } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { applyDraft, applyEdits } from '../design/apply';
import { canRedo, canUndo } from '../design/history';
import { CapsuleToolbar } from './CapsuleToolbar';
import { useStudioActionsOrNull } from './studioActions';
import { useLiveness, useLiveStatus, useOwnerDocument, usePanelShown, usePanelVisible, type PanelLike } from './panelHooks';

/**
 * One workflow document in its dock tab: its own React Flow canvas and viewport (the panel uses
 * `renderer: 'always'`, so both survive tab switches), its toolbar and its run status. Labels
 * are measured in the document the panel is drawn in, so a pop-out keeps its fonts (spec §6.3).
 */
export function DocumentPanel({ api, workflowId, panel, initialView, onViewChange, onSelect, onRetry, onSave, onRun }: {
  api: StudioApi;
  workflowId: string;
  panel: PanelLike;
  /** Where this document's view was when the page was left (the session); null: fit it. */
  initialView?: SavedView | null;
  /** Called when the view settles, for the session. */
  onViewChange?: (view: SavedView) => void;
  /**
   * A click on the canvas, with the window the panel is drawn in (where a dialog opens); the page's
   * guard; in design mode also the picks it made. Default: this document is activated and selects it.
   */
  onSelect?: (selection: Selection | null, doc: Document, picks?: Pick[]) => void;
  /** Reads a failed document again; a Retry button shows when given. */
  onRetry?: () => void;
  /** Saves the design (plan 8 §4.1); the toolbar's Save shows when given. */
  onSave?: () => void;
  /** Starts or stops the saved workflow (2026-10-09); without it Start and Stop stay disabled. */
  onRun?: (op: RunOp) => void;
}) {
  const open = useStudio((s) => s.docs.find((d) => d.workflowId === workflowId) ?? null);
  const store = useStudioStore();
  const actions = useStudioActionsOrNull();
  const ownerDocument = useOwnerDocument(panel);
  const fitter = useFitter(ownerDocument);
  const visible = usePanelVisible(panel, ownerDocument) && open?.status.kind === 'ready';
  // a Start or Stop in progress keeps polling while the tab is hidden: its outcome is the live set's, not a timeout's
  const pressing = open?.status.kind === 'ready' && open.run !== null;
  const status = useLiveStatus(api, workflowId, visible || pressing);
  // the store keeps what the poll said: Start and Stop follow it, and a press waiting for it is done when it agrees
  useEffect(() => { store.dispatch({ type: 'live', workflowId, status, at: new Date().toISOString() }); }, [store, workflowId, status]);
  const liveness = useLiveness(api, visible);
  // a failed live poll is "status unknown" in the capsule and on the hub pill, with not started's look (spec §5.1)
  const live = useMemo<LiveArt>(() => ({ started: status === 'running', status, health: healthOf(liveness) }), [status, liveness]);
  // a background tab's canvas stays mounted; .bg hides its nodes (document.css says why)
  const cls = usePanelShown(panel) ? 'docpanel' : 'docpanel bg';
  // the canvas draws the design (plan 8 §3.1): the base with the entity edits; the canvas draft goes over it inside the canvas
  const base = open?.status.kind === 'ready' ? open.status.doc : null;
  const edits = open?.edits ?? null;
  const edited = useMemo(() => (base && edits ? applyEdits(base, edits) : null), [base, edits]);

  // while a Save runs the design is read-only (spec §4.1): the canvas draws it whole, with no design mode
  const frozen = useMemo(() => (edited && open?.saving ? applyDraft(edited, open.design.draft) : null), [edited, open?.saving, open?.design.draft]);

  if (open === null) return null;
  if (open.status.kind === 'failed') return <div className={cls}><div className="doc-msg error" role="alert">{open.status.message}{onRetry && <button type="button" className="btn" onClick={onRetry}>Retry</button>}</div></div>;
  if (open.status.kind === 'loading' || fitter === null) return <div className={cls}><div className="doc-msg">Loading…</div></div>;

  return (
    <div className={cls}>
      <WorkflowCanvas
        doc={frozen ?? edited ?? open.status.doc}
        fitter={fitter}
        selection={open.selection}
        live={live}
        initialView={initialView}
        onViewChange={onViewChange}
        design={open.saving ? undefined : {
          draft: open.design.draft,
          picks: open.picks,
          onPick: (picks) => store.dispatch({ type: 'pick', workflowId, picks }),
          onCommit: (draft, o) => store.dispatch({ type: 'design', workflowId, draft, merge: o?.merge, picks: o?.picks }),
          onUndo: () => store.dispatch({ type: 'undo', workflowId }),
          onRedo: () => store.dispatch({ type: 'redo', workflowId }),
        }}
        onSelect={onSelect ? (selection, picks) => onSelect(selection, ownerDocument, picks) : (selection, picks) => {
          store.dispatch({ type: 'activate', workflowId });
          store.dispatch({ type: 'select', workflowId, selection, picks });
        }}
      >
        <CapsuleToolbar workflow={open.status.doc.graph.workflow} status={status}
          save={onSave ? { enabled: canSave(open), saving: open.saving, onSave } : undefined}
          run={onRun ? {
            blocked: { start: runBlocked(open, 'start'), stop: runBlocked(open, 'stop') }, pending: open.run?.op ?? null,
            onStart: () => onRun('start'), onStop: () => onRun('stop'),
          } : undefined}
          design={actions ? {
            dirty: designDirty(open), locked: open.saving, canUndo: canUndo(open.design), canRedo: canRedo(open.design),
            onUndo: () => store.dispatch({ type: 'undo', workflowId }),
            onRedo: () => store.dispatch({ type: 'redo', workflowId }),
            onDiscard: () => actions.confirmDiscardDesign(workflowId, ownerDocument),
          } : undefined} />
      </WorkflowCanvas>
    </div>
  );
}
