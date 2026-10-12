import { useMemo } from 'react';
import type { LiveArt } from '../canvas/liveArt';
import type { SavedView } from '../canvas/savedView';
import { useFitter } from '../canvas/useFitter';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import type { Pick } from '../store/picks';
import { NOT_SAVED_YET, runBlocked, type RunOp } from '../store/run';
import { SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Selection } from '../store/selection';
import { designDirty, designLocked, hasChanges, saveBlocked } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { applyDraft, applyEdits } from '../design/apply';
import { canRedo, canUndo } from '../design/history';
import { newId } from '../design/ids';
import { aiBlocked, useAiDrawing } from '../ai/useAiDrawing';
import { CapsuleToolbar } from './CapsuleToolbar';
import { useStudioActionsOrNull } from './studioActions';
import { useHealthOf, useWorkflowStatus } from '../live/LiveContext';
import { useOwnerDocument, usePanelShown, type PanelLike } from './panelHooks';

/**
 * One workflow document in its dock tab: its own React Flow canvas and viewport (the panel uses
 * `renderer: 'always'`, so both survive tab switches), its toolbar and its run status. Labels
 * are measured in the document the panel is drawn in, so a pop-out keeps its fonts (spec §6.3). The run status and
 * processor health come from the app's one liveness store (2026-10-10), shown or hidden alike: nothing here polls.
 */
export function DocumentPanel({ workflowId, panel, initialView, onViewChange, onSelect, onRetry, onSave, onRun, onDeleteWorkflow }: {
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
  /** Delete with the workflow picked (2026-10-10): Workspace › Delete…'s own path (fresh liveness, dry run, Cancel/Continue). */
  onDeleteWorkflow?: () => void;
}) {
  const open = useStudio((s) => s.docs.find((d) => d.workflowId === workflowId) ?? null);
  const store = useStudioStore();
  const actions = useStudioActionsOrNull();
  const ownerDocument = useOwnerDocument(panel);
  const aiDrawing = useAiDrawing(workflowId);
  const fitter = useFitter(ownerDocument);
  const status = useWorkflowStatus(workflowId);
  const health = useHealthOf();
  // an unknown status is "status unknown" in the capsule and inside the hub dial, with not started's look (spec §5.1)
  const live = useMemo<LiveArt>(() => ({ started: status === 'running', status, health }), [status, health]);
  // a background tab's canvas stays mounted; .bg hides its nodes (document.css says why)
  const cls = usePanelShown(panel) ? 'docpanel' : 'docpanel bg';
  // the canvas draws the design (plan 8 §3.1): the base with the entity edits; the canvas draft goes over it inside the canvas
  const base = open?.status.kind === 'ready' ? open.status.doc : null;
  const edits = open?.edits ?? null;
  // the draft's pasted and deleted blocks first (2026-10-10): the canvas treats them as the workflow's own
  const blocks = open?.design.draft.blocks;
  const edited = useMemo(() => (base && edits ? applyEdits(base, edits, blocks) : null), [base, edits, blocks]);

  // while a Save runs or the AI draws (2026-10-11) the design is read-only (spec §4.1): the canvas draws it whole, with no
  // design mode; clicking still selects and the Inspector shows it, read-only
  const locked = open !== null && designLocked(open);
  const frozen = useMemo(() => (edited && locked ? applyDraft(edited, open!.design.draft) : null), [edited, locked, open?.design.draft]);

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
        design={locked ? undefined : {
          draft: open.design.draft,
          picks: open.picks,
          onPick: (picks) => store.dispatch({ type: 'pick', workflowId, picks }),
          onCommit: (draft, o) => store.dispatch({ type: 'design', workflowId, draft, merge: o?.merge, picks: o?.picks }),
          onUndo: () => store.dispatch({ type: 'undo', workflowId }),
          onRedo: () => store.dispatch({ type: 'redo', workflowId }),
          // copy, paste and delete (2026-10-10): the store does them, so the clipboard is shared by every document
          onCopy: () => store.dispatch({ type: 'copy', workflowId }),
          onPaste: () => store.dispatch({ type: 'paste', workflowId, newId }),
          // the workflow picked, alone or with others (2026-10-10): Delete is Workspace › Delete…, nothing else; a new workflow
          // not saved yet has none in BaseApi, so it is not deleted (as the menu item waits)
          onDelete: () => {
            const doc = store.getState().docs.find((d) => d.workflowId === workflowId);
            if (!doc?.picks.some((p) => p.kind === 'node' && p.id === SPHERE_NODE_ID)) { store.dispatch({ type: 'deletePicks', workflowId }); return; }
            if (doc.virtual) {
              store.dispatch({ type: 'log', workflowId, lines: [{ at: new Date().toISOString(), text: `Delete… is not available: ${NOT_SAVED_YET}`, level: 'error' }] });
              return;
            }
            onDeleteWorkflow?.();
          },
        }}
        onSelect={onSelect ? (selection, picks) => onSelect(selection, ownerDocument, picks) : (selection, picks) => {
          store.dispatch({ type: 'activate', workflowId });
          store.dispatch({ type: 'select', workflowId, selection, picks });
        }}
      >
        <CapsuleToolbar workflow={open.status.doc.graph.workflow} status={status}
          save={onSave ? { blocked: saveBlocked(open), changed: hasChanges(open), saving: open.saving, onSave } : undefined}
          run={onRun ? {
            blocked: { start: runBlocked(open), stop: runBlocked(open) }, pending: open.run?.op ?? null,
            onStart: () => onRun('start'), onStop: () => onRun('stop'),
          } : undefined}
          design={actions ? {
            dirty: designDirty(open), locked, canUndo: canUndo(open.design), canRedo: canRedo(open.design),
            onUndo: () => store.dispatch({ type: 'undo', workflowId }),
            onRedo: () => store.dispatch({ type: 'redo', workflowId }),
            onDiscard: () => actions.confirmDiscardDesign(workflowId, ownerDocument),
          } : undefined}
          ai={actions ? { running: aiDrawing.running, seconds: aiDrawing.seconds, activity: aiDrawing.activity, blocked: aiBlocked(open), onDraw: () => { void aiDrawing.draw(); }, onCancel: aiDrawing.cancel } : undefined} />
      </WorkflowCanvas>
    </div>
  );
}
