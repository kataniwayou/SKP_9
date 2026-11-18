import { describe, expect, it } from 'vitest';
import { STEP_H, STEP_W } from '../board/geometry';
import { board } from '../design/boardFixtures';
import { memoryStorage } from '../test/memoryStorage';
import { copyClip, copyMessage, freeOffset, PASTE_CELL, pasteClip, readClip, writeClip, type Clip } from './clipboard';

const ids = () => { let n = 0; return () => `new-${++n}`; };
const overlaps = (a: { x: number; y: number }, o: { x: number; y: number }) =>
  a.x < o.x + STEP_W && o.x < a.x + STEP_W && a.y < o.y + STEP_H && o.y < a.y + STEP_H;

describe('copyClip', () => {
  it('keeps the shared fields and only the wires among the copied steps, and no payload', () => {
    const clip = copyClip(board(), ['fetch', 'expand'])!;
    expect(clip.steps.map((s) => s.id)).toEqual(['fetch', 'expand']);
    expect(clip.wires).toEqual([['fetch', 'expand']]);
    expect(clip.steps[0]).toEqual({ id: 'fetch', name: 'fetch-orders', version: '1.0.0', description: null, entryCondition: 1, processorId: 'p1', at: { x: 200, y: 200 } });
    expect(copyClip(board(), ['fetch'])!.wires).toEqual([]);
  });
  it('is null when nothing on the board was picked', () => {
    expect(copyClip(board(), [])).toBeNull();
    expect(copyClip(board(), ['gone'])).toBeNull();
  });
});

describe('copyMessage', () => {
  const c = (n: number, w: number): Clip => ({
    steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: 'n', version: '1', description: null, entryCondition: 1, processorId: null, at: { x: 0, y: 0 } })),
    wires: Array.from({ length: w }, () => ['a', 'b'] as [string, string]), pasted: 0,
  });
  it('words the counts', () => {
    expect(copyMessage(c(1, 0))).toBe('Copied 1 step');
    expect(copyMessage(c(2, 1))).toBe('Copied 2 steps and 1 wire');
  });
});

describe('pasteClip', () => {
  it('adds new unsaved steps with unique names, remapped wires, and no payloads', () => {
    const b = board();
    const { state, pasted } = pasteClip(b, copyClip(b, ['fetch', 'expand'])!, ids());
    expect(pasted).toEqual(['new-1', 'new-2']);
    const [f, e] = pasted.map((id) => state.steps[id]!);
    expect([f!.name, e!.name]).toEqual(['fetch-orders-2', 'expand-2']);
    expect(f).toMatchObject({ processorId: 'p1', entryCondition: 1, updatedAt: null, nextStepIds: ['new-2'] });
    expect(Object.keys(state.assignments)).toEqual(Object.keys(b.assignments));
    expect(Object.values(state.workflows).flatMap((w) => w.entryStepIds)).not.toContain('new-1');
  });
  it('lands on a free offset, over nothing already on the board', () => {
    const b = board();
    const { state, pasted } = pasteClip(b, copyClip(b, ['fetch', 'expand', 'lonely'])!, ids());
    for (const id of pasted) {
      const at = state.steps[id]!.at!;
      for (const s of Object.values(b.steps)) expect(overlaps(at, s.at!)).toBe(false);
    }
    const d = state.steps[pasted[0]!]!.at!.x - b.steps.fetch!.at!.x;
    expect(d % PASTE_CELL).toBe(0);
  });
  it('an empty clip changes nothing', () => {
    const b = board();
    expect(pasteClip(b, { steps: [], wires: [], pasted: 0 }, ids()).state).toBe(b);
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
  const clip: Clip = { steps: [], wires: [], pasted: 1 };
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
});
