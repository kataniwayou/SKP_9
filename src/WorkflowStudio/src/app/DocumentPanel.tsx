import { useMemo } from 'react';
import type { StudioApi } from '../api/client';
import { healthOf } from '../api/liveness';
import type { LiveArt } from '../canvas/liveArt';
import type { SavedView } from '../canvas/savedView';
import { useFitter } from '../canvas/useFitter';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import { useStudio, useStudioStore } from '../store/studioStore';
import { CapsuleToolbar } from './CapsuleToolbar';
import { useLiveness, useLiveStatus, useOwnerDocument, usePanelShown, usePanelVisible, type PanelLike } from './panelHooks';

/**
 * One workflow document in its dock tab: its own React Flow canvas and viewport (the panel uses
 * `renderer: 'always'`, so both survive tab switches), its toolbar and its run status. Labels
 * are measured in the document the panel is drawn in, so a pop-out keeps its fonts (spec §6.3).
 */
export function DocumentPanel({ api, workflowId, panel, initialView, onViewChange }: {
  api: StudioApi;
  workflowId: string;
  panel: PanelLike;
  /** Where this document's view was when the page was left (the session); null: fit it. */
  initialView?: SavedView | null;
  /** Called when the view settles, for the session. */
  onViewChange?: (view: SavedView) => void;
}) {
  const open = useStudio((s) => s.docs.find((d) => d.workflowId === workflowId) ?? null);
  const store = useStudioStore();
  const ownerDocument = useOwnerDocument(panel);
  const fitter = useFitter(ownerDocument);
  const visible = usePanelVisible(panel, ownerDocument) && open?.status.kind === 'ready';
  const status = useLiveStatus(api, workflowId, visible);
  const liveness = useLiveness(api, visible);
  // a failed live poll is "status unknown" in the capsule and on the hub pill, with not started's look (spec §5.1)
  const live = useMemo<LiveArt>(() => ({ started: status === 'running', status, health: healthOf(liveness) }), [status, liveness]);
  // a background tab's canvas stays mounted; .bg hides its nodes (document.css says why)
  const cls = usePanelShown(panel) ? 'docpanel' : 'docpanel bg';

  if (open === null) return null;
  if (open.status.kind === 'failed') return <div className={cls}><div className="doc-msg error" role="alert">{open.status.message}</div></div>;
  if (open.status.kind === 'loading' || fitter === null) return <div className={cls}><div className="doc-msg">Loading…</div></div>;

  return (
    <div className={cls}>
      <WorkflowCanvas
        doc={open.status.doc}
        fitter={fitter}
        selection={open.selection}
        live={live}
        initialView={initialView}
        onViewChange={onViewChange}
        onSelect={(selection) => {
          store.dispatch({ type: 'activate', workflowId });
          store.dispatch({ type: 'select', workflowId, selection });
        }}
      >
        <CapsuleToolbar workflow={open.status.doc.graph.workflow} status={status} />
      </WorkflowCanvas>
    </div>
  );
}
