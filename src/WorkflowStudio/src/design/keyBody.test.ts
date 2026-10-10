import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { applyDesign } from './apply';
import { EMPTY_EDITS } from './design';
import { circuitOf, EMPTY_DRAFT, type Draft } from './draft';
import { landWires, type WireRun } from './keyBody';

const doc = () => loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
type Doc = Awaited<ReturnType<typeof doc>>;

/** Arrow presses as the canvas sends them: each moves the held run; `release` commits as the closed hand's drop does. */
function keys(saved: Doc, id: string) {
  let draft: Draft = EMPTY_DRAFT, last: WireRun | null = null, held: ReturnType<typeof landWires> = null;
  return {
    press(dy: number, dx = 0) {
      held = landWires(saved, applyDesign(saved, draft, EMPTY_EDITS), draft, [id], dx, dy, held?.run ?? last, held !== null, 8);
      return held!;
    },
    release() { if (held) { draft = held.next; last = held.run; held = null; } },
    get draft() { return draft; },
    set draft(d: Draft) { draft = d; },
  };
}

describe('arrows with only wires picked: the closed hand\'s drag (the user\'s rule, 2026-10-10)', () => {
  it('a held press shows the wire moved and open with its ends\' hints; an end over its step says "ok" there, as the drag\'s "connect here"', async () => {
    const saved = await doc();
    const k = keys(saved, 's1->s2');
    const l = k.press(8);
    expect(Object.keys(l.preview)).toContain('s1->s2');
    expect(l.ends.map((e) => [e.side, e.id, e.verdict])).toEqual([['tail', 's1', 'connect'], ['head', 's2', 'connect']]);
    // released: connected on both steps, 8 px lower
    k.release();
    const w = circuitOf(saved, k.draft)['s1->s2']!;
    expect([w.tail, w.head]).toMatchObject([{ on: 'step', step: 's1' }, { on: 'step', step: 's2' }]);
  });

  it('one down and one up (the user\'s case), released or held: exactly as it was', async () => {
    const saved = await doc();
    for (const id of ['s1->s2', 'wf->s1']) {
      const k = keys(saved, id);
      k.press(8); k.release(); k.press(-8); k.release();
      expect(k.draft).toBe(EMPTY_DRAFT);
      const h = keys(saved, id);
      h.press(8); h.press(-8);
      expect(h.press(0).still).toBe(true);
      h.release();
      expect(h.draft).toBe(EMPTY_DRAFT);
    }
  });

  it('far down: detached, grey, its links gone, its hints over nothing; back up: exactly as it was', async () => {
    const saved = await doc();
    for (const id of ['s1->s2', 'wf->s1']) {
      const was = saved.wires.find((x) => x.id === id)!.points;
      const k = keys(saved, id);
      let l = k.press(8);
      for (let i = 1; i < 40; i++) l = k.press(8);
      expect(l.ends.map((e) => e.id)).toEqual([null, null]);
      k.release();
      const w = circuitOf(saved, k.draft)[id]!;
      expect([w.tail.on, w.head.on]).toEqual(['open', 'open']);
      const shown = applyDesign(saved, k.draft, EMPTY_EDITS);
      expect(shown.wires.find((x) => x.id === id)!.points).toEqual(was.map(([x, y]) => [x, y + 320]));
      for (let i = 0; i < 40; i++) { k.press(-8); k.release(); }
      expect(k.draft).toBe(EMPTY_DRAFT);
    }
  });

  it('an end pushed into its own step is held on its side, as the drag holds it: still, nothing to commit', async () => {
    const saved = await doc();
    const l = keys(saved, 's1->s2').press(0, -8);
    expect(l.still).toBe(true);
    expect(l.next).toBe(EMPTY_DRAFT);
  });

  it('after any other change (an undo) a press starts a new run from the wire as it is then', async () => {
    const saved = await doc();
    const k = keys(saved, 's1->s2');
    for (let i = 0; i < 40; i++) k.press(8);
    k.release();
    k.draft = EMPTY_DRAFT; // undone
    const l = k.press(8);
    expect([l.run.dx, l.run.dy]).toEqual([0, 8]);
    expect(l.run.base).toBe(EMPTY_DRAFT);
  });
});
