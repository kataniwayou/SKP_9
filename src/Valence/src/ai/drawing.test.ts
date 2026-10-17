import { describe, expect, it } from 'vitest';
import type { ProjectData } from '../api/project';
import { atomKey, buildMolecule } from '../molecule/model';
import type { Vec } from '../molecule/layout';
import { firstMessages, judgeDrawing, placed, problemsOf, readStream, scopeOf, SPINE_RULES } from './drawing';

const H = 'a'.repeat(64);
const b = { version: '1.0.0', description: null, updatedAt: '2026-10-17T09:30:00.123456Z' };
const data = {
  workflows: [
    { id: 'w1', name: 'flow', ...b, entryStepIds: ['s1'], assignmentIds: [], cacheIds: [], cronExpression: null },
    { id: 'w2', name: 'other', ...b, entryStepIds: ['s3'], assignmentIds: [], cacheIds: [], cronExpression: null },
  ],
  steps: [
    { id: 's1', name: 'first', ...b, processorId: 'p1', nextStepIds: ['s2'], entryCondition: 1 },
    { id: 's2', name: 'second', ...b, processorId: 'p1', nextStepIds: [], entryCondition: 1 },
    { id: 's3', name: 'third', ...b, processorId: 'p2', nextStepIds: [], entryCondition: 4 },
  ],
  processors: [
    { id: 'p1', name: 'proc', ...b, sourceHash: H, instanceId: null, inputSchemaId: 'c1', outputSchemaId: null, configSchemaId: null },
    { id: 'p2', name: 'proc2', ...b, sourceHash: H, instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null },
  ],
  schemas: [{ id: 'c1', name: 'in', ...b, definition: '{}' }],
  assignments: [], caches: [],
} as unknown as ProjectData;
const m = buildMolecule(data);
const W1 = atomKey('wf', 'w1'), S1 = atomKey('step', 's1'), S2 = atomKey('step', 's2'), P1 = atomKey('proc', 'p1'), C1 = atomKey('schema', 'c1');

describe('the AI drawing (the user, 2026-10-17: the wand, only for the selected workflows)', () => {
  it('lays out only what the picked workflows reach, each atom by a short id the model sees', () => {
    const scope = scopeOf(m, [W1]);
    expect(new Set(scope.keys)).toEqual(new Set([W1, S1, S2, P1, C1]));
    expect(scope.arrows.every((x) => scope.keys.includes(x.from) && scope.keys.includes(x.to))).toBe(true);
    const [system, user] = firstMessages(m, scope);
    expect(system!.content).toContain(SPINE_RULES);
    expect(user!.content).toContain('"name":"first"');
    expect(user!.content).not.toContain('step:s1'); // keys stay in Valence; the model sees a1, a2, …
    expect(user!.content).toContain(`"id":"${scope.idOf.get(S1)}"`);
    expect(scopeOf(m, []).keys).toEqual([]);
  });

  it('takes an answer only when every atom is placed by its id with three numbers, and nothing else', () => {
    const scope = scopeOf(m, [W1]);
    const all = Object.fromEntries(scope.keys.map((k, i) => [scope.idOf.get(k), [i * 3, 0, 0]]));
    const ok = judgeDrawing(scope, '```json\n' + JSON.stringify({ atoms: all }) + '\n```');
    expect(ok.ok && ok.places.get(S1)).toEqual([scope.keys.indexOf(S1) * 3, 0, 0]);
    expect(judgeDrawing(scope, 'not json')).toEqual({ ok: false, reason: 'the answer is not one JSON object' });
    const { a1: _, ...short } = all;
    expect(judgeDrawing(scope, JSON.stringify({ atoms: short }))).toMatchObject({ ok: false, reason: '1 atom not placed: a1' });
    expect(judgeDrawing(scope, JSON.stringify({ atoms: { ...all, zz: [1, 2, 3], a2: [1, 'x', 3] } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/not given: zz.*not three numbers: a2/) });
  });

  it('names what a drawing still breaks: overlapping atoms, a next step that does not point right', () => {
    const scope = scopeOf(m, [W1]);
    const places = new Map<string, Vec>([[W1, [-5, 0, 0]], [S1, [0, 0, 0]], [S2, [5, 0, 0]], [P1, [2.5, 3, 0]], [C1, [2.5, 5.5, 0]]]);
    expect(problemsOf(scope, places)).toEqual([]);
    places.set(S2, [-0.2, 0, 0.3]);
    const problems = problemsOf(scope, places);
    expect(problems[0]).toMatch(/^1 pair of atoms overlap \(rule 2\)/);
    expect(problems[1]).toMatch(/^1 next-step arrow do not point right \(rule 4\)/);
  });

  it('puts the drawing where the workflows stood, and pushes apart what still overlaps without moving a step', () => {
    const scope = scopeOf(m, [W1]);
    const current = new Map<string, Vec>(scope.keys.map((k, i) => [k, [100 + i, 50, 0]]));
    const drawn = new Map<string, Vec>([[W1, [-5, 0, 0]], [S1, [0, 0, 0]], [S2, [5, 0, 0]], [P1, [0, 0.3, 0]], [C1, [2.5, 5.5, 0]]]);
    const out = placed(scope, drawn, current);
    expect(out.get(S2)![0] - out.get(S1)![0]).toBeCloseTo(5);
    expect((out.get(W1)![0] + out.get(S2)![0]) / 2).toBeCloseTo(102, 0); // the box's centre stays at x 102
    const d = Math.hypot(...out.get(P1)!.map((v, i) => v - out.get(S1)![i]!));
    expect(d).toBeGreaterThanOrEqual(0.72 + 0.55 + 0.4 - 1e-6);
  });

  it('reads the streamed answer, thinking and writing counted', async () => {
    const lines = ['data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}', 'data: {"choices":[{"delta":{"content":"{\\"atoms\\""}}]}', 'data: {"choices":[{"delta":{"content":":{}}"}}]}', 'data: [DONE]', ''];
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(lines.join('\n'))); c.close(); } });
    const seen: number[] = [];
    expect(await readStream(body, (p) => seen.push(p.thinking))).toBe('{"atoms":{}}');
    expect(seen[0]).toBe(3);
  });
});
