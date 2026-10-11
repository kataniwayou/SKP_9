import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { setEnd } from '../circuit/circuit';
import { applyDraft } from '../design/apply';
import { circuitOf, EMPTY_DRAFT, withCircuit, type Draft } from '../design/draft';
import { applyPlan, crossingsOf, distanceAlong, DRAWING_RULES, judgeDrawing, parsePlan, promptOf, relationsOf, requestDrawing } from './drawing';

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
    expect(p.system.indexOf('4. Don\'t cross')).toBeLessThan(p.system.indexOf('5. Straight lines'));
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
    // snapped to the 8 px grid
    expect(ok.wires.get('s1->s2')!.bends).toEqual({ xs: [544], ys: [] });
    const bad = (text: string) => { try { parsePlan(text, d, EMPTY_DRAFT); return null; } catch (e) { return (e as Error).message; } };
    expect(bad('not json')).toBe('the answer is not JSON');
    expect(bad('[1,2]')).toBe('the answer is not a JSON object');
    expect(bad('{"blocks":{"nope":{"x":0,"y":0}}}')).toMatch(/unknown block/);
    expect(bad('{"blocks":{"__proto__":{"x":0,"y":0}}}')).toMatch(/unknown block/);
    expect(bad('{"wires":{"s9->s1":{}}}')).toMatch(/unknown wire/);
    expect(bad('{"blocks":{"s1":{"x":"0","y":0}}}')).toMatch(/not a number/);
    expect(bad('{"blocks":{"s1":{"x":1e9,"y":0}}}')).toMatch(/not a number/);
    expect(bad('{"wires":{"s1->s2":{"head":{"junction":{"host":"s1->f","x":0,"y":0}}}}}')).toMatch(/cannot become a junction/);
    expect(bad('{"wires":{"wf->s1":{"tail":{"y":100}}}}')).toBeNull();
    expect((() => { try { parsePlan('{"wires":{"s2->f":{"head":{"y":100}}}}', d, joined(d)); return null; } catch (e) { return (e as Error).message; } })())
      .toMatch(/not on a step or the workflow circle/);
    expect(bad('{"wires":{"s1->s2":{"bends":{"xs":[1,2],"ys":[]}}}}')).toMatch(/one more entry/);
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
    const good = judgeDrawing(d, draft, snap, '{"blocks":{"s3":{"x":1200,"y":96}}}');
    expect(good.ok).toBe(true);
    if (good.ok) expect(applyDraft(d, good.draft).placement.steps.get('s3')).toEqual({ x: 1200, y: 96 });
    // the junction moved onto s1 -> s2 (a Completed wire): another net, so another meaning
    const other = pointsOf(d, draft, 's1->s2');
    const mid = [(other[0]![0] + other[other.length - 1]![0]) / 2, other[0]![1]];
    const moved = judgeDrawing(d, draft, snap, JSON.stringify({ wires: { 's2->f': { head: { junction: { host: 's1->s2', x: mid[0], y: mid[1] } } } } }));
    expect(moved).toMatchObject({ ok: false });
    if (!moved.ok) expect(moved.reason).toMatch(/would have changed the workflow/);
    // a junction point off its host's line: refused, nothing applied
    const off = judgeDrawing(d, draft, snap, '{"wires":{"s2->f":{"head":{"junction":{"host":"s1->f","x":-5000,"y":-5000}}}}}');
    expect(off).toMatchObject({ ok: false });
  });

  it('counts crossings: perpendicular runs meeting inside both; touching ends do not count', () => {
    expect(crossingsOf([{ id: 'a', points: [[0, 50], [100, 50]] }, { id: 'b', points: [[50, 0], [50, 100]] }])).toBe(1);
    expect(crossingsOf([{ id: 'a', points: [[0, 50], [100, 50]] }, { id: 'b', points: [[100, 0], [100, 50]] }])).toBe(0);
    expect(distanceAlong([[0, 0], [100, 0], [100, 50]], [100, 20])).toBe(120);
    expect(distanceAlong([[0, 0], [100, 0]], [50, 3])).toBeNull();
  });

  it('asks through the studio\'s own route and names each failure', async () => {
    const prompt = { system: 's', user: 'u' };
    const reply = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const ok = reply(200, { choices: [{ message: { content: '{"blocks":{}}' } }] });
    expect(await requestDrawing(prompt, new AbortController().signal, ok)).toBe('{"blocks":{}}');
    const sent = JSON.parse(((ok as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string) as { model: string };
    expect(sent.model).toBe('kimi-k3');
    expect((ok as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('/ai/chat/completions');
    await expect(requestDrawing(prompt, new AbortController().signal, reply(503))).rejects.toThrow(/not configured/);
    await expect(requestDrawing(prompt, new AbortController().signal, reply(401))).rejects.toThrow(/refused the key/);
    await expect(requestDrawing(prompt, new AbortController().signal, reply(500))).rejects.toThrow(/HTTP 500/);
    await expect(requestDrawing(prompt, new AbortController().signal, reply(200, { choices: [] }))).rejects.toThrow(/no drawing/);
    const c = new AbortController();
    c.abort();
    const abort = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
    await expect(requestDrawing(prompt, c.signal, abort)).rejects.toThrow('cancelled');
  });
});
