import { useEffect, useState } from 'react';
import type { DockviewPanelApi } from 'dockview-react';
import type { StudioApi } from '../api/client';
import { liveStatusOf, type LiveStatus } from '../api/liveStatus';

/** The part of a dockview panel's api these hooks use (tests pass a stand-in). */
export type PanelLike = Pick<DockviewPanelApi, 'getWindow' | 'onDidLocationChange' | 'isVisible' | 'onDidVisibilityChange'>;

/**
 * The document a panel is drawn in: the main page, or its pop-out window once popped out (spec
 * §6.3: code inside a panel uses its own document, never the global one).
 */
export function useOwnerDocument(panel: PanelLike): Document {
  const [doc, setDoc] = useState<Document>(() => panel.getWindow().document);
  useEffect(() => {
    setDoc(panel.getWindow().document);
    const sub = panel.onDidLocationChange(() => setDoc(panel.getWindow().document));
    return () => sub.dispose();
  }, [panel]);
  return doc;
}

/** True while the panel's tab is the visible one in its group. */
export function usePanelShown(panel: PanelLike): boolean {
  const [shown, setShown] = useState(panel.isVisible);
  useEffect(() => {
    setShown(panel.isVisible);
    const sub = panel.onDidVisibilityChange((e) => setShown(e.isVisible));
    return () => sub.dispose();
  }, [panel]);
  return shown;
}

/** True while the panel's tab is the visible one and its window is not hidden (a background browser tab). */
export function usePanelVisible(panel: PanelLike, doc: Document): boolean {
  const shown = usePanelShown(panel);
  const [pageVisible, setPageVisible] = useState(doc.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setPageVisible(doc.visibilityState !== 'hidden');
    update();
    doc.addEventListener('visibilitychange', update);
    return () => doc.removeEventListener('visibilitychange', update);
  }, [doc]);
  return shown && pageVisible;
}

export const LIVE_POLL_MS = 5000;

/** Polls `GET /orchestration/live` every 5 s, only while `visible` (spec §6.1). Starts as "checking". */
export function useLiveStatus(api: StudioApi, workflowId: string, visible: boolean): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('checking');
  useEffect(() => {
    if (!visible) { setStatus('checking'); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await api.listLive().catch((e: unknown) => ({ ok: false as const, error: { kind: 'network' as const, message: String(e) } }));
      if (!live) return;
      setStatus(liveStatusOf(result, workflowId));
      timer = setTimeout(() => void poll(), LIVE_POLL_MS);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [api, workflowId, visible]);
  return status;
}
