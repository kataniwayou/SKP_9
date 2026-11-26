import { useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { PanelHideContext, type PanelHide } from './HideButton';
import { hidePanel, readLayout, showPanel, toggleBoardOnly, writeLayout, type PanelId, type PanelLayout } from './panelLayout';
import { clampSize, DEFAULT_SIZES, readSizes, writeSizes, type PanelSizes, type SizeKey } from './panelSizes';
import './shell.css';

export interface ShellProps {
  toolbox: ReactNode; board: ReactNode; inspector: ReactNode; output: ReactNode; chat: ReactNode;
  /** Where sizes and hidden panels are remembered; null = nowhere. Defaults to localStorage. */
  storage?: Storage | null;
  /** Anything that changes when the Output or the Chat gets something new: a hidden one's tab then shows a dot. */
  marks?: { output?: unknown; chat?: unknown };
  /** What the Inspector is on, shown on its tab while it is hidden. */
  inspectorNote?: string;
  /** The Schemas mode's toggle, left of Board only [spec rule 1]: on, the orphan count (red, on or off) and what a click does. */
  schemas?: { on: boolean; orphans: number; toggle(): void };
}

function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

interface Drag { key: SizeKey; start: number; from: number; sign: 1 | -1; axis: 'x' | 'y'; moved?: boolean }

const RAIL = 26; // a hidden panel's tab rail, px
const LABEL: Record<PanelId, string> = { toolbox: 'Toolbox', inspector: 'Inspector', output: 'Output', chat: 'Chat' };
const DIR: Record<PanelId, PanelHide['dir']> = { toolbox: 'left', inspector: 'right', output: 'down', chat: 'down' };
const ICON_ONLY = 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10';
const ICON_RESTORE = 'M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5';
/** Braces round lines: the mock's Schemas icon. */
const ICON_SCHEMAS = 'M5 2.5H3.5v11H5M11 2.5h1.5v11H11M6.5 6h3M6.5 8h3M6.5 10h2';

/**
 * The window layout. Every panel but the board hides from its header's button to a tab on its edge; the tab shows it
 * again at its old size. "Board only" hides them all, then "Restore layout" puts back the layout from before [user, 2026-11-23].
 */
export function Shell({ toolbox, board, inspector, output, chat, storage, marks, inspectorNote, schemas }: ShellProps) {
  const store = useRef<Storage | null>(storage === undefined ? browserStorage() : storage).current;
  const [sizes, setSizes] = useState<PanelSizes>(() => readSizes(store));
  const [layout, setLayout] = useState<PanelLayout>(() => readLayout(store));
  const [active, setActive] = useState<SizeKey | null>(null);
  const drag = useRef<Drag | null>(null);
  const outputEl = useRef<HTMLDivElement>(null);

  const latest = useRef(sizes);
  latest.current = sizes;
  const commit = (next: PanelSizes) => { setSizes(next); writeSizes(store, next); };

  const lay = useRef(layout);
  lay.current = layout;
  const change = (f: (l: PanelLayout) => PanelLayout) => { const n = f(lay.current); lay.current = n; setLayout(n); writeLayout(store, n); };
  const changeRef = useRef(change);
  changeRef.current = change;
  const hides = useMemo(() => {
    const one = (id: PanelId): PanelHide => ({ label: LABEL[id].toLowerCase(), dir: DIR[id], hide: () => changeRef.current((l) => hidePanel(l, id)) });
    return { toolbox: one('toolbox'), inspector: one('inspector'), output: one('output'), chat: one('chat') };
  }, []);
  const hidden = layout.hidden;

  // what the Output and the Chat held when they were hidden: a different mark since then = something new (the tab's dot)
  const seen = useRef(new Map<'output' | 'chat', unknown>());
  const fresh = (id: 'output' | 'chat'): boolean => {
    if (!hidden[id]) { seen.current.delete(id); return false; }
    const now = marks?.[id];
    if (!seen.current.has(id)) seen.current.set(id, now);
    return !Object.is(seen.current.get(id), now);
  };
  const tab = (id: PanelId, side: 'left' | 'right' | 'bottom', note = '', dot = false) => (
    <button type="button" className={`dock-tab ${side}`} title={`Show ${LABEL[id].toLowerCase()}`} data-tab={id}
      onClick={() => change((l) => showPanel(l, id))}>
      <span>{LABEL[id]}{note && <span className="note">{` · ${note}`}</span>}</span>
      {dot && <span className="dot" data-testid={`new-${id}`} />}
    </button>
  );

  const splitter = (key: SizeKey, axis: 'x' | 'y', sign: 1 | -1, label: string, idle = false) => {
    const onDown = (e: PointerEvent<HTMLDivElement>) => {
      const current = sizes[key];
      const from = current ?? outputEl.current?.getBoundingClientRect().width ?? 0;
      drag.current = { key, start: axis === 'x' ? e.clientX : e.clientY, from, sign, axis };
      setActive(key);
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    };
    const onMove = (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.key !== key) return;
      const delta = (d.axis === 'x' ? e.clientX : e.clientY) - d.start;
      const next = { ...latest.current, [key]: clampSize(key, d.from + d.sign * delta) };
      latest.current = next;
      setSizes(next); // live while dragging; written once on release
      d.moved = true;
    };
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      setActive(null);
      if (d?.moved) writeSizes(store, latest.current);
    };
    const reset = () => commit({ ...sizes, [key]: DEFAULT_SIZES[key] });
    // a splitter beside a hidden panel keeps its gap but does nothing
    if (idle) return <div className="split idle" aria-hidden="true" />;
    return (
      <div role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label}
        className={`split ${axis === 'x' ? 'col' : 'row'}${active === key ? ' on' : ''}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={reset} />
    );
  };

  const both = hidden.output && hidden.chat;
  const vars = {
    '--tw': hidden.toolbox ? `${RAIL}px` : `${sizes.tools}px`,
    '--iw': hidden.inspector ? `${RAIL}px` : `${sizes.inspector}px`,
    '--bh': both ? `${RAIL}px` : `${sizes.bottom}px`,
    '--ow': sizes.output === null ? '1fr' : `${sizes.output}px`,
  } as CSSProperties;
  const bottomCls = both ? ' strip' : hidden.output ? ' no-output' : hidden.chat ? ' no-chat' : '';
  const outFresh = fresh('output'), chatFresh = fresh('chat');

  return (
    <div className="app" data-testid="shell" style={vars}>
      <div className="pane tools" data-panel="toolbox" hidden={hidden.toolbox}>
        <PanelHideContext.Provider value={hides.toolbox}>{toolbox}</PanelHideContext.Provider>
      </div>
      {hidden.toolbox && <div className="rail tools">{tab('toolbox', 'left')}</div>}
      <div className="s1">{splitter('tools', 'x', 1, 'Resize toolbox', hidden.toolbox)}</div>
      <div className="pane board" data-panel="board">
        {board}
        <div className="board-btns">
          {schemas && (
            <button type="button" className={`pbtn schemas-toggle${schemas.on ? ' on' : ''}`} aria-pressed={schemas.on} onClick={schemas.toggle}
              title={schemas.on ? 'Hide schemas' : 'Show schemas'}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={ICON_SCHEMAS} /></svg>
              Schemas
              {schemas.orphans > 0 && <span className="schemas-n" title={`${schemas.orphans} orphan schema${schemas.orphans === 1 ? '' : 's'}`}>{schemas.orphans}</span>}
            </button>
          )}
          <button type="button" className={`pbtn board-only${layout.saved ? ' on' : ''}`} onClick={() => change(toggleBoardOnly)}
            title={layout.saved ? 'Put the panels back as they were' : 'Hide every panel'}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={layout.saved ? ICON_RESTORE : ICON_ONLY} /></svg>
            {layout.saved ? 'Restore layout' : 'Board only'}
          </button>
        </div>
      </div>
      <div className="s2">{splitter('inspector', 'x', -1, 'Resize inspector', hidden.inspector)}</div>
      <div className="pane insp" data-panel="inspector" hidden={hidden.inspector}>
        <PanelHideContext.Provider value={hides.inspector}>{inspector}</PanelHideContext.Provider>
      </div>
      {hidden.inspector && <div className="rail insp">{tab('inspector', 'right', inspectorNote)}</div>}
      <div className="sh">{splitter('bottom', 'y', -1, 'Resize bottom panels', both)}</div>
      <div className={`bottom${bottomCls}`}>
        {hidden.output && <div className="rail">{tab('output', both ? 'bottom' : 'left', '', outFresh)}</div>}
        <div className="pane" data-panel="output" ref={outputEl} hidden={hidden.output}>
          <PanelHideContext.Provider value={hides.output}>{output}</PanelHideContext.Provider>
        </div>
        {!both && splitter('output', 'x', 1, 'Resize output', hidden.output || hidden.chat)}
        <div className="pane" data-panel="chat" hidden={hidden.chat}>
          <PanelHideContext.Provider value={hides.chat}>{chat}</PanelHideContext.Provider>
        </div>
        {hidden.chat && <div className="rail">{tab('chat', both ? 'bottom' : 'right', '', chatFresh)}</div>}
      </div>
    </div>
  );
}
