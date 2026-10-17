import type { Vec } from '../molecule/layout';
import { reachOf, TYPES, type ArrowKind, type AtomType, type Molecule } from '../molecule/model';

/**
 * AI drawing (the user, 2026-10-17, "based on SKP Studio"): the wand gives the model (Kimi K3, behind Valence's own nginx
 * route `/ai/`, as SKP Studio's) the spine rules and the selected workflows' atoms and arrows; the model answers with a
 * place for every atom. The model only places: it cannot add, remove or relink an atom. Places are the canvas's view
 * only (kept in this browser); nothing reaches BaseApi.
 */

/** The spine rules (approved on the preview, 2026-10-17), highest priority first. */
export const SPINE_RULES = `Layout rules for SKP Valence's molecule, highest priority first. When two rules conflict, the higher one wins.
Coordinates are scene units in 3D: x runs along a workflow's spine (left to right), y is up, z is depth (towards the viewer). Every atom is a ball of the radius given for it.

Correctness (never broken)
1. Place every atom you are given, by its id, and no other. Never change what links to what: you only choose places.
2. No two atoms overlap: the distance between two atoms' centres is at least the sum of their radii plus 0.4.
3. No atom sits on an arrow it is not part of: each atom's centre stays at least its radius plus 0.3 away from the straight line between the two atoms of any other arrow.

The spine
4. A workflow's steps are its spine: they run left to right on one straight line (one y and one z), one hop per column, 5.2 units apart, in hop order from the workflow's entry steps (an entry step is hop 0, its next steps hop 1, and so on). A next-step arrow always points to the right, except a loop back.
5. The workflow stands at the head of its spine, on the spine's line, 4.7 units left of the first column.
6. A fan-out's branches (the several steps of one column) stand on a circle round the spine's line, in the y–z plane: radius at least 2.4 and enough that neighbouring branches are 2.4 apart, the first branch at the top. They meet again at the fan-in step, back on the line.
7. Hand-off steps (entered on PreviousFailed or PreviousCancelled, from several steps) and the steps only they lead to run on a track of their own, parallel to the spine and below it.

The ring round each step
8. Each step has an outward direction: up (+y) for a step on the spine's line; straight away from the line for a branch; down (−y) for a step on the hand-off track.
9. A step's processor stands 2.7 out from the step along its outward direction. The processor's schemas stand beyond it, about 2.1 further out: the input schema to one side, the output schema to the other side, the config schema at the tip.
10. A step's assignments stand close on its other side, 1.5 from it; several on one step are spread along the spine, 0.9 apart.
11. Caches stand under their workflow, 2.6 below it.

Shared atoms
12. A processor used by several steps stands over the middle of them, 1.2 further out than a processor of one step. A processor or schema used from several workflows stands between those workflows' spines, about 4 towards the viewer (+z).

Several workflows
13. The workflows are parallel spines (lanes), stacked so that the whole is about as wide as a screen (16:9); workflows that share atoms are neighbours. Lanes keep at least 3 units between their rings.

Finish
14. Check before answering: every step of a spine on its line and in its column, every next-step arrow pointing right, no overlap, every processor out from its step, assignments on the other side, shared atoms between their users.`;

/** The answer's shape, as the model is told it. */
export const ANSWER_SCHEMA = `Answer with ONE JSON object and nothing else:
{ "atoms": { "<atom id>": [x, y, z] } }
- Every atom id you were given, each exactly once, with three numbers (one decimal is enough). Never invent ids.
- Only the places: do not repeat names, types or arrows.`;

export class DrawingError extends Error {}
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
/** How much of one answer has arrived: the characters of the model's thinking and of its answer. */
export interface StreamProgress { thinking: number; writing: number }

/** A round is given up after this long without a word from the model; a press after its total (as SKP Studio's). */
export const AI_SILENCE_MS = 60_000;
export const AI_TOTAL_MS = 15 * 60_000;
const AI_EFFORT = 'low';

/** What the model lays out: the selected workflows' atoms, each by a short id, and the arrows between them. */
export interface Scope {
  /** atom key → the short id the model sees ("a1", "a2", …), and back */
  idOf: Map<string, string>;
  keyOf: Map<string, string>;
  keys: string[];
  types: Map<string, AtomType>;
  arrows: { kind: ArrowKind; from: string; to: string }[];
  workflows: string[];
}

/** The atoms the picked workflows reach (their steps, processors, schemas, assignments, caches), with the arrows among them. */
export function scopeOf(molecule: Molecule, workflowKeys: readonly string[]): Scope {
  const keys: string[] = [];
  const seen = new Set<string>();
  const workflows = workflowKeys.filter((k) => molecule.atoms.get(k)?.type === 'wf');
  for (const wf of workflows) for (const k of reachOf(molecule, wf)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const idOf = new Map(keys.map((k, i) => [k, `a${i + 1}`]));
  return {
    idOf, keyOf: new Map([...idOf].map(([k, id]) => [id, k])), keys,
    types: new Map(keys.map((k) => [k, molecule.atoms.get(k)!.type])),
    arrows: molecule.arrows.filter((x) => seen.has(x.from) && seen.has(x.to)).map((x) => ({ kind: x.kind, from: x.from, to: x.to })),
    workflows,
  };
}

const CONDITION: Readonly<Record<number, string>> = { 1: 'PreviousCompleted', 2: 'PreviousFailed', 3: 'PreviousCancelled', 4: 'Always' };
const ARROW: Readonly<Record<ArrowKind, string>> = {
  entry: 'workflow → entry step', wfAsg: 'workflow → assignment', wfCache: 'workflow → cache', next: 'step → next step',
  uses: 'step → its processor', asg: 'assignment → its step', input: 'processor → input schema', output: 'processor → output schema', config: 'processor → config schema',
};

/** The molecule as the model reads it: every atom with its type, name and radius; every arrow by kind. */
export function graphOf(molecule: Molecule, scope: Scope): object {
  const id = (k: string) => scope.idOf.get(k)!;
  return {
    atoms: scope.keys.map((k) => {
      const a = molecule.atoms.get(k)!;
      return { id: id(k), type: TYPES[a.type].label.toLowerCase(), name: a.name, radius: TYPES[a.type].r, ...(a.type === 'step' && a.condition ? { entryCondition: CONDITION[a.condition] } : {}) };
    }),
    arrows: scope.arrows.map((x) => ({ kind: ARROW[x.kind], from: id(x.from), to: id(x.to) })),
  };
}

/** The system and user messages for one drawing. */
export function firstMessages(molecule: Molecule, scope: Scope): ChatMessage[] {
  const names = scope.workflows.map((k) => molecule.atoms.get(k)!.name).join(', ');
  return [
    { role: 'system', content: `You lay out workflow molecules in SKP Valence, in 3D.\n\n${SPINE_RULES}\n\n${ANSWER_SCHEMA}` },
    { role: 'user', content: `Lay out ${scope.workflows.length === 1 ? 'this workflow' : `these ${scope.workflows.length} workflows`} (${names}) by the rules. The molecule:\n${JSON.stringify(graphOf(molecule, scope))}` },
  ];
}

/** The one correction round: the refused answer and exactly why, and a request for the whole answer again. */
export const correctionMessages = (first: readonly ChatMessage[], answer: string, reason: string): ChatMessage[] => [
  ...first, { role: 'assistant', content: answer },
  { role: 'user', content: `Valence refused that answer: ${reason}. Answer again with the whole corrected JSON object, following the schema exactly.` },
];

/** The one refinement round: the accepted drawing's problems, and a request to fix them changing as little as it can. */
export const refinementMessages = (messages: readonly ChatMessage[], answer: string, problems: readonly string[]): ChatMessage[] => [
  ...messages, { role: 'assistant', content: answer },
  { role: 'user', content: `Valence accepted the drawing. These problems remain:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nFix them by the rules, changing as little else as you can. Answer with the whole JSON object again (every atom id).` },
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type Judged = { ok: true; places: Map<string, Vec> } | { ok: false; reason: string };

/** Reads the model's answer: every atom of the scope placed, by its id, with three numbers, and nothing else. */
export function judgeDrawing(scope: Scope, text: string): Judged {
  let body: unknown;
  try {
    body = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return { ok: false, reason: 'the answer is not one JSON object' };
  }
  if (!isObj(body) || !isObj(body.atoms)) return { ok: false, reason: 'the answer has no "atoms" object' };
  const places = new Map<string, Vec>();
  const unknown: string[] = [], broken: string[] = [];
  for (const [id, p] of Object.entries(body.atoms)) {
    const key = scope.keyOf.get(id);
    if (!key) { unknown.push(id); continue; }
    if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) { broken.push(id); continue; }
    places.set(key, [p[0], p[1], p[2]]);
  }
  const missing = scope.keys.filter((k) => !places.has(k) && !broken.includes(scope.idOf.get(k)!)).map((k) => scope.idOf.get(k)!);
  const parts = [
    unknown.length ? `ids that were not given: ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? ', …' : ''}` : '',
    broken.length ? `places that are not three numbers: ${broken.slice(0, 8).join(', ')}${broken.length > 8 ? ', …' : ''}` : '',
    missing.length ? `${missing.length} atom${missing.length === 1 ? '' : 's'} not placed: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}` : '',
  ].filter(Boolean);
  return parts.length ? { ok: false, reason: parts.join('; ') } : { ok: true, places };
}

/** What a drawing still breaks of the rules Valence can check: overlaps, and next-step arrows that point left. */
export function problemsOf(scope: Scope, places: ReadonlyMap<string, Vec>): string[] {
  const out: string[] = [];
  const id = (k: string) => scope.idOf.get(k)!;
  const r = (k: string) => TYPES[scope.types.get(k)!].r;
  const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const overlaps: string[] = [];
  for (let i = 0; i < scope.keys.length; i++) for (let j = i + 1; j < scope.keys.length; j++) {
    const a = scope.keys[i]!, b = scope.keys[j]!;
    if (dist(places.get(a)!, places.get(b)!) < r(a) + r(b) + 0.4) overlaps.push(`${id(a)} and ${id(b)}`);
  }
  if (overlaps.length) out.push(`${overlaps.length} pair${overlaps.length === 1 ? '' : 's'} of atoms overlap (rule 2): ${overlaps.slice(0, 10).join('; ')}${overlaps.length > 10 ? '; …' : ''}`);
  // a next-step arrow points left: only along a spine (not a loop back, not into a hand-off step)
  const hop = hopsOf(scope);
  const left = scope.arrows.filter((x) => x.kind === 'next' && hop.has(x.from) && hop.has(x.to) && hop.get(x.to)! > hop.get(x.from)!
    && places.get(x.to)![0] <= places.get(x.from)![0] + 0.5).map((x) => `${id(x.from)} → ${id(x.to)}`);
  if (left.length) out.push(`${left.length} next-step arrow${left.length === 1 ? '' : 's'} do not point right (rule 4): ${left.slice(0, 10).join('; ')}${left.length > 10 ? '; …' : ''}`);
  return out;
}

/** Each spine step's hop from its workflow's entry steps (hand-off steps and those only they reach are left out). */
function hopsOf(scope: Scope): Map<string, number> {
  const hop = new Map<string, number>();
  const next = (k: string) => scope.arrows.filter((x) => x.kind === 'next' && x.from === k).map((x) => x.to);
  for (const wf of scope.workflows) {
    const todo = scope.arrows.filter((x) => x.kind === 'entry' && x.from === wf).map((x) => x.to);
    todo.forEach((k) => { if (!hop.has(k)) hop.set(k, 0); });
    for (let k = todo.shift(); k !== undefined; k = todo.shift()) for (const n of next(k)) if (!hop.has(n)) { hop.set(n, hop.get(k)! + 1); todo.push(n); }
  }
  return hop;
}

/**
 * The drawing on the canvas: moved so the selected workflows stay where they stood (the centre of their atoms' box), then
 * one pass pushes apart atoms that still overlap (the steps and workflows hold their places).
 */
export function placed(scope: Scope, places: ReadonlyMap<string, Vec>, current: ReadonlyMap<string, Vec>): Map<string, Vec> {
  const centre = (ps: Vec[]) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of ps) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c]!, p[c]!); hi[c] = Math.max(hi[c]!, p[c]!); }
    return lo.map((l, c) => (l + hi[c]!) / 2) as Vec;
  };
  const was = centre(scope.keys.map((k) => current.get(k)).filter((p): p is Vec => !!p));
  const now = centre([...places.values()]);
  const P = scope.keys.map((k) => { const p = places.get(k)!; return [p[0] - now[0] + was[0], p[1] - now[1] + was[1], p[2] - now[2] + was[2]] as Vec; });
  const fixed = scope.keys.map((k) => scope.types.get(k) === 'step' || scope.types.get(k) === 'wf');
  const r = scope.keys.map((k) => TYPES[scope.types.get(k)!].r);
  for (let it = 0; it < 60; it++) {
    let moved = false;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      if (fixed[i] && fixed[j]) continue;
      const a = P[i]!, b = P[j]!, need = r[i]! + r[j]! + 0.4;
      let d: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len = Math.hypot(...d);
      if (len >= need) continue;
      if (len < 1e-4) d = [0.3, 0.2, 0.1];
      const n = Math.hypot(...d), s = (need - len) / 2 + 0.01;
      const push: Vec = [(d[0] / n) * s, (d[1] / n) * s, (d[2] / n) * s];
      const ka = fixed[j] ? 2 : 1, kb = fixed[i] ? 2 : 1;
      if (!fixed[i]) { a[0] -= push[0] * ka; a[1] -= push[1] * ka; a[2] -= push[2] * ka; }
      if (!fixed[j]) { b[0] += push[0] * kb; b[1] += push[1] * kb; b[2] += push[2] * kb; }
      moved = true;
    }
    if (!moved) break;
  }
  return new Map(scope.keys.map((k, i) => [k, P[i]!.map((v) => Math.round(v * 1e4) / 1e4) as Vec]));
}

const NOT_CONFIGURED = 'AI drawing is not configured: Valence has no model (env KIMI_API_KEY, KIMI_BASE_URL, KIMI_MODEL_ID)';

/** The model Valence draws with: KIMI_MODEL_ID, which /ai/config reports; the key and the base URL never leave nginx. */
export async function modelOf(signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string> {
  let r: Response;
  try {
    r = await fetchFn('/ai/config', { signal });
  } catch (e) {
    if (signal.aborted) throw new DrawingError('cancelled');
    throw new DrawingError(`Valence's model settings could not be read (${e instanceof Error ? e.message : 'network error'})`);
  }
  const model: unknown = r.ok ? ((await r.json().catch(() => null)) as { model?: unknown } | null)?.model : null;
  if (typeof model !== 'string' || model.trim() === '') throw new DrawingError(NOT_CONFIGURED);
  return model;
}

/** Asks the model through Valence's own route, streamed so a long think is never cut off. The text of its answer. */
export async function requestDrawing(
  model: string, messages: readonly ChatMessage[], signal: AbortSignal, fetchFn: typeof fetch = fetch, onChunk?: (p: StreamProgress) => void,
): Promise<string> {
  let r: Response;
  try {
    r = await fetchFn('/ai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model, reasoning_effort: AI_EFFORT, response_format: { type: 'json_object' }, stream: true, messages }),
    });
  } catch (e) {
    if (signal.aborted) throw new DrawingError('cancelled');
    throw new DrawingError(`the model could not be reached (${e instanceof Error ? e.message : 'network error'})`);
  }
  if (r.status === 503 || r.status === 404) throw new DrawingError(NOT_CONFIGURED);
  if (r.status === 401 || r.status === 403) throw new DrawingError(`AI drawing is not configured: the model refused the key (HTTP ${r.status})`);
  if (!r.ok) throw new DrawingError(`the model answered HTTP ${r.status}`);
  let content: unknown;
  try {
    content = (r.headers.get('content-type') ?? '').includes('text/event-stream') && r.body ? await readStream(r.body, onChunk) : messageOf(await r.json());
  } catch (e) {
    if (signal.aborted) throw new DrawingError('cancelled');
    if (e instanceof DrawingError) throw e;
    throw new DrawingError('the model\'s reply is not JSON');
  }
  if (typeof content !== 'string' || content.trim() === '') throw new DrawingError('the model gave no drawing');
  return content;
}

const messageOf = (body: unknown): unknown =>
  (isObj(body) && Array.isArray(body.choices) && isObj(body.choices[0]) && isObj(body.choices[0].message) ? body.choices[0].message.content : undefined);

/** The answer's text from an OpenAI-style event stream: every `data:` line's delta content, until `[DONE]`. */
export async function readStream(body: ReadableStream<Uint8Array>, onChunk?: (p: StreamProgress) => void): Promise<string> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', thinking = 0;
  const line = (l: string): boolean => {
    const t = l.trim();
    if (!t.startsWith('data:')) return false;
    const data = t.slice(5).trim();
    if (data === '[DONE]') return true;
    const v: unknown = JSON.parse(data);
    if (isObj(v) && isObj(v.error)) throw new DrawingError(`the model failed: ${String(v.error.message ?? 'error').slice(0, 200)}`);
    const delta = isObj(v) && Array.isArray(v.choices) && isObj(v.choices[0]) && isObj(v.choices[0].delta) ? v.choices[0].delta : undefined;
    if (delta && typeof delta.content === 'string') text += delta.content;
    if (delta && typeof delta.reasoning_content === 'string') thinking += delta.reasoning_content.length;
    onChunk?.({ thinking, writing: text.length });
    return false;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const l of lines) if (line(l)) { void reader.cancel(); return text; }
    if (done) return text;
  }
}
