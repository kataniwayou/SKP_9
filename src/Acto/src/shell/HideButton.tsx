import { createContext, useContext } from 'react';

/** Given by the Shell to each hideable panel: its name and how to hide it. */
export interface PanelHide { label: string; dir: 'left' | 'right' | 'down'; hide: () => void }
export const PanelHideContext = createContext<PanelHide | null>(null);

const PATH = { left: 'M10 3.5 5.5 8l4.5 4.5', right: 'M6 3.5 10.5 8 6 12.5', down: 'M3.5 6 8 10.5 12.5 6' } as const;

/** The last thing in a panel's header: hides the panel to a tab on its edge. Nothing outside a Shell panel. */
export function HideButton() {
  const p = useContext(PanelHideContext);
  if (!p) return null;
  return (
    <button type="button" className="hide-panel" title={`Hide ${p.label}`} aria-label={`Hide ${p.label}`} onClick={p.hide}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={PATH[p.dir]} /></svg>
    </button>
  );
}
