import { afterEach, describe, expect, it } from 'vitest';
import { graphDto, processorDto, stepDto, workflowDto } from '../api/fixtures';
import { processorFromDto } from '../api/toModel';
import { loadedDocument } from '../app/fixtures';
import { circuitOf, EMPTY_DRAFT } from './draft';
import { NO_GUIDES } from './guides';
import { landingBox, type ToolItem } from './toolDrop';
import { registerDropTarget, toolDrag, WIRE_TAIL, WIRE_TIP } from './toolDrag';

// s1 (entry) -> s2; s3 a second entry step, its output free. Steps at s1 (288, 256), s2 (576, 256), s3 (288, 32); the hub
// at (128, 240), radius 96.
const three = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
}));

afterEach(() => toolDrag.cancel());

/**
 * A Wire tile held over a canvas showing `three` at zoom `k` (flow = screen / k), covering the screen points `on` says;
 * the pointer placed so the tail's ring is at flow `tail`. What the drag decides there.
 */
async function hold(tail: { x: number; y: number }, k = 1, on: (x: number) => boolean = () => true) {
  const doc = await three();
  const el = document.createElement('div');
  const unregister = registerDropTarget({ workflowId: 'wf1', el, shown: () => doc, circuit: () => circuitOf(doc, EMPTY_DRAFT), toFlow: (c) => ({ x: c.x / k, y: c.y / k }) });
  const fake = { elementFromPoint: (x: number) => (on(x) ? el : null), defaultView: null } as unknown as Document;
  Object.defineProperty(el, 'ownerDocument', { value: fake });
  try {
    toolDrag.start({ kind: 'wire' }, { x: 0, y: 0 });
    toolDrag.move(fake, { x: tail.x * k - WIRE_TAIL.x, y: tail.y * k }, () => false);
    return toolDrag.get()!.over;
  } finally {
    unregister();
  }
}

describe("a Wire tile touches a contact with its tip or its tail's ring (the user's request, 2026-10-21)", () => {
  it("its tail's ring on a step's output, the tip on nothing: that output decides, as a dragged end there", async () => {
    // s3's output edge at x 512, a little above its middle
    const over = await hold({ x: 512, y: 92 });
    expect(over?.verdict).toMatchObject({ kind: 'wire', why: 'connect', target: { on: 'step', step: 's3', side: 'out' } });
    expect(over?.flow).toEqual({ x: 512, y: 92 });
  });

  it("its tail's ring on the hub's ring: the hub decides", async () => {
    const over = await hold({ x: 128, y: 144 });
    expect(over?.verdict).toMatchObject({ kind: 'wire', why: 'connect', target: { on: 'hub' } });
  });

  it("both on a contact (tail on s1's output, tip on s2's input, 64 flow px apart at zoom 1.5): the tip wins", async () => {
    const k = (WIRE_TIP.x - WIRE_TAIL.x) / 64;
    const over = await hold({ x: 512, y: 296 }, k);
    expect(over?.verdict).toMatchObject({ kind: 'wire', target: { on: 'step', step: 's2', side: 'in' } });
    expect(over?.flow.x).toBeCloseTo(576);
  });

  it('neither on a contact: a free wire placed with its head at the tip; the tip off every canvas: nothing', async () => {
    const free = await hold({ x: 700, y: 600 });
    expect(free?.verdict).toEqual({ kind: 'place' });
    expect(free?.flow).toEqual({ x: 700 + WIRE_TIP.x - WIRE_TAIL.x, y: 600 });
    // the canvas ends between the tail and the tip: only the tail's ring is on it, on nothing
    expect(await hold({ x: 700, y: 600 }, 1, (x) => x < 750)).toBeNull();
  });
});

describe("a block dragged in from the Toolbox snaps to Visio's dynamic grid (plan 10 phase 1)", () => {
  /** A block tile held over a canvas showing `three` at zoom `k`, the pointer at flow point `p`. */
  async function holdBlock(item: ToolItem, p: { x: number; y: number }, k = 1) {
    const doc = await three();
    const el = document.createElement('div');
    const unregister = registerDropTarget({ workflowId: 'wf1', el, shown: () => doc, circuit: () => circuitOf(doc, EMPTY_DRAFT), toFlow: (c) => ({ x: c.x / k, y: c.y / k }) });
    const fake = { elementFromPoint: () => el, defaultView: null } as unknown as Document;
    Object.defineProperty(el, 'ownerDocument', { value: fake });
    try {
      toolDrag.start(item, { x: 0, y: 0 });
      toolDrag.move(fake, { x: p.x * k, y: p.y * k }, () => false);
      return toolDrag.get()!.over!;
    } finally {
      unregister();
    }
  }
  // s1 at (288, 256): an empty step centred on the pointer has its top 80 above it
  const stepAt = (dy: number) => ({ x: 1112, y: 256 + 80 + dy });

  it("an empty step held 4 screen px off level with s1's top snaps level and shows the line", async () => {
    // (10 px off would be 6 px from s1's processor middle, a nearer guide)
    const over = await holdBlock({ kind: 'step' }, stepAt(4));
    expect(landingBox({ kind: 'step' }, over.flow)!.y).toBe(256);
    expect(over.guides.lines.length).toBeGreaterThan(0);
  });

  it('the same 10 screen px at zoom 2 (5 flow px) still snaps', async () => {
    const over = await holdBlock({ kind: 'step' }, stepAt(5), 2);
    expect(landingBox({ kind: 'step' }, over.flow)!.y).toBe(256);
  });

  it('a block whose nearest guide is 16 screen px away does not snap', async () => {
    const over = await holdBlock({ kind: 'step' }, stepAt(48));
    expect(landingBox({ kind: 'step' }, over.flow)!.y).toBe(304);
    expect(over.guides.lines).toEqual([]);
  });

  it('a processor tile gets no guides', async () => {
    const over = await holdBlock({ kind: 'processor', processor: processorFromDto(processorDto('p9')), schemas: [] }, { x: 288 + 112, y: 256 + 80 });
    expect(over.guides).toEqual(NO_GUIDES);
  });

  it('a cache tile snaps like a step', async () => {
    const over = await holdBlock({ kind: 'newCache' }, { x: 1080, y: 256 + 80 + 8 });
    expect(landingBox({ kind: 'newCache' }, over.flow)!.y).toBe(256);
  });
});
