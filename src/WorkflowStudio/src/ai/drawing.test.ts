import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { setBends, setEnd } from '../circuit/circuit';
import { applyDraft } from '../design/apply';
import { circuitOf, EMPTY_DRAFT, withCircuit, type Draft } from '../design/draft';
import { applyPlan, changeOf, correctionMessages, crossingPairsOf, crossingsOf, DRAWING_RULES, firstMessages, judgeDrawing, mainPathOf, modelOf, movedBlocksOf, nearestAlong, parsePlan, promptOf, readStream, refinementMessages, relationsOf, remainingProblemsOf, requestDrawing } from './drawing';

// s1 -> s2 -> s3 (Completed), s1 -> f and s2 -> f (Failed)
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2', 'f'] }), stepDto('s2', { nextStepIds: ['s3', 'f'] }), stepDto('s3'), stepDto('f', { entryCondition: 2 })],
}));
type Doc = Awaited<ReturnType<typeof doc>>;
const pointsOf = (d: Doc, draft: Draft, id: string) => applyDraft(d, draft).wires.find((w) => w.id === id)!.points;

/** s2 -> f joined on s1 -> f (one Failed net): a draft with a junction. */
function joined(d: Doc): Draft {
  const host = pointsOf(d, EMPTY_DRAFT, 's1->f');
  const at = Math.abs(host[1]![0] - host[0]![0]) + Math.abs(host[1]![1] - host[0]![1]) + 32;
  return withCircuit(EMPTY_DRAFT, d, setEnd(circuitOf(d, EMPTY_DRAFT), 's2->f', 'head', { on: 'wire', host: 's1->f', at }));
}

describe('AI drawing (2026-10-11)', () => {
  it('the prompt carries the rules in order, the answer schema and every block and wire of the design', async () => {
    const d = await doc();
    const p = promptOf(d, EMPTY_DRAFT);
    expect(p.system).toContain(DRAWING_RULES);
    // symmetry and equal gaps come right after no crossings, ahead of straight lines (the user, 2026-10-12)
    const at = (rule: string) => { const i = p.system.indexOf(rule); expect(i).toBeGreaterThan(-1); return i; };
    const order = ['4. Don\'t cross', '5. Equal gaps', '6. Vertical symmetry', '7. Horizontal symmetry', '8. Straight lines', '17. Failure handling', '18. Skips go over', '21. Zero crossings'].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // rule 6 never moves a main-path step, and the final check asks for the one row (the user, 2026-10-12)
    expect(p.system).toContain('This rule never moves a main-path step');
    expect(p.system).not.toContain('balance wins');
    expect(p.system).toContain('every main-path step on the one row');
    expect(p.system).toContain('"blocks"');
    const g = JSON.parse(p.user.slice(p.user.indexOf('{'))) as { blocks: { id: string }[]; wires: { id: string; family: string }[] };
    expect(g.blocks.map((b) => b.id).sort()).toEqual(['f', 's1', 's2', 's3', 'wf']);
    expect(g.wires.map((w) => w.id).sort()).toEqual(['s1->f', 's1->s2', 's2->f', 's2->s3', 'wf->s1']);
    expect(g.wires.find((w) => w.id === 's1->f')!.family).toBe('Failed');
  });

  it('the relations ignore where things are drawn and see every link and junction', async () => {
    const d = await doc();
    const before = relationsOf(d, EMPTY_DRAFT);
    const moved = applyPlan(d, EMPTY_DRAFT, parsePlan('{"blocks":{"s3":{"x":2000,"y":800}},"wires":{"s1->s2":{"tail":{"y":200}}}}', d, EMPTY_DRAFT));
    expect(relationsOf(d, moved)).toBe(before);
    expect(relationsOf(d, joined(d))).not.toBe(before);
  });

  it('parses a good answer (code fences too) and refuses anything doubtful', async () => {
    const d = await doc();
    const ok = parsePlan('```json\n{"blocks":{"s2":{"x":601,"y":95}},"wires":{"s1->s2":{"bends":{"xs":[540],"ys":[]}},"s2->s3":{"head":{"auto":true}}}}\n```', d, EMPTY_DRAFT);
    expect(ok.blocks.get('s2')).toEqual({ x: 600, y: 96 });
    // a route from the model is not asked for (2026-10-11): ignored, the router draws it
    expect(ok.wires.get('s1->s2')).toEqual({});
    const bad = (text: string) => { try { parsePlan(text, d, EMPTY_DRAFT); return null; } catch (e) { return (e as Error).message; } };
    expect(bad('not json')).toBe('the answer is not JSON');
    expect(bad('[1,2]')).toBe('the answer is not a JSON object');
    expect(bad('{"blocks":{"nope":{"x":0,"y":0}}}')).toMatch(/unknown block/);
    expect(bad('{"blocks":{"__proto__":{"x":0,"y":0}}}')).toMatch(/unknown block/);
    expect(bad('{"wires":{"s9->s1":{}}}')).toMatch(/unknown wire/);
    expect(bad('{"blocks":{"s1":{"x":"0","y":0}}}')).toMatch(/not a number/);
    expect(bad('{"blocks":{"s1":{"x":1e9,"y":0}}}')).toMatch(/not a number/);
    expect(bad('{"wires":{"s1->s2":{"head":{"junction":{"host":"s1->f","x":0,"y":0}}}}}')).toBeNull();
    expect(bad('{"wires":{"wf->s1":{"tail":{"junction":{"host":"s1->f","x":0,"y":0}}}}}')).toMatch(/cannot become a junction/);
    expect(bad('{"wires":{"wf->s1":{"tail":{"y":100}}}}')).toBeNull();
    expect((() => { try { parsePlan('{"wires":{"s2->f":{"head":{"y":100}}}}', d, joined(d)); return null; } catch (e) { return (e as Error).message; } })())
      .toMatch(/not on a step or the workflow circle/);
  });

  it('sets the workflow circle’s tails where the answer puts them (symmetric hub contact points, 2026-10-11); auto spaces them about its centre', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['a', 'b'] }),
      steps: [stepDto('a'), stepDto('b')],
    }));
    const { cy } = applyDraft(d, EMPTY_DRAFT).placement.sphere;
    const startY = (draft: Draft, id: string) => pointsOf(d, draft, id)[0]![1];
    // automatic: already symmetric, 16 px apart
    expect([startY(EMPTY_DRAFT, 'wf->a'), startY(EMPTY_DRAFT, 'wf->b')].map((y) => y - cy).sort((x, y) => x - y)).toEqual([-8, 8]);
    const snap = relationsOf(d, EMPTY_DRAFT);
    const out = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ wires: { 'wf->a': { tail: { y: cy - 16 } }, 'wf->b': { tail: { y: cy + 16 } } } }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(startY(out.draft, 'wf->a')).toBe(cy - 16);
    expect(startY(out.draft, 'wf->b')).toBe(cy + 16);
    // held within the circle's reach, and auto lets go again
    const far = applyPlan(d, out.draft, parsePlan(JSON.stringify({ wires: { 'wf->a': { tail: { y: cy - 500 } }, 'wf->b': { tail: { auto: true } } } }), d, out.draft));
    expect(startY(far, 'wf->a')).toBe(cy - 64);
    // the only automatic tail left: on the centre (a held tail is not in the router's spacing)
    expect(startY(far, 'wf->b')).toBe(cy);
  });

  it('applies a drawing whose relations are the snapshot\'s; refuses one that moves a junction onto another net, unchanged', async () => {
    const d = await doc();
    const draft = joined(d);
    const snap = relationsOf(d, draft);
    // s3 moved along the row, onto a column (x 288 + k × 288, the user's check, 2026-10-12)
    const good = judgeDrawing(d, draft, snap, '{"blocks":{"s3":{"x":1152,"y":96}}}');
    expect(good.ok).toBe(true);
    if (good.ok) expect(applyDraft(d, good.draft).placement.steps.get('s3')).toEqual({ x: 1152, y: 96 });
    // the junction moved onto s1 -> s2 (a Completed wire): another net, so another meaning
    const other = pointsOf(d, draft, 's1->s2');
    const mid = [(other[0]![0] + other[other.length - 1]![0]) / 2, other[0]![1]];
    const moved = judgeDrawing(d, draft, snap, JSON.stringify({ wires: { 's2->f': { head: { junction: { host: 's1->s2', x: mid[0], y: mid[1] } } } } }));
    expect(moved).toMatchObject({ ok: false });
    if (!moved.ok) expect(moved.reason).toMatch(/would have changed the workflow/);
    // a junction point off its host's line: put at the host's nearest point, the same net, so applied
    const off = judgeDrawing(d, draft, snap, '{"wires":{"s2->f":{"head":{"junction":{"host":"s1->f","x":-5000,"y":-5000}}}}}');
    expect(off.ok).toBe(true);
    if (off.ok) expect(nearestAlong(pointsOf(d, off.draft, 's1->f'), pointsOf(d, off.draft, 's2->f').at(-1)!)).toBeLessThan(32);
  });

  it('gives every wire’s route back to the router: a hand-shaped wire is automatic after a drawing', async () => {
    const d = await doc();
    const shaped = withCircuit(EMPTY_DRAFT, d, setBends(circuitOf(d, EMPTY_DRAFT), 's1->s2', { xs: [800, 1000], ys: [600] }));
    expect(circuitOf(d, shaped)['s1->s2']!.bends).toBeTruthy();
    const after = applyPlan(d, shaped, parsePlan('{}', d, shaped));
    expect(circuitOf(d, after)['s1->s2']!.bends ?? null).toBeNull();
    expect(pointsOf(d, after, 's1->s2')).toEqual(pointsOf(d, EMPTY_DRAFT, 's1->s2'));
  });

  it('the correction round carries the refused answer and exactly why', () => {
    const first = firstMessages({ system: 's', user: 'u' });
    const next = correctionMessages(first, '{"x":1}', 'unknown block "x"');
    expect(next.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(next[2]!.content).toBe('{"x":1}');
    expect(next[3]!.content).toContain('unknown block "x"');
  });

  it('reads a streamed answer: every delta, across chunk splits, until [DONE]; a stream error is named', async () => {
    const stream = (...parts: string[]) => new ReadableStream<Uint8Array>({
      start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); },
    });
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const chunks = vi.fn();
    const all = ev({ choices: [{ delta: { reasoning_content: 'hmm' } }] }) + ev({ choices: [{ delta: { content: '{"blo' } }] })
      + ev({ choices: [{ delta: { content: 'cks":{}}' } }] }) + 'data: [DONE]\n\n';
    expect(await readStream(stream(all.slice(0, 37), all.slice(37, 90), all.slice(90)), chunks)).toBe('{"blocks":{}}');
    expect(chunks).toHaveBeenCalledTimes(3);
    // the progress so far with every line (2026-10-12): thinking, then the answer's characters
    expect(chunks.mock.calls.map((c) => c[0])).toEqual([{ thinking: 3, writing: 0 }, { thinking: 3, writing: 5 }, { thinking: 3, writing: 13 }]);
    await expect(readStream(stream(ev({ error: { message: 'overloaded' } })))).rejects.toThrow(/overloaded/);
    const sse = vi.fn(async () => new Response(stream(all), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    expect(await requestDrawing('kimi-k3', firstMessages({ system: 's', user: 'u' }), new AbortController().signal, sse)).toBe('{"blocks":{}}');
  });

  it('merges wires into a trunk (2026-10-11): a fan-in of one family into one step is applied; the meaning is unchanged', async () => {
    const d = await doc();
    const snap = relationsOf(d, EMPTY_DRAFT);
    const host = pointsOf(d, EMPTY_DRAFT, 's1->f');
    const out = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ wires: { 's2->f': { head: { junction: { host: 's1->f', x: host[1]![0], y: host[1]![1] } } } } }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(circuitOf(d, out.draft)['s2->f']!.head).toMatchObject({ on: 'wire', host: 's1->f' });
    expect(changeOf(snap, relationsOf(d, out.draft))).toBeNull();
    expect(applyDraft(d, out.draft).graph.steps.get('s2')!.nextStepIds).toEqual(applyDraft(d, EMPTY_DRAFT).graph.steps.get('s2')!.nextStepIds);
  });

  it('merges a fan-out: one step feeding two through one trunk', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['a'] }),
      steps: [stepDto('a', { nextStepIds: ['b', 'c'] }), stepDto('b'), stepDto('c')],
    }));
    const snap = relationsOf(d, EMPTY_DRAFT);
    const host = pointsOf(d, EMPTY_DRAFT, 'a->b');
    const out = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ wires: { 'a->c': { tail: { junction: { host: 'a->b', x: host[0]![0] + 24, y: host[0]![1] } } } } }));
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(circuitOf(d, out.draft)['a->c']!.tail).toMatchObject({ on: 'wire', host: 'a->b' });
  });

  it('refuses a merge that changes the meaning: wires of one family into different steps', async () => {
    const d = await doc();
    const snap = relationsOf(d, EMPTY_DRAFT);
    const host = pointsOf(d, EMPTY_DRAFT, 's1->s2');
    // s2 -> s3 joining s1 -> s2 would make s1 reach s3 too (and s2 reach s2)
    const out = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ wires: { 's2->s3': { head: { junction: { host: 's1->s2', x: host[0]![0] + 40, y: host[0]![1] } } } } }));
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.reason).toMatch(/would have changed the workflow/);
  });

  it('nets may merge, never split or mix kinds', () => {
    const rel = (nets: { wires: string[]; families: number[] }[]) => JSON.stringify({ next: {}, entries: [], caches: [], nets });
    const before = rel([{ wires: ['a'], families: [2] }, { wires: ['b'], families: [2] }, { wires: ['c'], families: [1] }]);
    expect(changeOf(before, rel([{ wires: ['a', 'b'], families: [2] }, { wires: ['c'], families: [1] }]))).toBeNull();
    expect(changeOf(before, rel([{ wires: ['a', 'b', 'c'], families: [1, 2] }]))).toMatch(/another kind/);
    expect(changeOf(rel([{ wires: ['a', 'b'], families: [2] }]), rel([{ wires: ['a'], families: [2] }, { wires: ['b'], families: [2] }]))).toMatch(/no longer form one net/);
    expect(changeOf(rel([{ wires: ['u'], families: [] }, { wires: ['b'], families: [2] }]), rel([{ wires: ['b', 'u'], families: [2] }]))).toMatch(/another kind/);
  });

  it('a lane sends a skip over the row: out of the tail, along the lane, into the head; through a block it is refused', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['a'] }),
      steps: [stepDto('a', { nextStepIds: ['b', 'c'] }), stepDto('b', { nextStepIds: ['c'] }), stepDto('c')],
    }));
    const snap = relationsOf(d, EMPTY_DRAFT);
    const b = applyDraft(d, EMPTY_DRAFT).placement.steps.get('b')!;
    const lane = b.y - 64;
    // the lane alone, with the router's end order (the skip below at both ends): over the row it crosses both row wires
    const alone = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ wires: { 'a->c': { lane } } }));
    expect(alone).toMatchObject({ ok: true, crossings: 2 });
    // with the skip on top at both ends (rule 9's order): no crossing
    const out = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ wires: {
      'a->c': { lane, tail: { y: 144 }, head: { y: 152 } }, 'a->b': { tail: { y: 160 } }, 'b->c': { head: { y: 168 } },
    } }));
    expect(out).toMatchObject({ ok: true, crossings: 0 });
    if (!out.ok) return;
    const pts = pointsOf(d, out.draft, 'a->c');
    expect(pts.some((p, i) => i > 0 && p[1] === lane && pts[i - 1]![1] === lane)).toBe(true);
    // the lane only shapes the middle: the ends are where the answer put them
    expect(pts[0]![1]).toBe(144);
    expect(pts.at(-1)![1]).toBe(152);
    // a lane through b's middle: refused, nothing applied
    const through = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ wires: { 'a->c': { lane: b.y + 96 } } }));
    expect(through).toMatchObject({ ok: false });
    if (!through.ok) expect(through.reason).toMatch(/runs through a block/);
  });

  it('a lane is only for a wire between terminals, not one joined at a junction', async () => {
    const d = await doc();
    const draft = joined(d);
    const out = judgeDrawing(d, draft, relationsOf(d, draft), '{"wires":{"s2->f":{"lane":-200}}}');
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.reason).toMatch(/a lane is only for/);
  });

  it('a wire joining a trunk meets it as a clean T: out of its step, then straight down onto the junction (rule 13)', async () => {
    const d = await doc();
    const snap = relationsOf(d, EMPTY_DRAFT);
    // f far to the right and below, on a column (the user's check, 2026-10-12): s1 -> f runs a level trunk under s2; s2 -> f joins it
    const moved = parsePlan('{"blocks":{"f":{"x":1728,"y":480}}}', d, EMPTY_DRAFT);
    const placed = applyPlan(d, EMPTY_DRAFT, moved);
    const trunk = pointsOf(d, placed, 's1->f');
    const out2 = pointsOf(d, placed, 's2->f')[0]!;
    const level = trunk.findIndex((p, i) => i > 0 && p[1] === trunk[i - 1]![1] && Math.max(p[0], trunk[i - 1]![0]) > out2[0] + 64 && p[1] > out2[1]);
    expect(level).toBeGreaterThan(0);
    const at = [out2[0] + 48, trunk[level]![1]];
    const out = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ blocks: { f: { x: 1728, y: 480 } }, wires: { 's2->f': { head: { junction: { host: 's1->f', x: at[0], y: at[1] } } } } }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const pts = pointsOf(d, out.draft, 's2->f');
    // out of the step level, one turn, straight down onto the junction on the trunk: [output, above the junction, the junction]
    const tee = pts.at(-1)!;
    expect(pts).toEqual([out2, [tee[0], out2[1]], tee]);
    expect(tee[1]).toBeGreaterThan(out2[1]);
    const host = pointsOf(d, out.draft, 's1->f');
    expect(host.some((p, i) => i > 0 && p[1] === tee[1] && host[i - 1]![1] === tee[1] && Math.min(p[0], host[i - 1]![0]) < tee[0] && Math.max(p[0], host[i - 1]![0]) > tee[0])).toBe(true);
    expect(out.crossings).toBe(0);
    expect(circuitOf(d, out.draft)['s2->f']!.bends).toEqual({ xs: [tee[0]], ys: [] });
  });

  it('counts crossings: perpendicular runs meeting inside both; touching ends do not count', () => {
    expect(crossingsOf([{ id: 'a', points: [[0, 50], [100, 50]] }, { id: 'b', points: [[50, 0], [50, 100]] }])).toBe(1);
    expect(crossingsOf([{ id: 'a', points: [[0, 50], [100, 50]] }, { id: 'b', points: [[100, 0], [100, 50]] }])).toBe(0);
    expect(nearestAlong([[0, 0], [100, 0], [100, 50]], [100, 20])).toBe(120);
    expect(nearestAlong([[0, 0], [100, 0], [100, 50]], [130, 22])).toBe(122);
    expect(nearestAlong([[0, 0], [100, 0]], [-40, 9])).toBe(0);
    expect(nearestAlong([[0, 0]], [5, 5])).toBeNull();
  });

  it('asks through the studio\'s own route and names each failure', async () => {
    const prompt = firstMessages({ system: 's', user: 'u' });
    const reply = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const ok = reply(200, { choices: [{ message: { content: '{"blocks":{}}' } }] });
    expect(await requestDrawing('kimi-k3', prompt, new AbortController().signal, ok)).toBe('{"blocks":{}}');
    const sent = JSON.parse(((ok as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string) as { model: string; stream: boolean; reasoning_effort: string };
    expect(sent).toMatchObject({ model: 'kimi-k3', stream: true, reasoning_effort: 'low' });
    expect((ok as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('/ai/chat/completions');
    await expect(requestDrawing('kimi-k3', prompt, new AbortController().signal, reply(503))).rejects.toThrow(/not configured/);
    await expect(requestDrawing('kimi-k3', prompt, new AbortController().signal, reply(401))).rejects.toThrow(/refused the key/);
    await expect(requestDrawing('kimi-k3', prompt, new AbortController().signal, reply(500))).rejects.toThrow(/HTTP 500/);
    await expect(requestDrawing('kimi-k3', prompt, new AbortController().signal, reply(200, { choices: [] }))).rejects.toThrow(/no drawing/);
    const c = new AbortController();
    c.abort();
    const abort = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
    await expect(requestDrawing('kimi-k3', prompt, c.signal, abort)).rejects.toThrow('cancelled');
  });

  it('draws with the model the studio\'s environment names (KIMI_MODEL_ID, read from /ai/config)', async () => {
    const reply = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const ok = reply(200, { model: 'kimi-k3-preview' });
    expect(await modelOf(new AbortController().signal, ok)).toBe('kimi-k3-preview');
    expect((ok as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('/ai/config');
    await expect(modelOf(new AbortController().signal, reply(503))).rejects.toThrow(/not configured.*KIMI_MODEL_ID/);
    await expect(modelOf(new AbortController().signal, reply(200, { model: '' }))).rejects.toThrow(/not configured/);
    const c = new AbortController();
    c.abort();
    const abort = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
    await expect(modelOf(c.signal, abort)).rejects.toThrow('cancelled');
  });
});

// a -> b -> c -> d (Completed), every step -> f (Failed): the end of the main path, as split-exporter was (the user, 2026-10-12)
const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['a'] }),
  steps: [stepDto('a', { nextStepIds: ['b', 'f'] }), stepDto('b', { nextStepIds: ['c', 'f'] }), stepDto('c', { nextStepIds: ['d', 'f'] }),
    stepDto('d', { nextStepIds: ['f'] }), stepDto('f', { entryCondition: 2 })],
}));

describe('the main row and the columns, checked by the Studio (the user, 2026-10-12)', () => {
  const nextOf = (d: Doc) => (id: string) => d.graph.steps.get(id)?.nextStepIds ?? [];

  it('the main path is the longest Completed chain; a skip does not end it, parallel branches do', async () => {
    const d = await chain();
    expect(mainPathOf(d, nextOf(d), ['a'])).toEqual(['a', 'b', 'c', 'd']);
    const skip = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['a'] }),
      steps: [stepDto('a', { nextStepIds: ['b', 'c'] }), stepDto('b', { nextStepIds: ['c'] }), stepDto('c')],
    }));
    expect(mainPathOf(skip, nextOf(skip), ['a'])).toEqual(['a', 'b', 'c']);
    const fork = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['a'] }),
      steps: [stepDto('a', { nextStepIds: ['b', 'c'] }), stepDto('b', { nextStepIds: ['d'] }), stepDto('c', { nextStepIds: ['d'] }), stepDto('d')],
    }));
    expect(mainPathOf(fork, nextOf(fork), ['a'])).toEqual(['a']);
  });

  it('a main-path step moved off the row is refused, the reason naming the step and the row; on the row and a column it is applied', async () => {
    const d = await chain();
    const snap = relationsOf(d, EMPTY_DRAFT);
    const at = (id: string) => applyDraft(d, EMPTY_DRAFT).placement.steps.get(id)!;
    const row = at('a').y, next = at('c').x + 2 * (at('b').x - at('a').x);
    // lifted above the row, as the wand put split-exporter
    const above = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ blocks: { d: { x: next, y: row - 472 } } }));
    expect(above).toMatchObject({ ok: false });
    if (!above.ok) expect(above.reason).toBe(`step "step-d" is on the main path, so it stays on the row: it was moved to y ${row - 472}, the row is at y ${row} (rule 16)`);
    // on the row but between columns
    const between = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ blocks: { d: { x: next - 64, y: row } } }));
    expect(between).toMatchObject({ ok: false });
    if (!between.ok) expect(between.reason).toMatch(/^step "step-d" was moved off the columns: x \d+, the columns are at x \d+ \+ k × \d+ \(rule 5\)$/);
    // on the row, behind the step before it
    const behind = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ blocks: { d: { x: at('b').x, y: row } } }));
    expect(behind).toMatchObject({ ok: false });
    if (!behind.ok) expect(behind.reason).toMatch(/^step "step-d" was moved left of step "step-c"/);
    // on the row, on a column: applied
    expect(judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ blocks: { d: { x: next, y: row } } }))).toMatchObject({ ok: true });
  });

  it('a step off the main path may move to any row, but onto a column; steps left where they are are not judged', async () => {
    const d = await chain();
    const snap = relationsOf(d, EMPTY_DRAFT);
    const at = (id: string) => applyDraft(d, EMPTY_DRAFT).placement.steps.get(id)!;
    const pitch = at('b').x - at('a').x;
    expect(judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ blocks: { f: { x: at('a').x + 5 * pitch, y: 480 } } }))).toMatchObject({ ok: true });
    expect(judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ blocks: { f: { x: at('a').x + 5 * pitch + 40, y: 480 } } }))).toMatchObject({ ok: false });
    // nothing moved: applied, whatever the automatic layout's rows
    expect(judgeDrawing(d, EMPTY_DRAFT, snap, '{}')).toMatchObject({ ok: true });
  });
});

describe('the refinement round (the user, 2026-10-12)', () => {
  it('names what is still wrong: main-path steps off the row, wherever they were put, and a bent main-path wire', async () => {
    const d = await chain();
    const at = (id: string) => applyDraft(d, EMPTY_DRAFT).placement.steps.get(id)!;
    const left = remainingProblemsOf(d, EMPTY_DRAFT);
    // the automatic layout steps the chain down and up; the row is the y most main-path steps share
    const ys = ['a', 'b', 'c', 'd'].map((id) => at(id).y);
    const row = ys.reduce((best, y) => (ys.filter((v) => v === y).length > ys.filter((v) => v === best).length ? y : best), ys[0]!);
    const off = ['a', 'b', 'c', 'd'].filter((id) => at(id).y !== row);
    expect(off.length).toBeGreaterThan(0);
    // each step off the row is named as it is, not as moved
    for (const id of off) expect(left).toContain(`step "step-${id}" is on the main path, so it stays on the row: it is at y ${at(id).y}, the row is at y ${row} (rule 16)`);
    if (at('a').y !== at('b').y) expect(left).toContain('the main-path wire a->b is bent: it should run straight along the row (rules 8 and 16)');
    // and the Failed wires the layout crosses, by pair
    expect(left.some((l) => /^wires \S+ and \S+ cross( \d+ times)? \(rule 4\)$/.test(l))).toBe(true);
  });

  it('a drawing with the main path on one row, on the columns, leaves none of those problems', async () => {
    const d = await chain();
    const snap = relationsOf(d, EMPTY_DRAFT);
    const at = (id: string) => applyDraft(d, EMPTY_DRAFT).placement.steps.get(id)!;
    const row = at('a').y, pitch = at('b').x - at('a').x;
    const out = judgeDrawing(d, EMPTY_DRAFT, snap, JSON.stringify({ blocks: {
      b: { x: at('a').x + pitch, y: row }, c: { x: at('a').x + 2 * pitch, y: row }, d: { x: at('a').x + 3 * pitch, y: row }, f: { x: at('a').x + 4 * pitch, y: row + 336 },
    } }));
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    const left = remainingProblemsOf(d, out.draft);
    expect(left.filter((l) => /rule (5|15|16)\)$|is bent/.test(l))).toEqual([]);
    expect(movedBlocksOf(d, EMPTY_DRAFT, out.draft)).toBe(4);
    expect(movedBlocksOf(d, out.draft, out.draft)).toBe(0);
  });

  it('names each pair of crossing wires and how often they cross', () => {
    const wires = [
      { id: 'h', points: [[0, 50], [100, 50]] as [number, number][] },
      { id: 'v', points: [[50, 0], [50, 100]] as [number, number][] },
      { id: 'u', points: [[20, 0], [20, 100], [80, 100], [80, 0]] as [number, number][] },
    ];
    expect(crossingPairsOf(wires)).toEqual([{ a: 'h', b: 'v', times: 1 }, { a: 'h', b: 'u', times: 2 }]);
    expect(crossingsOf(wires)).toBe(3);
  });

  it('asks against the drawing as routed: the answer, the graph now and every problem, then the schema reminder', () => {
    const first = firstMessages({ system: 's', user: 'u' });
    const next = refinementMessages(first, '{"blocks":{}}', { blocks: [], wires: [] }, ['step "x" is off the columns', 'wires a and b cross (rule 4)']);
    expect(next.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(next[2]!.content).toBe('{"blocks":{}}');
    expect(next[3]!.content).toContain('{"blocks":[],"wires":[]}');
    expect(next[3]!.content).toContain('- step "x" is off the columns\n- wires a and b cross (rule 4)');
    expect(next[3]!.content).toMatch(/against this drawing: leave out the blocks and wires you do not change\.$/);
  });
});
