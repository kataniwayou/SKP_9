import type { StudioApi } from '../api/client';
import { useFitter } from '../canvas/useFitter';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import { useStudio, useStudioStore } from '../store/studioStore';
import { CapsuleToolbar } from './CapsuleToolbar';
import { useLiveStatus, useOwnerDocument, usePanelVisible, type PanelLike } from './panelHooks';

/**
 * One workflow document in its dock tab: its own React Flow canvas and viewport (the panel uses
 * `renderer: 'always'`, so both survive tab switches), its toolbar and its run status. Labels
 * are measured in the document the panel is drawn in, so a pop-out keeps its fonts (spec §6.3).
 */
export function DocumentPanel({ api, workflowId, panel }: { api: StudioApi; workflowId: string; panel: PanelLike }) {
  const open = useStudio((s) => s.docs.find((d) => d.workflowId === workflowId) ?? null);
  const store = useStudioStore();
  const ownerDocument = useOwnerDocument(panel);
  const fitter = useFitter(ownerDocument);
  const status = useLiveStatus(api, workflowId, usePanelVisible(panel, ownerDocument));

  if (open === null) return null;
  if (open.status.kind === 'failed') return <div className="docpanel"><div className="doc-msg error" role="alert">{open.status.message}</div></div>;
  if (open.status.kind === 'loading' || fitter === null) return <div className="docpanel"><div className="doc-msg">Loading…</div></div>;

  return (
    <div className="docpanel">
      <WorkflowCanvas
        doc={open.status.doc}
        fitter={fitter}
        selection={open.selection}
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
