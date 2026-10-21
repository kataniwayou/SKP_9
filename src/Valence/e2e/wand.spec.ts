import { expect, test } from './valence';

// The wand (spec "AI drawing", 2026-10-17): greyed until workflows are picked in the filter; the model places the picked
// workflows' atoms (only their places change, nothing reaches BaseApi); the drawing is one step of the shared history —
// Ctrl+Z glides the atoms back, Ctrl+Y draws them again — and is kept on refresh. The model here is the stand-in's
// (e2e/standin.ts), so no key is needed.

const near = (a: Record<string, number[]>, b: Record<string, number[]>, keys: string[]) =>
  keys.every((k) => Math.hypot(a[k]![0]! - b[k]![0]!, a[k]![1]! - b[k]![1]!, a[k]![2]! - b[k]![2]!) < 0.01);

async function pickWorkflow(v: import('./valence').Valence, name: string) {
  await v.page.locator('.menubar .wfsel-b').click();
  await v.page.locator('.wfsel-list [role=option]', { hasText: name }).first().click();
  await v.page.keyboard.press('Escape');
}

test('the wand is greyed until a workflow is picked, and says why', async ({ v }) => {
  const wand = v.page.locator('.menubar .wd-b');
  await expect(wand).toHaveAttribute('aria-disabled', 'true');
  await expect(wand).toHaveAttribute('data-tip', 'Pick the workflows to draw in the Workflows filter first');
  await wand.click({ force: true }); // a user can still click it: greyed, it does nothing
  expect(v.api.aiCalls).toBe(0);
  await pickWorkflow(v, 'simple-abc');
  await expect(wand).toHaveAttribute('aria-disabled', 'false');
  await expect(wand).toHaveAttribute('data-tip', /Ctrl\+Z puts them back/);
});

test('a drawing moves only the picked workflow\'s atoms; Ctrl+Z puts them back, Ctrl+Y and Ctrl+Shift+Z draw again; a refresh keeps it', async ({ v }) => {
  await pickWorkflow(v, 'simple-abc');
  const before = await v.places();
  await v.page.locator('.menubar .wd-b').click();
  await expect.poll(() => v.lastLine(), { timeout: 30_000 }).toMatch(/^AI drawing applied: simple-abc laid out by the spine rules, \d+ atoms placed.*Ctrl\+Z puts the places back\.$/);
  await v.page.waitForTimeout(1200); // the glide
  const drawn = await v.places();
  const all = Object.keys(before);
  const moved = all.filter((k) => Math.hypot(drawn[k]![0] - before[k]![0], drawn[k]![1] - before[k]![1], drawn[k]![2] - before[k]![2]) > 0.01);
  expect(moved.length).toBeGreaterThan(0);
  // only simple-abc's own atoms moved
  const workflows = v.api.project.workflows.filter((w) => w.name !== 'simple-abc').map((w) => `wf:${w.id}`);
  expect(moved.some((k) => workflows.includes(k))).toBe(false);
  expect(v.api.aiCalls).toBeGreaterThan(0);

  await v.canvasKey('Control+z');
  await v.page.waitForTimeout(1200);
  expect(await v.lastLine()).toBe('Undid: AI drawing of simple-abc.');
  expect(near(await v.places(), before, all)).toBe(true);

  await v.canvasKey('Control+y');
  await v.page.waitForTimeout(1200);
  expect(await v.lastLine()).toBe('Redid: AI drawing of simple-abc.');
  expect(near(await v.places(), drawn, all)).toBe(true);

  await v.canvasKey('Control+z');
  await v.canvasKey('Control+Shift+z');
  await v.page.waitForTimeout(1200);
  expect(near(await v.places(), drawn, all)).toBe(true);

  await v.refresh();
  expect(near(await v.places(), drawn, all)).toBe(true);
  await v.canvasKey('Control+z');
  await v.page.waitForTimeout(1200);
  expect(near(await v.places(), before, all)).toBe(true);
});

test('no take-back button beside the wand; the wand runs as Cancel and answers in Output', async ({ v }) => {
  await pickWorkflow(v, 'simple-abc');
  await v.page.locator('.menubar .wd-b').click();
  await expect.poll(() => v.said(/^AI drawing: asking stand-in to lay out simple-abc/), { timeout: 15_000 }).not.toBe('');
  await expect.poll(() => v.said(/^AI drawing applied/), { timeout: 30_000 }).not.toBe('');
  await expect(v.page.locator('.menubar button', { hasText: '↶' })).toHaveCount(0);
  await expect(v.page.locator('.menubar .wd-b')).toHaveCount(1);
});

test('without a model the wand says AI drawing is not configured, and nothing moves', async ({ v }) => {
  v.api.ai = 'off';
  await pickWorkflow(v, 'simple-abc');
  const before = await v.places();
  await v.page.locator('.menubar .wd-b').click();
  await expect.poll(() => v.lastLine(), { timeout: 15_000 }).toMatch(/^AI drawing is not configured/);
  expect(near(await v.places(), before, Object.keys(before))).toBe(true);
});
