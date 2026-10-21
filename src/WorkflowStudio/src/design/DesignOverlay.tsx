import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore, ViewportPortal } from '@xyflow/react';
import type { Side } from '../circuit/circuit';
import type { WireRoute } from '../layout/circuitRoute';
import type { Bends } from '../layout/shape';
import type { Pt } from '../layout/router';
import type { Point } from '../layout/geometry';
import { pathOf } from '../canvas/svgPath';
import { squaresOf, SQUARE } from './cut';
import { dropLabel } from './drop';
import type { GapMark, Guides } from './guides';
import type { FlowRect } from './hit';
import type { DropHint } from './useWireGestures';

export interface DesignOverlayProps {
  band: FlowRect | null;
  /** Alignment lines and equal-gap marks while a block is dragged or dropped from the Toolbox (plan 10, Visio's dynamic grid). */
  guides: Guides;
  /** The picked wires, as shown. */
  wires: WireRoute[];
  /** A wire's shape as bends (its own manual bends, else the router's): its run squares follow it. */
  bendsOf: (wire: WireRoute) => Bends;
  onSegment: (wire: WireRoute, k: number, e: ReactPointerEvent) => void;
  /** An end square pressed: the wire's tail or head, whatever it is on (plan 9 §6). */
  onEnd: (wire: WireRoute, side: Side, e: ReactPointerEvent) => void;
  /** A new wire's path, right-angled from its source to the pointer (spec §4.5); a dragged end moves its own wire. */
  ghost: Pt[] | null;
  /** What is under each dragged end: the label next to it says what the drop does, or why it is refused. */
  hints?: readonly DropHint[];
  /**
   * A Toolbox drag over this canvas (2026-10-11): where the block lands (a dashed box), where the wire lands, and the label
   * by the pointer (green: the drop does it; red: refused).
   */
  tool?: {
    box: { x: number; y: number; w: number; h: number } | null;
    line: readonly [Point, Point] | null;
    /** A Wire tile over a contact (2026-10-20): the wire as the drop would draw it. */
    path?: readonly Pt[] | null;
    label: { text: string; tone: 'ok' | 'no'; at: Point } | null;
  } | null;
  /** The part of a wire an end released here would cut away, drawn faded (the user's rule, 2026-10-09). */
  gone?: Pt[] | null;
}

/** On-screen sizes (px) that do not shrink with the zoom: at the fitted zoom a 2 px line would vanish. */
const LINE = 1.5, GHOST = 1.6, LABEL_H = 18, LABEL_PAD = 6, LABEL_FONT = 11.5;
/** Visio's dynamic grid (plan 10, measured): guides overshoot 8 px; a gap's arrow 18 px off its pair, ticks ±10, heads 6 long. */
const OVERSHOOT = 8, GAP_OFF = 18, TICK = 10, HEAD = 6;

/** An equal gap as Visio draws it: a line with an arrow head at each end, between two ticks, beside its pair. */
function GapArrow({ gap, k }: { gap: GapMark; k: number }) {
  const off = gap.at + GAP_OFF * k, t = TICK * k, h = HEAD * k, w = h / 2;
  // along: the gap's own axis; across: the arrow's offset line
  const pt = (along: number, across: number) => (gap.axis === 'x' ? `${along} ${across}` : `${across} ${along}`);
  const seg = (a1: number, c1: number, a2: number, c2: number) => (gap.axis === 'x'
    ? { x1: a1, y1: c1, x2: a2, y2: c2 } : { x1: c1, y1: a1, x2: c2, y2: a2 });
  return (
    <g className="design-gap" strokeWidth={k}>
      <line {...seg(gap.from, off, gap.to, off)} />
      <line {...seg(gap.from, off - t, gap.from, off + t)} />
      <line {...seg(gap.to, off - t, gap.to, off + t)} />
      <path className="design-gap-head" d={`M${pt(gap.from, off)} L${pt(gap.from + h, off - w)} L${pt(gap.from + h, off + w)} Z`} />
      <path className="design-gap-head" d={`M${pt(gap.to, off)} L${pt(gap.to - h, off - w)} L${pt(gap.to - h, off + w)} Z`} />
    </g>
  );
}

/**
 * Drawn above the blocks in flow coordinates: the rubber band (spec §3.2), the alignment guides (§3.4), and a picked
 * wire's squares (§4.2, Visio; plan 9 rule 14): one on each end (tail and head, on whatever they are), one in the
 * middle of each run of its core (no mark on a bend); and the ghost of a new wire while it is drawn (§4.5).
 */
export function DesignOverlay({ band, guides, wires, bendsOf, onSegment, onEnd, ghost, hints = [], gone = null, tool = null }: DesignOverlayProps) {
  // one screen pixel in flow units
  const k = 1 / useStore((s) => s.transform[2]);
  return (
    <ViewportPortal>
      <svg className="design-overlay" width={1} height={1}>
        {band && <rect className="design-band" x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} strokeWidth={k} strokeDasharray={`${4 * k} ${3 * k}`} />}
        {guides.lines.map((l, i) => {
          // Visio's: dashed, overshooting both blocks a little along the line (plan 10)
          const o = OVERSHOOT * k, flat = l.y1 === l.y2;
          return <line key={i} className="design-guide" x1={l.x1 - (flat ? o : 0)} y1={l.y1 - (flat ? 0 : o)} x2={l.x2 + (flat ? o : 0)} y2={l.y2 + (flat ? 0 : o)}
            strokeWidth={k} strokeDasharray={`${4 * k} ${3 * k}`} />;
        })}
        {guides.gaps.map((g, i) => <GapArrow key={`g${i}`} gap={g} k={k} />)}
        {wires.map((w) => {
          const sq = (x: number, y: number) => ({ x: x - (SQUARE / 2) * k, y: y - (SQUARE / 2) * k, width: SQUARE * k, height: SQUARE * k, strokeWidth: LINE * k });
          return (
            <g key={w.id} className="design-wire" data-wire={w.id}>
              {squaresOf(w, bendsOf(w), k).map((s) => (s.kind === 'run'
                ? <rect key={`s${s.k}`} className={s.vertical ? 'design-handle seg v' : 'design-handle seg h'} data-k={s.k} {...sq(s.x, s.y)}
                  onPointerDown={(e) => onSegment(w, s.k, e)} />
                : <rect key={s.side} className="design-handle end" data-end={s.side} {...sq(s.x, s.y)} onPointerDown={(e) => onEnd(w, s.side, e)} />))}
            </g>
          );
        })}
        {ghost && <path className="design-ghost" d={pathOf(ghost)} strokeWidth={GHOST * k} />}
        {gone && gone.length > 1 && <path className="design-gone" d={pathOf(gone)} strokeWidth={4 * k} />}
        {tool?.box && <rect className="design-tool-landing" x={tool.box.x} y={tool.box.y} width={tool.box.w} height={tool.box.h} strokeWidth={1.5 * k} strokeDasharray={`${6 * k} ${4 * k}`} />}
        {tool?.line && <path className="design-tool-wire" d={`M${tool.line[0].x} ${tool.line[0].y}H${tool.line[1].x}`} strokeWidth={2 * k} strokeDasharray={`${5 * k} ${4 * k}`} />}
        {tool?.path && tool.path.length > 1 && <path className="design-tool-wire" d={tool.path.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ')} strokeWidth={2 * k} strokeDasharray={`${5 * k} ${4 * k}`} />}
        {tool?.label && (
          <g className={`design-drop-label ${tool.label.tone}`} transform={`translate(${tool.label.at.x + 14 * k} ${tool.label.at.y + 14 * k}) scale(${k})`}>
            <rect x={0} y={0} rx={4} height={LABEL_H} width={tool.label.text.length * LABEL_FONT * 0.56 + 2 * LABEL_PAD} />
            <text x={LABEL_PAD} y={LABEL_H / 2 + LABEL_FONT * 0.36} fontSize={LABEL_FONT}>{tool.label.text}</text>
          </g>
        )}
        {hints.map((hint, i) => {
          const label = dropLabel(hint.why);
          return (
            // drawn in screen pixels: the group undoes the zoom, offset below-right of the pointer (or the end)
            <g key={i} className={`design-drop-label ${hint.tone}`} transform={`translate(${hint.at.x + 14 * k} ${hint.at.y + 14 * k}) scale(${k})`}>
              <rect x={0} y={0} rx={4} height={LABEL_H} width={label.length * LABEL_FONT * 0.56 + 2 * LABEL_PAD} />
              <text x={LABEL_PAD} y={LABEL_H / 2 + LABEL_FONT * 0.36} fontSize={LABEL_FONT}>{label}</text>
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
}
