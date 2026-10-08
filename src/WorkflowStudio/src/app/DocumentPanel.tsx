import { useMemo } from 'react';
import type { StudioApi } from '../api/client';
import { healthOf } from '../api/liveness';
import type { LiveArt } from '../canvas/liveArt';
import type { SavedView } from '../canvas/savedView';
import { useFitter } from '../canvas/useFitter';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import { missingRequired } from '../store/entityForms';
import { hasEdits } from '../store/inspector';
import { entityKindOf, targetKey } from '../store/inspectorTarget';
import type { Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import { designDirty, shownTargetOf, type OpenDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { applyEdits } from '../design/apply';
import { canRedo, canUndo } from '../design/history';
import { CapsuleToolbar } from './CapsuleToolbar';
import { useStudioActionsOrNull } from './studioActions';
import { useLiveness, useLiveStatus, useOwnerDocument, usePanelShown, usePanelVisible, type PanelLike } from './panelHooks';

/**
 * One workflow document in its dock tab: its own React Flow canvas and viewport (the panel uses
 * `renderer: 'always'`, so both survive tab switches), its toolbar and its run status. Labels
 * are measured in the document the panel is drawn in, so a pop-out keeps its fonts (spec §6.3).
 */
export function DocumentPanel({ api, workflowId, panel, initialView, onViewChange, onSelect, onRetry, onSave }: {
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
  /** Saves the Inspector's edits (the capsule's Save). */
  onSave?: () => void;
}) {
  const open = useStudio((s) => s.docs.find((d) => d.workflowId === workflowId) ?? null);
  const store = useStudioStore();
  const actions = useStudioActionsOrNull();
  const ownerDocument = useOwnerDocument(panel);
  const fitter = useFitter(ownerDocument);
  const visible = usePanelVisible(panel, ownerDocument) && open?.status.kind === 'ready';
  const status = useLiveStatus(api, workflowId, visible);
  const liveness = useLiveness(api, visible);
  // a failed live poll is "status unknown" in the capsule and on the hub pill, with not started's look (spec §5.1)
  const live = useMemo<LiveArt>(() => ({ started: status === 'running', status, health: healthOf(liveness) }), [status, liveness]);
  // a background tab's canvas stays mounted; .bg hides its nodes (document.css says why)
  const cls = usePanelShown(panel) ? 'docpanel' : 'docpanel bg';
  // the canvas draws the design (plan 8 §3.1): the base with the entity edits; the canvas draft goes over it inside the canvas
  const base = open?.status.kind === 'ready' ? open.status.doc : null;
  const edits = open?.edits ?? null;
  const edited = useMemo(() => (base && edits ? applyEdits(base, edits) : null), [base, edits]);

  if (open === null) return null;
  const blank = missingRequiredShown(open);
  if (open.status.kind === 'failed') return <div className={cls}><div className="doc-msg error" role="alert">{open.status.message}{onRetry && <button type="button" className="btn" onClick={onRetry}>Retry</button>}</div></div>;
  if (open.status.kind === 'loading' || fitter === null) return <div className={cls}><div className="doc-msg">Loading…</div></div>;

  return (
    <div className={cls}>
      <WorkflowCanvas
        doc={edited ?? open.status.doc}
        fitter={fitter}
        selection={open.selection}
        live={live}
        initialView={initialView}
        onViewChange={onViewChange}
        design={{
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
        <CapsuleToolbar workflow={open.status.doc.graph.workflow} status={status} dirty={hasEdits(open.inspector)} busy={open.inspector.busy} blocked={blank} onSave={onSave}
          design={actions ? {
            dirty: designDirty(open), canUndo: canUndo(open.design), canRedo: canRedo(open.design),
            onUndo: () => store.dispatch({ type: 'undo', workflowId }),
            onRedo: () => store.dispatch({ type: 'redo', workflowId }),
            onDiscard: () => actions.confirmDiscardDesign(workflowId, ownerDocument),
          } : undefined} />
      </WorkflowCanvas>
    </div>
  );
}

/** Whether the Inspector's edits would save a required field (Name, Version) blank; false until its entity is read. */
function missingRequiredShown(open: OpenDocument): boolean {
  const target = shownTargetOf(open);
  const saved = open.inspector.saved;
  if (target === null || saved === null || saved.key !== targetKey(target)) return false;
  return missingRequired(entityKindOf(target), saved.dto, open.inspector.edits);
}
