import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DRAWABLE, MAKES } from '../app/virtual';
import type { Workspace } from '../app/workspace';
import { canvasBridge } from '../molecule/bridge';
import { KINDS, TYPES, type ArrowKind, type AtomType } from '../molecule/model';

/** A tile: an atom with its mandatory arrow, or a deletable arrow to draw again (approved 2026-10-17). */
type Tool = { kind: 'atom'; type: AtomType } | { kind: 'arrow'; arrow: ArrowKind };

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const colour = (t: AtomType) => hex(TYPES[t].color);

const ATOMS: readonly AtomType[] = ['schema', 'cache', 'proc', 'step', 'asg', 'wf'];
const ARROWS: readonly ArrowKind[] = ['entry', 'next', 'wfAsg', 'wfCache', 'input', 'output', 'config'];
const ARROW_NAME: Readonly<Partial<Record<ArrowKind, string>>> = {
  entry: 'Entry step', next: 'Next step', wfAsg: 'Assignment', wfCache: 'Cache', input: 'Input schema', output: 'Output schema', config: 'Config schema',
};
const R: Readonly<Record<AtomType, number>> = { wf: 15, step: 12, proc: 14, schema: 11, asg: 9, cache: 12 };

/** A ball as the canvas draws one: its colour and a highlight. */
const Ball = ({ cx, cy, t, r = R[t], hollow = false }: { cx: number; cy: number; t: AtomType; r?: number; hollow?: boolean }) => (hollow
  ? <circle cx={cx} cy={cy} r={r} fill="none" stroke={colour(t)} strokeWidth="1.8" />
  : <g><circle cx={cx} cy={cy} r={r} fill={colour(t)} /><circle cx={cx - r * 0.3} cy={cy - r * 0.3} r={r * 0.3} fill="#fff" opacity=".35" /></g>);

/** An arrow from x0 to x1 at y, in its kind's colour. */
const Arrow = ({ x0, x1, y, kind, w = 2.4 }: { x0: number; x1: number; y: number; kind: ArrowKind; w?: number }) => (
  <g><path d={`M${x0} ${y}H${x1 - 10}`} stroke={hex(KINDS[kind].color)} strokeWidth={w} /><path d={`M${x1 - 12} ${y - 5}L${x1} ${y}L${x1 - 12} ${y + 5}Z`} fill={hex(KINDS[kind].color)} /></g>
);

/** A tile's art: a made atom solid with its mandatory arrow to a dashed ring; a drawn arrow between hollow rings. */
function Art({ tool }: { tool: Tool }) {
  if (tool.kind === 'atom') {
    const on = MAKES[tool.type].on;
    if (!on) return <svg viewBox="0 0 120 46" aria-hidden="true"><Ball cx={60} cy={23} t={tool.type} r={R[tool.type] + 2} /></svg>;
    const kind: ArrowKind = tool.type === 'step' ? 'uses' : tool.type === 'asg' ? 'asg' : 'entry';
    return (
      <svg viewBox="0 0 120 46" aria-hidden="true">
        <Ball cx={28} cy={23} t={tool.type} /><Arrow x0={28 + R[tool.type] + 2} x1={88} y={23} kind={kind} w={kind === 'uses' ? 3 : 2.4} />
        <circle cx={100} cy={23} r={10} fill="none" stroke={colour(on)} strokeWidth="1.6" strokeDasharray="3 3" />
      </svg>
    );
  }
  const d = DRAWABLE[tool.arrow]!;
  return (
    <svg viewBox="0 0 120 46" aria-hidden="true">
      {tool.arrow === 'next' && <g><path d="M20 27V40M106 27V40" stroke={hex(KINDS.uses.color)} strokeWidth="2" /><circle cx="20" cy="42" r="3.5" fill="none" stroke={colour('proc')} strokeWidth="1.4" /><circle cx="106" cy="42" r="3.5" fill="none" stroke={colour('proc')} strokeWidth="1.4" /></g>}
      <Ball cx={20} cy={tool.arrow === 'next' ? 18 : 23} t={d.tail} r={10} hollow />
      <Arrow x0={33} x1={94} y={tool.arrow === 'next' ? 18 : 23} kind={tool.arrow} />
      <Ball cx={106} cy={tool.arrow === 'next' ? 18 : 23} t={d.head} r={8} hollow />
    </svg>
  );
}

/** A press that moves less than this (px) before it is let go is a click, not a drag (SKP Studio's). */
const DRAG_START = 4;

type Ghost = { x: number; y: number; tool: Tool; px: number | null; ok: boolean | null };

/**
 * The Toolbox (approved 2026-10-17). Atoms, each with only its mandatory arrow: a schema, a cache or a processor is
 * dropped anywhere; a step on a processor, an assignment on a step, a workflow on a step (its entry). Arrows — the
 * deletable ones, to draw again — are dropped on their tail, then their head is clicked. While dragged, a tile's ghost
 * is the size its atom (or the arrow's bond) will have on the canvas where it is; over the Toolbox it keeps its tile
 * size. Valid targets are lit, the rest dimmed; Escape cancels. What is made is virtual, like an edit or a delete.
 */
export function Toolbox({ workspace }: { workspace: Workspace }) {
  const [q, setQ] = useState('');
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [aiming, setAiming] = useState<{ arrow: ArrowKind; tail: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const doc = root.current?.ownerDocument ?? document;

  /** The atoms a tool may be dropped on: its mandatory arrow's target, or an arrow's tail; none for a lone atom. */
  const targetsOf = (tool: Tool, stage: 'tail' | 'head' = 'tail'): Set<string> => {
    const { molecule, removed } = workspace.get();
    const want = tool.kind === 'atom' ? MAKES[tool.type].on : stage === 'tail' ? DRAWABLE[tool.arrow]!.tail : DRAWABLE[tool.arrow]!.head;
    const out = new Set<string>();
    if (!molecule || !want) return out;
    molecule.atoms.forEach((a) => { if (a.type === want && !removed.atoms.includes(a.key)) out.add(a.key); });
    return out;
  };

  // aiming an arrow: the arrow follows the pointer from its tail; a click on a valid head draws it, elsewhere cancels
  useEffect(() => {
    if (!aiming) return undefined;
    const api = canvasBridge.get();
    if (!api) { setAiming(null); return undefined; }
    const tool: Tool = { kind: 'arrow', arrow: aiming.arrow };
    const heads = targetsOf(tool, 'head');
    if (aiming.arrow === 'next') heads.delete(aiming.tail);
    api.spotlight(new Set([aiming.tail, ...heads]));
    const win = doc.defaultView ?? window;
    const move = (e: PointerEvent) => { const over = api.atomAt(e.clientX, e.clientY); api.aim({ kind: aiming.arrow, tail: aiming.tail, x: e.clientX, y: e.clientY, head: over && heads.has(over) ? over : null }); };
    const done = () => { api.aim(null); api.spotlight(null); api.onClick = null; setAiming(null); };
    api.onClick = (atom) => { if (atom && heads.has(atom)) workspace.draw(aiming.arrow, aiming.tail, atom); done(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
    win.addEventListener('pointermove', move);
    win.addEventListener('keydown', key, true);
    return () => { win.removeEventListener('pointermove', move); win.removeEventListener('keydown', key, true); if (api.onClick) done(); };
  }, [aiming]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (tool: Tool) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const win = e.currentTarget.ownerDocument.defaultView ?? window;
    const from = { x: e.clientX, y: e.clientY };
    const targets = targetsOf(tool);
    let dragging = false;
    const at = (x: number, y: number): Ghost => {
      const api = canvasBridge.get();
      if (!api || !api.contains(x, y)) return { x, y, tool, px: null, ok: null };
      const over = api.atomAt(x, y);
      const onTarget = over !== null && targets.has(over);
      if (tool.kind === 'arrow') return { x, y, tool, px: api.bondPx(x, y, tool.arrow), ok: onTarget };
      const lone = MAKES[tool.type].on === null;
      const land = api.landing(x, y, tool.type, onTarget ? over : null);
      return { x, y, tool, px: land?.px ?? null, ok: lone ? true : onTarget };
    };
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_START) return;
        dragging = true;
        if (targets.size > 0) canvasBridge.get()?.spotlight(targets);
      }
      setGhost(at(ev.clientX, ev.clientY));
    };
    const stop = () => {
      win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', cancel); win.removeEventListener('keydown', key, true);
      setGhost(null);
      canvasBridge.get()?.spotlight(null);
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (!dragging) return;
      const api = canvasBridge.get();
      if (!api || !api.contains(ev.clientX, ev.clientY)) return; // let go off the canvas: nothing
      const over = api.atomAt(ev.clientX, ev.clientY);
      if (tool.kind === 'arrow') {
        if (over && targets.has(over)) setAiming({ arrow: tool.arrow, tail: over });
        else workspace.draw(tool.arrow, over ?? '', ''); // says why in the Output pane
        return;
      }
      const need = MAKES[tool.type].on;
      const on = need && over && targets.has(over) ? over : null;
      if (need && !on) { workspace.create(tool.type, over, [0, 0, 0]); return; } // refused, with the reason
      const land = api.landing(ev.clientX, ev.clientY, tool.type, on);
      if (land) workspace.create(tool.type, on, land.pos);
    };
    const cancel = () => stop();
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); dragging = false; stop(); } };
    win.addEventListener('pointermove', move); win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', cancel); win.addEventListener('keydown', key, true);
  };

  const needle = q.trim().toLowerCase();
  const tile = (key: string, tool: Tool, name: string, lines: ReactNode) => {
    if (needle && !`${name} ${typeof lines === 'string' ? lines : ''}`.toLowerCase().includes(needle)) return null;
    return (
      <div key={key} className={aiming && tool.kind === 'arrow' && tool.arrow === aiming.arrow ? 'tb-tile on' : 'tb-tile'} role="button" tabIndex={0}
        aria-label={`Drag ${name}`} data-tool={key} onPointerDown={begin(tool)}>
        <Art tool={tool} />
        <div className="tb-text"><b>{name}</b>{lines}</div>
      </div>
    );
  };

  return (
    <div className="paneBody" data-pane="toolbox" ref={root}>
      <div className="tb-search"><input type="search" aria-label="Search the toolbox" placeholder="search the toolbox…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="pbody toolbox">
        {aiming && (
          <div className="tb-aim" role="status">Click the {TYPES[DRAWABLE[aiming.arrow]!.head].label.toLowerCase()} the arrow points to · Escape cancels</div>
        )}
        <div className="tb-h">Atoms <span className="tb-count">a new row, with its mandatory arrow</span></div>
        <div className="tb-row">
          {ATOMS.map((t) => {
            const on = MAKES[t].on;
            return tile(t, { kind: 'atom', type: t }, TYPES[t].label, on
              ? <><span>drop on a {TYPES[on].label.toLowerCase()}</span><span className="tb-need">{TYPES[t].label.toLowerCase()} → {TYPES[on].label.toLowerCase()}</span></>
              : <span>drop anywhere</span>);
          })}
        </div>
        <div className="tb-h">Arrows <span className="tb-count">the deletable ones, to draw again</span></div>
        <div className="tb-note">An arrow joins two atoms already there: drop it on its tail, then click its head.</div>
        <div className="tb-row">
          {ARROWS.map((k) => tile(k, { kind: 'arrow', arrow: k }, ARROW_NAME[k]!,
            <span className="tb-need">{TYPES[DRAWABLE[k]!.tail].label.toLowerCase()} → {TYPES[DRAWABLE[k]!.head].label.toLowerCase()}</span>))}
        </div>
      </div>
      {ghost && createPortal(<GhostView g={ghost} />, doc.body)}
    </div>
  );
}

/** What follows the pointer: over the canvas, the atom (or the bond) at its size there; elsewhere, the tile's art. */
function GhostView({ g }: { g: Ghost }) {
  const style = { left: g.x, top: g.y };
  const cls = `tb-ghost${g.ok === false ? ' no' : ''}`;
  if (g.px === null) return <div className={cls} style={style} aria-hidden="true"><Art tool={g.tool} /></div>;
  if (g.tool.kind === 'atom') {
    const r = Math.max(g.px, 1.5), c = colour(g.tool.type);
    return (
      <div className={`${cls} sized`} style={style} aria-hidden="true" data-px={g.px.toFixed(2)}>
        <svg width={r * 2 + 4} height={r * 2 + 4} viewBox={`${-r - 2} ${-r - 2} ${r * 2 + 4} ${r * 2 + 4}`}>
          <circle r={r} fill={c} opacity=".75" /><circle cx={-r * 0.3} cy={-r * 0.3} r={r * 0.3} fill="#fff" opacity=".3" />
        </svg>
      </div>
    );
  }
  // an arrow tile over the canvas: a short arrow with its bond's real thickness
  const w = Math.max(g.px * 2, 1), L = Math.max(w * 18, 36), c = hex(KINDS[g.tool.arrow].color);
  return (
    <div className={`${cls} sized`} style={style} aria-hidden="true" data-px={g.px.toFixed(2)}>
      <svg width={L} height={w * 6} viewBox={`0 ${-w * 3} ${L} ${w * 6}`}><path d={`M0 0H${L - w * 6}`} stroke={c} strokeWidth={w} /><path d={`M${L - w * 6.5} ${-w * 2.4}L${L} 0L${L - w * 6.5} ${w * 2.4}Z`} fill={c} /></svg>
    </div>
  );
}
