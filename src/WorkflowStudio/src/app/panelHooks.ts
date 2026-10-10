import { useEffect, useState } from 'react';
import type { DockviewPanelApi } from 'dockview-react';

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
