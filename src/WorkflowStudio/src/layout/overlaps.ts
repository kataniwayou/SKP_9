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

  /** How many stretches `points` shares with indexed wires that `counts` (as `stretches`, without building them). */
  count(points: readonly Pt[], counts: (id: string) => boolean): number {
    let n = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!, b = points[i + 1]!;
      const levelRun = a[1] === b[1] && a[0] !== b[0];
      if (!levelRun && !(a[0] === b[0] && a[1] !== b[1])) continue;
      const list = levelRun ? this.level.get(a[1]) : this.upright.get(a[0]);
      if (list === undefined) continue;
      const lo = levelRun ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]), hi = levelRun ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
      for (const s of list) if (Math.min(hi, s.hi) - Math.max(lo, s.lo) > MIN && counts(s.id)) n++;
    }
    return n;
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
 * through junctions, so of one family), as fan-out wires sharing a trunk; or (the user's ruling, 2026-10-09) both with
 * their tails on the same step's output, or both on the hub, and of the same colour (one family each, the same, or both
 * still undecided), as siblings sharing a bus. A direction-less wire is in no live net, so it shares a line with
 * nothing; a wire of a short-circuited net (two families) has no one colour to share.
 */
export function mayShare(circuit: Readonly<Circuit>, nets: readonly Net[]): (a: string, b: string) => boolean {
  // a directed wire's net; a direction-less one (in no live net) is left out
  const netOf = new Map<string, number>();
  nets.forEach((n, i) => { for (const x of n.wires) if (Object.hasOwn(circuit, x) && !isFree(circuit[x]!)) netOf.set(x, i); });
  /** What a wire's tail is on when that is a step or the hub, and its net's one colour (-1: undecided); null otherwise. */
  const sibling = (x: string): { source: string; colour: number } | null => {
    const n = netOf.get(x);
    if (n === undefined) return null;
    const t = circuit[x]!.tail;
    const source = t.on === 'step' ? `s:${t.step}` : t.on === 'hub' ? 'hub' : null;
    const families = nets[n]!.families;
    return source === null || families.length > 1 ? null : { source, colour: families[0] ?? -1 };
  };
  return (a, b) => {
    if (a === b) return false;
    const n = netOf.get(a);
    if (n === undefined) return false;
    if (n === netOf.get(b)) return true;
    const p = sibling(a), q = sibling(b);
    return p !== null && q !== null && p.source === q.source && p.colour === q.colour;
  };
}

/** The overlaps that are short circuits: every pair of wires sharing a stretch of line but those that `mayShare`. */
export function overlapShorts(lines: readonly { id: string; points: readonly Pt[] }[], circuit: Readonly<Circuit>, nets: readonly Net[]): Overlap[] {
  const share = mayShare(circuit, nets);
  return overlapsOf(lines).filter((o) => !share(o.a, o.b));
}
