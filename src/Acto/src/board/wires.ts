import type { Point, Rect } from '../model/geometry';
import type { Id, Step } from '../model/graph';

export interface Wire { id: string; from: Id; to: Id; condition: number }

export function wiresOf(stepIds: Id[], steps: ReadonlyMap<Id, Pick<Step, 'nextStepIds' | 'entryCondition'>>): Wire[] {
  const known = new Set(stepIds);
  const wires: Wire[] = [];
  const seen = new Set<string>();
  for (const from of stepIds) {
    for (const to of steps.get(from)?.nextStepIds ?? []) {
      const id = `${from}>${to}`;
      if (!known.has(to) || seen.has(id)) continue;
      seen.add(id);
      wires.push({ id, from, to, condition: steps.get(to)!.entryCondition });
    }
  }
  return wires;
}

const STYLES: Record<number, { letter: string; colour: string; name: string }> = {
  1: { letter: 'C', colour: '#0F9488', name: 'Completed' },
  2: { letter: 'F', colour: '#E0482F', name: 'Failed' },
  3: { letter: 'X', colour: '#C27C06', name: 'Cancelled' },
  4: { letter: 'A', colour: '#7C4FD6', name: 'Always' },
  5: { letter: 'N', colour: '#DB2777', name: 'Never' },
};
const INVALID = { letter: '?', colour: '#64748B', name: 'Invalid' };

export function conditionStyle(condition: number): { letter: string; colour: string; name: string } {
  return { ...(STYLES[condition] ?? INVALID) };
}

export function landings(wires: Wire[], boxOf: (id: Id) => Rect | null): Map<string, { out: Point; in: Point }> {
  const placed: Array<{ w: Wire; from: Rect; to: Rect }> = [];
  for (const w of wires) {
    const from = boxOf(w.from);
    const to = boxOf(w.to);
    if (from && to) placed.push({ w, from, to });
  }
  const centreY = (r: Rect) => r.y + r.h / 2;
  const result = new Map<string, { out: Point; in: Point }>();
  const spread = (side: 'out' | 'in') => {
    const groups = new Map<Id, typeof placed>();
    for (const p of placed) {
      const key = side === 'out' ? p.w.from : p.w.to;
      const g = groups.get(key);
      if (g) g.push(p);
      else groups.set(key, [p]);
    }
    for (const g of groups.values()) {
      const other = (p: (typeof placed)[number]) => centreY(side === 'out' ? p.to : p.from);
      const sorted = [...g].sort((a, b) => other(a) - other(b));
      const n = sorted.length;
      sorted.forEach((p, k) => {
        const own = side === 'out' ? p.from : p.to;
        const frac = n === 1 ? 0.5 : 0.22 + (0.56 * k) / (n - 1);
        const pt = { x: side === 'out' ? own.x + own.w : own.x, y: own.y + own.h * frac };
        const entry = result.get(p.w.id) ?? { out: { x: 0, y: 0 }, in: { x: 0, y: 0 } };
        entry[side] = pt;
        result.set(p.w.id, entry);
      });
    }
  };
  spread('out');
  spread('in');
  return result;
}
