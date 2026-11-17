import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { dragBy, inspector, openEmptyBoard, pickFrame, pickStep, throwaway } from './helpers';

// Feature 7: moving steps and frames, resizing, arrow-key nudges, Esc. Throwaway frames, never saved: nothing is sent.

/** A node's board position as React Flow draws it (absolute, for steps too). */
const pos = (n: Locator) => n.evaluate((el) => {
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec((el as HTMLElement).style.transform);
  return { x: Number(m?.[1]), y: Number(m?.[2]) };
});
/** A step's position inside its frame (the header included, as React Flow holds it). */
const rel = async (s: Locator, f: Locator) => { const a = await pos(s); const b = await pos(f); return { x: a.x - b.x, y: a.y - b.y }; };
const size = (n: Locator) => n.evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
const undo = (page: Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true }).click();
const readout = (page: Page, k: string) => inspector(page).locator('dt', { hasText: new RegExp(`^${k}$`) }).locator('xpath=following-sibling::dd[1]');
/**
 * How far a drag got from where the pointer went: React Flow starts a drag only once the pointer has moved CLICK_SLOP
 * (6 px), and the node follows from there, so it may trail the pointer by the first move (one 10th of the drag here).
 */
const SLACK = 14;
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

test('a step drags inside its frame, never into the header band, and one drag is one undo step', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 2);
  const s = f.steps[0]!;
  const p0 = await rel(s, f.frame);
  await dragBy(page, s, 120, 40);
  await expect.poll(async () => near(await rel(s, f.frame), { x: p0.x + 120, y: p0.y + 40 })).toBeLessThanOrEqual(SLACK);
  const p1 = await rel(s, f.frame);
  expect(p1.x).toBeGreaterThan(p0.x + 90);
  // dragged up past the header: it stops at the header's bottom (46 px)
  await dragBy(page, s, 0, -400);
  await expect.poll(async () => (await rel(s, f.frame)).y).toBe(46);
  const fb = (await f.frame.boundingBox())!;
  expect((await s.boundingBox())!.y).toBeGreaterThanOrEqual(fb.y + 46 - 1);
  // each drag was one history step
  await pickStep(s);
  await undo(page);
  await expect.poll(() => rel(s, f.frame)).toEqual(p1);
  await undo(page);
  await expect.poll(() => rel(s, f.frame)).toEqual(p0);
});

test('the frame drags by its body and its steps go with it', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 1);
  await pickFrame(f.frame);
  const f0 = await pos(f.frame);
  await expect(readout(page, 'Position')).toHaveText(`${Math.round(f0.x)}, ${Math.round(f0.y)}`);
  const s0 = await rel(f.steps[0]!, f.frame);
  const b = (await f.frame.boundingBox())!;
  // grab the body below the step, not the header
  await dragBy(page, f.frame, 90, 40, { x: b.width - 30, y: b.height - 15 });
  await expect.poll(async () => near(await pos(f.frame), { x: f0.x + 90, y: f0.y + 40 })).toBeLessThanOrEqual(SLACK);
  const f1 = await pos(f.frame);
  expect(f1.x).toBeGreaterThan(f0.x + 60);
  // the step stayed where it was in its frame
  expect(await rel(f.steps[0]!, f.frame)).toEqual(s0);
  await expect(readout(page, 'Position')).toHaveText(`${Math.round(f1.x)}, ${Math.round(f1.y)}`);
});

test('a picked frame resizes from its right edge, bottom edge and corner only, never below its content', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 1);
  await pickFrame(f.frame);
  const controls = page.locator(`.react-flow__node-workflow[data-id="wf:${f.id}"] .react-flow__resize-control`);
  await expect(controls).toHaveCount(3);
  const classes = await controls.evaluateAll((ns) => ns.map((n) => n.className));
  expect(classes.some((c) => /\b(top|left)\b/.test(c))).toBe(false);
  const right = controls.and(page.locator('.line.right'));
  const bottom = controls.and(page.locator('.line.bottom'));
  const corner = controls.and(page.locator('.handle.bottom.right'));
  await expect(right).toHaveCount(1); await expect(bottom).toHaveCount(1); await expect(corner).toHaveCount(1);

  const z0 = await size(f.frame);
  const p0 = await pos(f.frame);
  await dragBy(page, right, 120, 0, { x: 1, y: 40 });
  await expect.poll(() => size(f.frame)).toEqual({ w: z0.w + 120, h: z0.h });
  await dragBy(page, bottom, 0, 80, { x: 60, y: 1 });
  await expect.poll(() => size(f.frame)).toEqual({ w: z0.w + 120, h: z0.h + 80 });
  await dragBy(page, corner, 40, 30);
  await expect.poll(() => size(f.frame)).toEqual({ w: z0.w + 160, h: z0.h + 110 });
  await expect(readout(page, 'Size')).toHaveText(`${z0.w + 160} × ${z0.h + 110}`);
  // its top-left never moved
  expect(await pos(f.frame)).toEqual(p0);
  // shrunk hard: it stops at its content (the step's right and bottom edge plus the 28 px pad)
  const sp = await rel(f.steps[0]!, f.frame);
  await dragBy(page, corner, -900, -900);
  await expect.poll(async () => (await size(f.frame)).w).toBe(Math.max(420, sp.x + 210 + 28));
  await expect.poll(async () => (await size(f.frame)).h).toBe(Math.max(196, sp.y + 92 + 28));
});

test('arrow keys nudge a picked step 8 px; a held key is one undo step', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 1);
  const s = f.steps[0]!;
  await pickStep(s);
  const p0 = await rel(s, f.frame);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => rel(s, f.frame)).toEqual({ x: p0.x + 8, y: p0.y });
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => rel(s, f.frame)).toEqual({ x: p0.x + 8, y: p0.y + 8 });
  // a held key: its first press, then the browser's repeats
  await page.keyboard.down('ArrowRight');
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true, cancelable: true })));
  }
  await page.keyboard.up('ArrowRight');
  await expect.poll(() => rel(s, f.frame)).toEqual({ x: p0.x + 48, y: p0.y + 8 });
  await undo(page);
  await expect.poll(() => rel(s, f.frame)).toEqual({ x: p0.x + 8, y: p0.y + 8 });
  await undo(page);
  await expect.poll(() => rel(s, f.frame)).toEqual({ x: p0.x + 8, y: p0.y });
  await undo(page);
  await expect.poll(() => rel(s, f.frame)).toEqual(p0);
  // a picked frame nudges too
  await pickFrame(f.frame);
  const fp = await pos(f.frame);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => pos(f.frame)).toEqual({ x: fp.x - 8, y: fp.y });
});

test('Esc during a drag puts the step back and records nothing', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 1);
  const s = f.steps[0]!;
  await pickStep(s);
  const p0 = await pos(s);
  const undoBtn = inspector(page).getByRole('button', { name: 'Undo', exact: true });
  await dragBy(page, s, 150, 70, undefined, false);
  await expect.poll(async () => (await pos(s)).x).toBeGreaterThan(p0.x + 100);
  await page.keyboard.press('Escape');
  await expect.poll(() => pos(s)).toEqual(p0);
  const b = (await s.boundingBox())!;
  await page.mouse.move(b.x + 200, b.y + 120, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => pos(s)).toEqual(p0);
  // the last undo step is still the drop of the step, not a move: Undo takes the step away
  await undo(page);
  await expect(page.locator(`.react-flow__node-step[data-id^="st:${f.id}:"]`)).toHaveCount(0);
  await expect(undoBtn).toBeDisabled();
});
