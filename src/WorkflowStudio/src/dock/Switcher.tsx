/** Moves `id` to the front of a most-recently-used list. Pure. */
export function touch(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)];
}

/** The switcher's order: recently used first, then everything else present, in its own order. */
export function switcherOrder(mru: readonly string[], present: readonly string[]): string[] {
  const known = mru.filter((id) => present.includes(id));
  return [...known, ...present.filter((id) => !known.includes(id))];
}

export interface SwitcherEntry { id: string; label: string; document: boolean; hint?: string }

/**
 * Ctrl+E (spec §6.2.6; the browser keeps Ctrl+Tab), mockup v49 .switcher: hold Ctrl, tap E to move
 * down the most-recent list, release Ctrl to go there. A click goes straight there.
 */
export function Switcher({ entries, selected, onPick }: { entries: readonly SwitcherEntry[]; selected: string | null; onPick: (id: string) => void }) {
  const row = (e: SwitcherEntry) => (
    <div key={e.id} role="option" aria-selected={e.id === selected} className={e.id === selected ? 'sw-i on' : 'sw-i'} onClick={() => onPick(e.id)}>
      {e.document ? <b>{e.label}</b> : e.label}
      {e.hint && <span className="m">{` · ${e.hint}`}</span>}
    </div>
  );
  return (
    <div className="switcher" role="dialog" aria-label="Switch window">
      <div className="sw-t">Switch window <span className="m">hold Ctrl · tap E · release</span></div>
      <div className="sw-b">
        <div role="listbox" aria-label="Active tool windows"><div className="sw-h">Active tool windows</div>{entries.filter((e) => !e.document).map(row)}</div>
        <div role="listbox" aria-label="Active documents"><div className="sw-h">Active documents</div>{entries.filter((e) => e.document).map(row)}</div>
      </div>
    </div>
  );
}
