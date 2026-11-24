import { describe, expect, it } from 'vitest';
import { STEP_H, STEP_W } from '../board/geometry';
import { board } from '../design/boardFixtures';
import { memoryStorage } from '../test/memoryStorage';
import type { ItemRef } from '../design/board';
import { copyClip, copyMessage, freeOffset, PASTE_CELL, pasteClip, pasteMessage, readClip, writeClip, type Clip } from './clipboard';

const st = (...xs: string[]): ItemRef[] => xs.map((id) => ({ kind: 'step', id }));
const EMPTY: Clip = { steps: [], wires: [], caches: [], workflows: [], pasted: 0 };
const ids = () => { let n = 0; return () => `new-${++n}`; };
const overlaps = (a: { x: number; y: number }, o: { x: number; y: number }) =>
  a.x < o.x + STEP_W && o.x < a.x + STEP_W && a.y < o.y + STEP_H && o.y < a.y + STEP_H;

describe('copyClip', () => {
  it('keeps the shared fields and only the wires among the copied steps, and no payload', () => {
    const clip = copyClip(board(), st('fetch', 'expand'))!;
    expect(clip.steps.map((s) => s.id)).toEqual(['fetch', 'expand']);
    expect(clip.wires).toEqual([['fetch', 'expand']]);
    expect(clip.steps[0]).toEqual({ id: 'fetch', name: 'fetch-orders', version: '1.0.0', description: null, entryCondition: 1, processorId: 'p1', at: { x: 200, y: 200 } });
    expect(copyClip(board(), st('fetch'))!.wires).toEqual([]);
  });
  it('is null when nothing on the board was picked', () => {
    expect(copyClip(board(), [])).toBeNull();
    expect(copyClip(board(), [...st('gone'), { kind: 'cache', id: 'gone' }, { kind: 'workflow', id: 'gone' }])).toBeNull();
  });
});

describe('copyMessage', () => {
  const c = (n: number, w: number): Clip => ({
    steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: 'n', version: '1', description: null, entryCondition: 1, processorId: null, at: { x: 0, y: 0 } })),
    wires: Array.from({ length: w }, () => ['a', 'b'] as [string, string]), caches: [], workflows: [], pasted: 0,
  });
  it('words the counts', () => {
    expect(copyMessage(c(1, 0))).toBe('Copied 1 step');
    expect(copyMessage(c(2, 1))).toBe('Copied 2 steps and 1 wire');
    expect(copyMessage(copyClip(board(), [{ kind: 'workflow', id: 'daily' }, ...st('fetch', 'expand'), { kind: 'cache', id: 'c1' }])!))
      .toBe('Copied 1 workflow, 2 steps, 1 cache and 1 wire');
    expect(pasteMessage([{ kind: 'cache', id: 'x' }, { kind: 'workflow', id: 'y' }])).toBe('Pasted 1 workflow and 1 cache');
  });
});

describe('pasteClip', () => {
  it('adds new unsaved steps with unique names, remapped wires, and no payloads', () => {
    const b = board();
    const { state, pasted } = pasteClip(b, copyClip(b, st('fetch', 'expand'))!, ids());
    expect(pasted).toEqual(st('new-1', 'new-2'));
    const [f, e] = pasted.map((p) => state.steps[p.id]!);
    expect([f!.name, e!.name]).toEqual(['fetch-orders-2', 'expand-2']);
    expect(f).toMatchObject({ processorId: 'p1', entryCondition: 1, updatedAt: null, nextStepIds: ['new-2'] });
    expect(Object.keys(state.assignments)).toEqual(Object.keys(b.assignments));
    expect(Object.values(state.workflows).flatMap((w) => w.entryStepIds)).not.toContain('new-1');
  });
  it('lands on a free offset, over nothing already on the board', () => {
    const b = board();
    const { state, pasted } = pasteClip(b, copyClip(b, st('fetch', 'expand', 'lonely'))!, ids());
    for (const p of pasted) {
      const at = state.steps[p.id]!.at!;
      for (const s of Object.values(b.steps)) expect(overlaps(at, s.at!)).toBe(false);
    }
    const d = state.steps[pasted[0]!.id]!.at!.x - b.steps.fetch!.at!.x;
    expect(d % PASTE_CELL).toBe(0);
  });
  it('an empty clip changes nothing', () => {
    const b = board();
    expect(pasteClip(b, EMPTY, ids()).state).toBe(b);
  });
});

describe('copy and paste of caches and workflows [user, 2026-11-19: a new id, every field the same but the name]', () => {
  const T = { kind: 'workflow', id: 'daily' } as const, C = { kind: 'cache', id: 'c1' } as const;
  it('a cache: every field but the name and the root (unique in BaseAPI, named on like the name), unsaved, on free board', () => {
    const b = board();
    b.caches.c1 = { ...b.caches.c1!, description: 'd', version: '2.0.0', root: 'orders', items: '{"a":1}' };
    const { state, pasted } = pasteClip(b, copyClip(b, [C])!, ids());
    expect(pasted).toEqual([{ kind: 'cache', id: 'new-1' }]);
    const c = state.caches['new-1']!;
    expect(c).toMatchObject({ name: 'c1-2', version: '2.0.0', description: 'd', root: 'orders-2', items: '{"a":1}', updatedAt: null, createdAt: null });
    expect(c.at).not.toEqual(b.caches.c1!.at);
    expect(state.caches.c1).toBe(b.caches.c1);
  });
  it('a workflow copied alone pastes like a step alone: every field, no entry arrows, no cache lines, no assignments [user, 2026-11-23]', () => {
    const b = board();
    b.workflows.daily = { ...b.workflows.daily!, description: 'nightly', version: '3.1.0' };
    const { state, pasted } = pasteClip(b, copyClip(b, [T])!, ids());
    expect(pasted).toEqual([{ kind: 'workflow', id: 'new-1' }]);
    expect(state.workflows['new-1']).toMatchObject({
      name: 'daily-2', version: '3.1.0', description: 'nightly',
      entryStepIds: [], cacheIds: [], assignmentIds: [], updatedAt: null,
    });
    expect(Object.keys(state.assignments)).toEqual(Object.keys(b.assignments));
    expect(Object.keys(state.steps)).toEqual(Object.keys(b.steps));
  });
  it('copied together: links between copied items join the copies; links to the rest stay on the originals', () => {
    const b = board();
    const { state, pasted } = pasteClip(b, copyClip(b, [T, ...st('fetch'), C])!, ids());
    expect(pasted).toEqual([{ kind: 'step', id: 'new-1' }, { kind: 'cache', id: 'new-2' }, { kind: 'workflow', id: 'new-3' }]);
    expect(state.workflows['new-3']).toMatchObject({ entryStepIds: ['new-1'], cacheIds: ['new-2'], assignmentIds: ['a-daily-fetch'] });
    // fetch -> expand: expand was not copied, so the copy of fetch has no wire
    expect(state.steps['new-1']!.nextStepIds).toEqual([]);
    expect(pasteMessage(pasted)).toBe('Pasted 1 workflow, 1 step and 1 cache');
  });
  it('a link to an item gone from the board since the copy is dropped', () => {
    const b = board();
    const clip = copyClip(b, [T, { kind: 'step', id: 'lonely' }])!; // with a step: the links are kept (a workflow alone has none)
    const gone = { ...b, caches: {}, assignments: {} };
    expect(Object.values(pasteClip(gone, clip, ids()).state.workflows).find((w) => w.name === 'daily-2')).toMatchObject({ cacheIds: [], assignmentIds: [], entryStepIds: ['fetch'] });
  });
  it('a second paste of the same clip names on: daily-2, daily-3', () => {
    const b = board();
    const clip = copyClip(b, [T])!;
    const one = pasteClip(b, clip, ids()).state;
    const two = pasteClip(one, { ...clip, pasted: 1 }, () => 'x').state;
    expect(two.workflows.x!.name).toBe('daily-3');
  });
});

describe('freeOffset', () => {
  it('keeps the start when free and searches the nearest cell otherwise', () => {
    const g = [{ x: 0, y: 0, w: 100, h: 100 }];
    expect(freeOffset(g, [], { x: 32, y: 32 })).toEqual({ x: 32, y: 32 });
    const got = freeOffset(g, [{ x: 0, y: 0, w: 100, h: 100 }], { x: 0, y: 0 });
    expect(got).not.toEqual({ x: 0, y: 0 });
    expect(got.x % 32).toBe(0);
  });
});

describe('clip storage', () => {
  const clip: Clip = { ...EMPTY, pasted: 1 };
  it('round-trips', () => {
    const st = memoryStorage();
    writeClip(st, clip);
    expect(readClip(st)).toEqual(clip);
  });
  it('survives a throwing storage and junk', () => {
    const bad = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } } as unknown as Storage;
    expect(readClip(bad)).toBeNull();
    expect(() => writeClip(bad, clip)).not.toThrow();
    expect(readClip(memoryStorage({ 'acto.clip': '{oops' }))).toBeNull();
  });
  it('a clip from before caches and workflows reads as steps only', () => {
    expect(readClip(memoryStorage({ 'acto.clip': '{"steps":[],"wires":[],"pasted":2}' }))).toEqual({ ...EMPTY, pasted: 2 });
  });
});
