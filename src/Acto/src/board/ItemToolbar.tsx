import type { Pick } from './selection';
import { useToolbarActions } from './nodes/boardContext';

/** The dark bar with its little arrow, for a lone pick; null without a provider or buttons. Position it with NodeToolbar or EdgeToolbar. */
export function ItemToolbar({ pick }: { pick: Pick }) {
  const items = useToolbarActions()?.(pick) ?? null;
  if (!items || items.length === 0) return null;
  return (
    <div className="toolbar nodrag nopan" role="toolbar" aria-label={`${pick.kind} actions`} onClick={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <button key={it.label} type="button" className={it.tone} disabled={it.disabled} onClick={it.onClick}>{it.label}</button>
      ))}
      <span className="toolbar-arrow" />
    </div>
  );
}

/** Whether a toolbar would show: the node or edge asks first so it does not open an empty NodeToolbar. */
export function useHasToolbar(pick: Pick): boolean {
  const items = useToolbarActions()?.(pick) ?? null;
  return !!items && items.length > 0;
}
