import { isFree, type Circuit } from '../circuit/circuit';
import type { Net } from '../circuit/families';
import type { Pt } from './router';

/** A stretch of line two wires share: from its lower to its higher coordinate along the line. */
export type Stretch = [Pt, Pt];

/** Two different wires sharing one or more stretches of line (the user's rule 2, 2026-10-09); `a` is listed first. */
export interface Overlap {
  a: string;
  b: string;
  stretches: Stretch[];
}

/** Shorter than this (px) is a single point: wires that cross or meet end to end do not overlap. */
const MIN = 0.01;

interface Seg { id: string; lo: number; hi: number }

/**
 * The runs of drawn wires by the line they lie on (a level run by its y, an upright one by its x), so a path's shared
 * stretches are found by looking only at the runs on its own lines: cheap enough to ask on every pointer move.
 */
export class LineIndex {
  private readonly level = new Map<number, Seg[]>();
  private readonly upright = new Map<number, Seg[]>();

  add(id: string, points: readonly Pt[]): void {
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, ay] = points[i]!, [bx, by] = points[i + 1]!;
      if (ay === by && ax !== bx) push(this.level, ay, { id, lo: Math.min(ax, bx), hi: Math.max(ax, bx) });
      else if (ax === bx && ay !== by) push(this.upright, ax, { id, lo: Math.min(ay, by), hi: Math.max(ay, by) });
    }
  }

  /** The stretches `points` shares with each indexed wire that `counts`, by that wire. */
  stretches(points: readonly Pt[], counts: (id: string) => boolean): Map<string, Stretch[]> {
    const out = new Map<string, Stretch[]>();
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, ay] = points[i]!, [bx, by] = points[i + 1]!;
      const levelRun = ay === by && ax !== bx;
      if (!levelRun && !(ax === bx && ay !== by)) continue;
      const lo = levelRun ? Math.min(ax, bx) : Math.min(ay, by), hi = levelRun ? Math.max(ax, bx) : Math.max(ay, by);
      for (const s of (levelRun ? this.level.get(ay) : this.upright.get(ax)) ?? []) {
        const from = Math.max(lo, s.lo), to = Math.min(hi, s.hi);
        if (to - from <= MIN || !counts(s.id)) continue;
        const stretch: Stretch = levelRun ? [[from, ay], [to, ay]] : [[ax, from], [ax, to]];
        const list = out.get(s.id);
        if (list) list.push(stretch); else out.set(s.id, [stretch]);
      }
    }
    return out;
  }
}

function push(m: Map<number, Seg[]>, k: number, s: Seg) {
  const l = m.get(k);
  if (l) l.push(s); else m.set(k, [s]);
}

/** Every pair of different wires that share a stretch of line, in the order the lines come (crossings are not overlaps). */
export function overlapsOf(lines: readonly { id: string; points: readonly Pt[] }[]): Overlap[] {
  const ix = new LineIndex();
  const out: Overlap[] = [];
  for (const { id, points } of lines) {
    for (const [other, stretches] of ix.stretches(points, (x) => x !== id)) out.push({ a: other, b: id, stretches });
    ix.add(id, points);
  }
  return out;
}

/**
 * Two wires that may share a stretch of line (the user's rule 2, 2026-10-09): both directed and in one net (joined
 * through junctions, so of one family), as fan-out wires sharing a trunk. A direction-less wire is in no live net, so
 * it shares a line with nothing.
 */
export function mayShare(circuit: Readonly<Circuit>, nets: readonly Net[]): (a: string, b: string) => boolean {
  const netOf = new Map<string, number>();
  nets.forEach((n, i) => { for (const x of n.wires) netOf.set(x, i); });
  const directed = (x: string) => Object.hasOwn(circuit, x) && !isFree(circuit[x]!);
  return (a, b) => a !== b && netOf.has(a) && netOf.get(a) === netOf.get(b) && directed(a) && directed(b);
}

/** The overlaps that are short circuits: every pair of wires sharing a stretch of line but those that `mayShare`. */
export function overlapShorts(lines: readonly { id: string; points: readonly Pt[] }[], circuit: Readonly<Circuit>, nets: readonly Net[]): Overlap[] {
  const share = mayShare(circuit, nets);
  return overlapsOf(lines).filter((o) => !share(o.a, o.b));
}
