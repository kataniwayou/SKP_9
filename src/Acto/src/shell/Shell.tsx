import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { clampSize, DEFAULT_SIZES, readSizes, writeSizes, type PanelSizes, type SizeKey } from './panelSizes';
import './shell.css';

export interface ShellProps {
  toolbox: ReactNode; board: ReactNode; inspector: ReactNode; output: ReactNode; chat: ReactNode;
  /** Where sizes are remembered; null = nowhere. Defaults to localStorage. */
  storage?: Storage | null;
}

function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

interface Drag { key: SizeKey; start: number; from: number; sign: 1 | -1; axis: 'x' | 'y'; moved?: boolean }

export function Shell({ toolbox, board, inspector, output, chat, storage }: ShellProps) {
  const store = useRef<Storage | null>(storage === undefined ? browserStorage() : storage).current;
  const [sizes, setSizes] = useState<PanelSizes>(() => readSizes(store));
  const [active, setActive] = useState<SizeKey | null>(null);
  const drag = useRef<Drag | null>(null);
  const outputEl = useRef<HTMLDivElement>(null);

  const latest = useRef(sizes);
  latest.current = sizes;
  const commit = (next: PanelSizes) => { setSizes(next); writeSizes(store, next); };

  const splitter = (key: SizeKey, axis: 'x' | 'y', sign: 1 | -1, label: string) => {
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
    return (
      <div role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label}
        className={`split ${axis === 'x' ? 'col' : 'row'}${active === key ? ' on' : ''}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={reset} />
    );
  };

  const vars = {
    '--tw': `${sizes.tools}px`,
    '--iw': `${sizes.inspector}px`,
    '--bh': `${sizes.bottom}px`,
    '--ow': sizes.output === null ? '1fr' : `${sizes.output}px`,
  } as CSSProperties;

  return (
    <div className="app" data-testid="shell" style={vars}>
      <div className="pane tools" data-panel="toolbox">{toolbox}</div>
      <div className="s1">{splitter('tools', 'x', 1, 'Resize toolbox')}</div>
      <div className="pane board" data-panel="board">{board}</div>
      <div className="s2">{splitter('inspector', 'x', -1, 'Resize inspector')}</div>
      <div className="pane insp" data-panel="inspector">{inspector}</div>
      <div className="sh">{splitter('bottom', 'y', -1, 'Resize bottom panels')}</div>
      <div className="bottom">
        <div className="pane" data-panel="output" ref={outputEl}>{output}</div>
        {splitter('output', 'x', 1, 'Resize output')}
        <div className="pane" data-panel="chat">{chat}</div>
      </div>
    </div>
  );
}
