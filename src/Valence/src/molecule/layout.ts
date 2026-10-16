import { TYPES, type ArrowKind, type Molecule } from './model';

export type Vec = [number, number, number];

/**
 * The mock's layout (docs/valence/molecule-mock.html), for the whole project: each workflow is a band of its own in the
 * mock's reading order, and the bands are packed into rows like text on a page.
 *
 * In a band, steps stand in columns by hop count from the workflow's entry steps: one column per hop, left to right; a
 * fan-out puts its branches in the same column, side by side. A failure hand-off step (entered on PreviousFailed or
 * PreviousCancelled, reached from several steps) stays out of the flow, below its middle, with its own next steps to its
 * right. Processors stand above their steps, behind the flow; schemas settle above their processors, assignments below
 * their steps, caches below their workflows. Steps no workflow reaches get a band of their own; rows nothing points at
 * and that point at nothing (a schema or processor no one uses, a cache in no workflow) are laid out in a grid band.
 * Springs then relax the free atoms around the steps and processors, which hold their places.
 */
export function layoutMolecule(m: Molecule): Map<string, Vec> {
  const keys = [...m.atoms.keys()];
  const typeOf = (k: string) => m.atoms.get(k)!.type;
  const out = (k: string, kind: ArrowKind) => m.arrows.filter((x) => x.from === k && x.kind === kind).map((x) => x.to);
  const into = (k: string, kind: ArrowKind) => m.arrows.filter((x) => x.to === k && x.kind === kind).map((x) => x.from);
  const byName = (a: string, b: string) => m.atoms.get(a)!.name.localeCompare(m.atoms.get(b)!.name) || a.localeCompare(b);

  const GAP = 4.2, LANE = 2.6, OFF = 5, BAND_GAP = 4;
  let rnd = 7;
  const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;

  // ---------- Bands: one per workflow, one for the steps no workflow reaches ----------
  interface Band { columns: string[][]; off: string[]; wf: string | null; local: Map<string, Vec>; minX: number; maxX: number; top: number; bottom: number; origin: Vec }
  const owned = new Set<string>();
  const handOff = (k: string) => {
    const c = m.atoms.get(k)!.condition;
    return (c === 2 || c === 3) && new Set(into(k, 'next')).size >= 2;
  };
  function band(wf: string | null, roots: string[]): Band | null {
    const level = new Map<string, number>();
    const off: string[] = [];
    const todo: string[] = [];
    for (const r of roots) if (!owned.has(r) && !level.has(r)) { level.set(r, 0); owned.add(r); todo.push(r); }
    if (todo.length === 0) return null;
    const visit = (from: string, next: string[]) => {
      for (const n of next.sort(byName)) {
        if (owned.has(n)) continue;
        owned.add(n);
        if (handOff(n)) off.push(n); else { level.set(n, level.get(from)! + 1); todo.push(n); }
      }
    };
    for (let k = todo.shift(); k !== undefined; k = todo.shift()) visit(k, out(k, 'next'));
    // the hand-off row: each hand-off step, then the steps only it leads to, left to right
    const offRow: string[] = [];
    for (let i = 0; i < off.length; i++) {
      offRow.push(off[i]!);
      for (let n = off[i]!; ;) {
        const nx = out(n, 'next').sort(byName).find((x) => !owned.has(x));
        if (!nx) break;
        owned.add(nx); offRow.push(nx); n = nx;
      }
    }
    const columns: string[][] = [];
    level.forEach((l, n) => (columns[l] ??= []).push(n));
    const lanes = Math.max(1, ...columns.map((c) => c.length));
    const local = new Map<string, Vec>();
    columns.forEach((col, l) => col.forEach((n, i) => local.set(n, [l * GAP, ((col.length - 1) / 2 - i) * LANE, 0])));
    const half = ((lanes - 1) / 2) * LANE;
    const offStart = ((columns.length - 1) / 2) * GAP;
    offRow.forEach((n, i) => local.set(n, [offStart + i * GAP, -half - OFF, 0]));
    const maxX = Math.max((columns.length - 1) * GAP, offRow.length ? offStart + (offRow.length - 1) * GAP : 0) + 2;
    return { columns, off: offRow, wf, local, minX: -6, maxX, top: half + 7, bottom: -(offRow.length ? half + OFF : half) - 3, origin: [0, 0, 0] };
  }

  const bands: Band[] = [];
  const workflows = keys.filter((k) => typeOf(k) === 'wf').sort(byName);
  for (const wf of workflows) { const b = band(wf, out(wf, 'entry')); if (b) bands.push(b); }
  // the steps no workflow reaches: from those no stray step leads to (all of them when they only form loops)
  const stray = () => keys.filter((k) => typeOf(k) === 'step' && !owned.has(k)).sort(byName);
  for (let left = stray(); left.length > 0; left = stray()) {
    const roots = left.filter((k) => !into(k, 'next').some((p) => left.includes(p)));
    const b = band(null, roots.length ? roots : [left[0]!]);
    if (b) bands.push(b);
  }

  // what no band places: rows that neither point at anything placed nor are pointed at by it
  const users = (k: string) => m.arrows.filter((x) => x.to === k).map((x) => x.from);
  const loose = keys.filter((k) => {
    const t = typeOf(k);
    if (t === 'proc') return into(k, 'uses').length === 0;
    if (t === 'schema') return users(k).every((p) => into(p, 'uses').length === 0);
    if (t === 'cache') return into(k, 'wfCache').length === 0;
    if (t === 'wf') return out(k, 'entry').length === 0;
    return false;
  }).sort(byName);
  if (loose.length > 0) {
    const cols = Math.ceil(Math.sqrt(loose.length * 2));
    const local = new Map<string, Vec>();
    loose.forEach((k, i) => local.set(k, [(i % cols) * 2.4, -Math.floor(i / cols) * 2.4, 0]));
    const rows = Math.ceil(loose.length / cols);
    bands.push({ columns: [], off: [], wf: null, local, minX: -2, maxX: (cols - 1) * 2.4 + 2, top: 2, bottom: -(rows - 1) * 2.4 - 2, origin: [0, 0, 0] });
  }

  // ---------- Pack the bands into rows ----------
  const width = (b: Band) => b.maxX - b.minX, height = (b: Band) => b.top - b.bottom;
  const area = bands.reduce((s, b) => s + width(b) * height(b), 0);
  const rowWidth = Math.max(...bands.map(width), Math.sqrt(area) * 1.6, 1);
  let x = 0, y = 0, rowHeight = 0;
  for (const b of bands) {
    if (x > 0 && x + width(b) > rowWidth) { x = 0; y -= rowHeight + BAND_GAP; rowHeight = 0; }
    b.origin = [x - b.minX, y - b.top, 0];
    x += width(b) + BAND_GAP;
    rowHeight = Math.max(rowHeight, height(b));
  }

  // ---------- Seeds ----------
  const seed = new Map<string, Vec>();
  const pinned = new Set<string>();
  const bandOf = new Map<string, Band>();
  const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mean = (vs: Vec[]): Vec => vs.reduce((s, v) => add(s, v), [0, 0, 0] as Vec).map((c) => c / Math.max(vs.length, 1)) as Vec;
  for (const b of bands) b.local.forEach((p, k) => { seed.set(k, add(b.origin, p)); bandOf.set(k, b); if (typeOf(k) === 'step') pinned.add(k); });
  for (const b of bands) {
    if (!b.wf) continue;
    const entry = out(b.wf, 'entry').map((k) => seed.get(k)).filter((v): v is Vec => !!v);
    seed.set(b.wf, entry.length ? add(entry[0]!, [-4, -1.5, 0.5]) : add(b.origin, [-4, 0, 0]));
  }
  // workflows whose entry steps another workflow's band already holds stand left of those steps
  for (const wf of workflows) if (!seed.has(wf)) {
    const entry = out(wf, 'entry').map((k) => seed.get(k)).filter((v): v is Vec => !!v);
    seed.set(wf, entry.length ? add(entry[0]!, [-4, 1.5, 1.5]) : [0, 0, 0]);
  }
  for (const k of keys) {
    if (typeOf(k) !== 'proc' || seed.has(k)) continue;
    const steps = into(k, 'uses').filter((s) => seed.has(s));
    const at = steps.map((s) => seed.get(s)!);
    const c = mean(at);
    const homes = new Set(steps.map((s) => bandOf.get(s)));
    const offOnly = steps.every((s) => bandOf.get(s)?.off.includes(s));
    // above the highest of its own steps (below, for hand-off steps), behind the flow
    seed.set(k, [c[0], offOnly ? Math.min(...at.map((v) => v[1])) - 3 : Math.max(...at.map((v) => v[1])) + 3.2, -2.2]);
    if (homes.size === 1) pinned.add(k);
  }
  for (const k of keys) {
    if (typeOf(k) !== 'schema' || seed.has(k)) continue;
    const c = mean(users(k).map((p) => seed.get(p)).filter((v): v is Vec => !!v));
    seed.set(k, add(c, [(rand() - 0.5) * 2, 2.8, -2.4 + (rand() - 0.5) * 2]));
  }
  for (const k of keys) {
    const t = typeOf(k);
    if (seed.has(k)) continue;
    if (t === 'asg') { const s = out(k, 'asg')[0]; seed.set(k, add(s ? seed.get(s) ?? [0, 0, 0] : [0, 0, 0], [0, -1.8, 2])); }
    if (t === 'cache') seed.set(k, add(mean(into(k, 'wfCache').map((w) => seed.get(w)!)), [0, -3.5, -2]));
  }

  // ---------- Relax the free atoms ----------
  const pos = new Map<string, Vec>(keys.map((k) => [k, add(seed.get(k) ?? [0, 0, 0], [rand() - 0.5, rand() - 0.5, rand() - 0.5])]));
  const vel = new Map<string, Vec>(keys.map((k) => [k, [0, 0, 0]]));
  // Workflow → Assignment arrows are long and many; they get no spring, or they would drag every assignment to the hub.
  const REST: Partial<Record<ArrowKind, number>> = { entry: 3.6, wfCache: 3.2, uses: 2.6, asg: 1.5, input: 3.2, output: 3.2, config: 2.6 };
  const P = keys.map((k) => pos.get(k)!), V = keys.map((k) => vel.get(k)!), S = keys.map((k) => seed.get(k) ?? [0, 0, 0]);
  const index = new Map(keys.map((k, i) => [k, i]));
  const springs = m.arrows.filter((x) => REST[x.kind]).map((x) => [index.get(x.from)!, index.get(x.to)!, REST[x.kind]!] as const);
  const isPinned = keys.map((k) => pinned.has(k));
  const pull = keys.map((k) => (typeOf(k) === 'step' || typeOf(k) === 'wf' ? 0.05 : 0.012));
  for (let it = 0; it < 460; it++) {
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i]!, b = P[j]!;
      const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      const d = Math.max(Math.hypot(dx, dy, dz), 0.3);
      if (d > 7) continue;
      const f = 0.9 / (d * d * d);
      V[i]![0] += dx * f; V[i]![1] += dy * f; V[i]![2] += dz * f;
      V[j]![0] -= dx * f; V[j]![1] -= dy * f; V[j]![2] -= dz * f;
    }
    for (const [i, j, rest] of springs) {
      const a = P[i]!, b = P[j]!;
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const d = Math.max(Math.hypot(dx, dy, dz), 1e-6);
      const f = ((d - rest) * 0.06) / d;
      V[i]![0] += dx * f; V[i]![1] += dy * f; V[i]![2] += dz * f;
      V[j]![0] -= dx * f; V[j]![1] -= dy * f; V[j]![2] -= dz * f;
    }
    for (let i = 0; i < P.length; i++) {
      const p = P[i]!, v = V[i]!, s = S[i]!;
      for (let c = 0; c < 3; c++) { v[c]! += (s[c]! - p[c]!) * pull[i]!; v[c]! *= 0.5; p[c]! += v[c]!; }
      if (isPinned[i]) { p[0] = s[0]; p[1] = s[1]; p[2] = s[2]; v[0] = v[1] = v[2] = 0; }
    }
  }

  // ---------- Nothing sits on an arrow ----------
  // Arrows are straight: step free atoms off any arrow line they block, or, when the blocker holds its place, step the
  // arrow's free end aside instead.
  for (let it = 0; it < 200; it++) {
    let moved = false;
    for (const x of m.arrows) {
      const ia = index.get(x.from)!, ib = index.get(x.to)!, a = P[ia]!, b = P[ib]!;
      const ab: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-9;
      for (let io = 0; io < P.length; io++) {
        if (io === ia || io === ib) continue;
        const o = P[io]!;
        const t = Math.min(1, Math.max(0, ((o[0] - a[0]) * ab[0] + (o[1] - a[1]) * ab[1] + (o[2] - a[2]) * ab[2]) / len2));
        const q: Vec = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
        let push: Vec = [o[0] - q[0], o[1] - q[1], o[2] - q[2]];
        const d = Math.hypot(...push), need = TYPES[typeOf(keys[io]!)].r + 0.35;
        if (d >= need) continue;
        if (d < 1e-3) push = [0, 0, 1];
        const n = Math.hypot(...push), step = Math.min(need - d, 0.2);
        push = [(push[0] / n) * step, (push[1] / n) * step, (push[2] / n) * step];
        if (!isPinned[io]) { o[0] += push[0]; o[1] += push[1]; o[2] += push[2]; }
        else {
          const end = !isPinned[ib] ? P[ib]! : !isPinned[ia] ? P[ia]! : null;
          if (!end) continue;
          end[0] -= push[0]; end[1] -= push[1]; end[2] -= push[2];
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  // centred on the origin
  const c = mean(P);
  return new Map(keys.map((k, i) => [k, [P[i]![0] - c[0], P[i]![1] - c[1], P[i]![2] - c[2]] as Vec]));
}

/** The radius of the sphere, about the origin, that holds every atom: the camera backs off to fit it. */
export function extentOf(positions: ReadonlyMap<string, Vec>): number {
  let r = 1;
  positions.forEach((p) => { r = Math.max(r, Math.hypot(...p)); });
  return r;
}
