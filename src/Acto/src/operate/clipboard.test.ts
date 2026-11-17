import { describe, expect, it } from 'vitest';
import { bw } from '../board/fixtures';
import { FRAME_PAD, HEADER_H, STEP_H, STEP_W } from '../board/geometry';
import { stateOf, type WorkflowState } from '../design/state';
import { memoryStorage } from '../test/memoryStorage';
import { copyClip, copyMessage, freeOffset, PASTE_CELL, pasteClip, readClip, writeClip, type Clip } from './clipboard';

function wfState(id: string, frame: { x: number; y: number }, steps: Record<string, { x: number; y: number }>, wires: [string, string][] = []): WorkflowState {
  const s = stateOf(bw(id, Object.keys(steps), wires.map(([from, to]) => ({ id: `${from}>${to}`, from, to, condition: 4 }))));
  for (const [k, at] of Object.entries(steps)) s.steps[k] = { ...s.steps[k]!, at, processorId: 'p1', entryCondition: 3 };
  s.frame = { ...frame, w: 900, h: 600 };
  if (s.steps.a) s.assignments.a = { id: 'as-a', stepId: 'a', name: 'a-assignment', version: '1.0.0', description: null, payload: '{"k":1}', updatedAt: null, isNew: false };
  return s;
}
const ids = () => { let n = 0; return () => `new-${++n}`; };
const overlaps = (at: { x: number; y: number }, o: { x: number; y: number }) =>
  at.x < o.x + STEP_W && o.x < at.x + STEP_W && at.y < o.y + STEP_H && o.y < at.y + STEP_H;

describe('copyClip', () => {
  it('keeps only wires inside the copied steps, in board coordinates, with payloads', () => {
    const s = wfState('w1', { x: 1000, y: 500 }, { a: { x: 30, y: 40 }, b: { x: 300, y: 40 }, c: { x: 600, y: 40 } }, [['a', 'b'], ['a', 'c']]);
    const clip = copyClip([{ state: s, stepIds: ['a', 'b'] }])!;
    expect(clip.wires).toEqual([['a', 'b']]);
    expect(clip.pasted).toBe(0);
    expect(clip.steps.map((x) => x.id)).toEqual(['a', 'b']);
    expect(clip.steps[0]!.at).toEqual({ x: 1030, y: 500 + HEADER_H + 40 });
    expect(clip.steps[0]).toMatchObject({ payload: '{"k":1}', processorId: 'p1', entryCondition: 3, name: 'a-name' });
    expect(clip.steps[1]!.payload).toBeNull();
  });
  it('is null when nothing was picked', () => {
    expect(copyClip([{ state: wfState('w1', { x: 0, y: 0 }, { a: { x: 30, y: 30 } }), stepIds: [] }])).toBeNull();
  });
});

describe('copyMessage', () => {
  const c = (n: number, w: number): Clip => ({
    steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: 'n', version: '1', description: null, entryCondition: 1, processorId: null, at: { x: 0, y: 0 }, payload: null })),
    wires: Array.from({ length: w }, () => ['a', 'b'] as [string, string]), pasted: 0,
  });
  it('words the counts', () => {
    expect(copyMessage(c(1, 0))).toBe('Copied 1 step');
    expect(copyMessage(c(2, 1))).toBe('Copied 2 steps and 1 wire');
    expect(copyMessage(c(3, 2))).toBe('Copied 3 steps and 2 wires');
  });
});

describe('pasteClip', () => {
  const source = () => wfState('w1', { x: 1000, y: 500 }, { a: { x: 30, y: 40 }, b: { x: 300, y: 40 } }, [['a', 'b']]);
  const clipOf = (s: WorkflowState) => copyClip([{ state: s, stepIds: ['a', 'b'] }])!;

  it('makes new steps with unique names, the same processor, remapped wires and a new assignment', () => {
    const s = source();
    const { state, pasted } = pasteClip(s, clipOf(s), null, ids());
    expect(pasted).toHaveLength(2);
    const [a2, b2] = pasted.map((id) => state.steps[id]!);
    expect([a2!.name, b2!.name]).toEqual(['a-name-2', 'b-name-2']);
    expect(a2).toMatchObject({ processorId: 'p1', entryCondition: 3, isNew: true });
    expect(a2!.nextStepIds).toEqual([b2!.id]);
    expect(state.assignments[a2!.id]).toMatchObject({ payload: '{"k":1}', isNew: true, stepId: a2!.id, name: 'a-name-2-assignment', version: '1.0.0' });
    expect(state.assignments[b2!.id]).toBeUndefined();
    expect(Object.keys(state.steps)).toHaveLength(4);
  });
  it('lands right of the near step', () => {
    const s = source();
    s.steps.a = { ...s.steps.a!, at: { x: 100, y: 60 } };
    s.steps.b = { ...s.steps.b!, at: { x: 100, y: 400 } };
    const clip = copyClip([{ state: s, stepIds: ['b'] }])!;
    const { state, pasted } = pasteClip(s, clip, 'a', ids());
    expect(state.steps[pasted[0]!]!.at).toEqual({ x: 100 + STEP_W + 40, y: 60 });
  });
  it('falls back to the nearest free offset when beside the near step is taken', () => {
    const s = source();
    s.steps.a = { ...s.steps.a!, at: { x: 100, y: 60 } };
    s.steps.b = { ...s.steps.b!, at: { x: 100 + STEP_W + 40, y: 60 } };
    const clip = copyClip([{ state: s, stepIds: ['b'] }])!;
    const { state, pasted } = pasteClip(s, clip, 'a', ids());
    const at = state.steps[pasted[0]!]!.at;
    expect(Object.values(s.steps).some((o) => overlaps(at, o.at))).toBe(false);
    expect((at.x - (100 + STEP_W + 40)) % PASTE_CELL).toBe(0);
    expect((at.y - 60) % PASTE_CELL).toBe(0);
  });
  it('cascades by (pasted + 1) cells without a near step, and never above or left of the padding', () => {
    const src = source();
    const clip = copyClip([{ state: src, stepIds: ['a'] }])!; // board (1030, 586)
    const elsewhere = wfState('w2', { x: 5000, y: 0 }, { x: { x: 700, y: 400 } });
    const { state, pasted } = pasteClip(elsewhere, clip, null, ids());
    const at = state.steps[pasted[0]!]!.at;
    expect(at.x).toBeGreaterThanOrEqual(FRAME_PAD);
    expect(at.y).toBeGreaterThanOrEqual(FRAME_PAD);
    const again = pasteClip(wfState('w3', { x: 1000, y: 500 }, {}), { ...clip, pasted: 2 }, null, ids());
    expect(again.state.steps[again.pasted[0]!]!.at).toEqual({ x: 30 + 3 * PASTE_CELL, y: 40 + 3 * PASTE_CELL });
  });
  it('moves an overlapping start to free space (Review Focus 2)', () => {
    const s = source();
    const first = pasteClip(s, { ...clipOf(s), pasted: 0 }, null, ids());
    for (const id of first.pasted) {
      const at = first.state.steps[id]!.at;
      expect(Object.values(s.steps).some((o) => overlaps(at, o.at))).toBe(false);
      expect(at.x).toBeGreaterThanOrEqual(FRAME_PAD);
      expect(at.y).toBeGreaterThanOrEqual(FRAME_PAD);
    }
    const [x, y] = first.pasted.map((id) => first.state.steps[id]!.at);
    expect(overlaps(x!, y!)).toBe(false);
  });
});

describe('freeOffset', () => {
  it('keeps the start when free and searches the nearest cell otherwise', () => {
    const g = [{ x: 0, y: 0, w: 100, h: 100 }];
    expect(freeOffset(g, [], { x: 32, y: 32 })).toEqual({ x: 32, y: 32 });
    const got = freeOffset(g, [{ x: 0, y: 0, w: 100, h: 100 }], { x: 0, y: 0 });
    expect(got).not.toEqual({ x: 0, y: 0 });
    expect(got.x % 32).toBe(0);
    expect(got.y % 32).toBe(0);
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
    expect(readClip(null)).toBeNull();
    expect(readClip(memoryStorage({ 'acto.clip': '{oops' }))).toBeNull();
    expect(readClip(memoryStorage({ 'acto.clip': '{"steps":1}' }))).toBeNull();
  });
});
