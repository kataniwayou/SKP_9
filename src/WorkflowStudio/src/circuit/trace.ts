import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Id } from '../model/graph';
import type { Circuit } from './circuit';

/** What the current does (plan 9 §7): which step inputs each source reaches, and whether wires alone close a loop (§2.2-3). */
export interface Trace {
  /** By source (a step id or `wf`): the steps whose input its current reaches, each once, in the order first reached. */
  links: Map<SourceId, Id[]>;
  /** Current can come back into a wire it left without passing through a step. */
  loop: boolean;
}

type Graph = Map<string, string[]>;

/**
 * The circuit as points the current flows between: `src:{s}` (a step's output, `src:wf` the hub), `in:{t}` (a step's
 * input), and along each wire `p:{id}:{i}`: its tail (0), the junctions on it in order of `at`, its head (last).
 * A head junction pours into its host at its point; a tail junction leaves from its host's point. At equal `at`
 * a tail junction comes first, so they never meet (decision 8). An end on its own wire, or on a wire that is not in
 * the circuit, is no connection.
 */
function pointGraph(circuit: Readonly<Circuit>, skip: ReadonlySet<string>): Graph {
  const ids = Object.keys(circuit).filter((id) => !skip.has(id));
  const live = new Set(ids);
  const events = new Map<string, { at: number; order: 0 | 1; key: string }[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    const { tail, head } = circuit[id]!;
    if (tail.on === 'wire' && tail.host !== id && live.has(tail.host)) events.get(tail.host)!.push({ at: tail.at, order: 0, key: `t:${id}` });
    if (head.on === 'wire' && head.host !== id && live.has(head.host)) events.get(head.host)!.push({ at: head.at, order: 1, key: `h:${id}` });
  }
  const adj: Graph = new Map();
  const edge = (a: string, b: string) => { const l = adj.get(a); if (l) l.push(b); else adj.set(a, [b]); };
  const index = new Map<string, number>();
  const last = new Map<string, number>();
  for (const id of ids) {
    const list = events.get(id)!.sort((a, b) => a.at - b.at || a.order - b.order);
    for (let i = 0; i <= list.length; i++) edge(`p:${id}:${i}`, `p:${id}:${i + 1}`);
    list.forEach((e, k) => index.set(e.key, k + 1));
    last.set(id, list.length + 1);
  }
  for (const id of ids) {
    const { tail, head } = circuit[id]!;
    if (tail.on === 'step') edge(`src:${tail.step}`, `p:${id}:0`);
    else if (tail.on === 'hub') edge(`src:${WORKFLOW_SOURCE}`, `p:${id}:0`);
    else if (tail.on === 'wire' && index.has(`t:${id}`)) edge(`p:${tail.host}:${index.get(`t:${id}`)}`, `p:${id}:0`);
    const end = `p:${id}:${last.get(id)}`;
    if (head.on === 'step') edge(end, `in:${head.step}`);
    else if (head.on === 'wire' && index.has(`h:${id}`)) edge(end, `p:${head.host}:${index.get(`h:${id}`)}`);
  }
  return adj;
}

/** Every point reachable from `from`, in breadth-first order. */
function reach(adj: Graph, from: string): string[] {
  const seen = new Set([from]);
  const order: string[] = [];
  for (let i = 0, queue = [from]; i < queue.length; i++) {
    for (const m of adj.get(queue[i]!) ?? []) {
      if (seen.has(m)) continue;
      seen.add(m);
      order.push(m);
      if (!m.startsWith('in:')) queue.push(m);
    }
  }
  return order;
}

function hasCycle(adj: Graph): boolean {
  const state = new Map<string, 1 | 2>();
  for (const start of adj.keys()) {
    if (state.has(start)) continue;
    const stack: [string, number][] = [[start, 0]];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const next = adj.get(top[0]) ?? [];
      if (top[1] < next.length) {
        const m = next[top[1]]!;
        top[1] += 1;
        const s = state.get(m);
        if (s === 1) return true;
        if (s === undefined) { state.set(m, 1); stack.push([m, 0]); }
      } else {
        state.set(top[0], 2);
        stack.pop();
      }
    }
  }
  return false;
}

/**
 * Follows the current (plan 9 §7): from a step's output or the hub along each wire to its head; a head junction
 * pours into its host at its point and reaches what lies further along (the host's head and the tail junctions past
 * that point); a tail junction takes what entered its host before its point. An open end carries nothing on.
 * `skip`: wires left out (a short-circuited net, spec §2.2-7).
 */
export function trace(circuit: Readonly<Circuit>, skip: ReadonlySet<string> = new Set()): Trace {
  const adj = pointGraph(circuit, skip);
  const links = new Map<SourceId, Id[]>();
  for (const from of adj.keys()) {
    if (!from.startsWith('src:')) continue;
    const reached = reach(adj, from).filter((n) => n.startsWith('in:')).map((n) => n.slice(3));
    if (reached.length > 0) links.set(from.slice(4), reached);
  }
  return { links, loop: hasCycle(adj) };
}

/** The wires on a closed loop of wires (spec §2.2-3): a point of theirs that current can leave and come back to. */
export function loopWires(circuit: Readonly<Circuit>): Set<string> {
  const adj = pointGraph(circuit, new Set());
  const out = new Set<string>();
  for (const from of adj.keys()) {
    if (!from.startsWith('p:')) continue;
    const id = from.slice(2, from.lastIndexOf(':'));
    if (out.has(id)) continue;
    const seen = new Set<string>();
    const stack = [...(adj.get(from) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n === from) { out.add(id); break; }
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(adj.get(n) ?? []));
    }
  }
  return out;
}

/** The links as `source->target` keys. */
export const linkKeys = (links: ReadonlyMap<SourceId, readonly Id[]>): Set<string> =>
  new Set([...links].flatMap(([s, ts]) => ts.map((t) => `${s}->${t}`)));

/** The wires current from `source` passes through on its way into `target`'s input. */
export function wiresBetween(circuit: Readonly<Circuit>, source: SourceId, target: Id, skip: ReadonlySet<string> = new Set()): Set<string> {
  const adj = pointGraph(circuit, skip);
  const back: Graph = new Map();
  for (const [a, bs] of adj) for (const b of bs) { const l = back.get(b); if (l) l.push(a); else back.set(b, [a]); }
  const into = new Set(reach(back, `in:${target}`));
  const out = new Set<string>();
  for (const n of reach(adj, `src:${source}`)) if (n.startsWith('p:') && into.has(n)) out.add(n.slice(2, n.lastIndexOf(':')));
  return out;
}
