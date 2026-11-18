import { test, expect } from './fixtures';
import { allCaches, allSteps, allWorkflows, caNode, centre, entryEdge, openAt, openFitted, stNode, wfNode, wireEdge, cacheEdge, zoomOf } from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// Spec §5: the board shows every row; triangles with arrows from the tip and dashed lines from the back; minimap, theme, Fit.
// The seeded rows are throwaway (e2e-); the counts are checked against what BaseAPI holds right now, real rows included.

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-board-first', at: { x: 260, y: 0 }, next: ['s2'] },
    { key: 's2', name: 'e2e-board-second', at: { x: 560, y: 0 } },
    { key: 'orphan', name: 'e2e-board-orphan', at: { x: 560, y: 220 } },
  ],
  caches: [{ key: 'c1', name: 'e2e-board-cache', at: { x: 40, y: 220 } }],
  workflows: [{ key: 'w1', name: 'e2e-board-wf', at: { x: 0, y: 0 }, entry: ['s1'], caches: ['c1'] }],
} as const;

test('the board loads every step (orphans too), every triangle and cache, and one arrow, wire or line per link', async ({ page }) => {
  const ids = await seed(SEED);
  const [workflows, steps, caches] = await Promise.all([getJson<Row[]>('/workflows'), getJson<Row[]>('/steps'), getJson<Row[]>('/caches')]);
  await openAt(page);
  await expect(allWorkflows(page)).toHaveCount(workflows.length);
  await expect(allSteps(page)).toHaveCount(steps.length);
  await expect(allCaches(page)).toHaveCount(caches.length);
  // orphans: the e2e orphan is on the board, and so is every real step no workflow reaches
  await expect(stNode(page, ids.orphan!)).toBeVisible();
  const entries = workflows.reduce((n, w) => n + new Set(w.entryStepIds as string[]).size, 0);
  const lines = workflows.reduce((n, w) => n + new Set(w.cacheIds as string[]).size, 0);
  const wires = steps.reduce((n, s) => n + new Set(s.nextStepIds as string[]).size, 0);
  await expect(page.locator('.react-flow__edge-entry, .react-flow__edge[data-id^="entry:"]')).toHaveCount(entries);
  await expect(page.locator('.react-flow__edge[data-id^="cache:"]')).toHaveCount(lines);
  await expect(page.locator('.react-flow__edge[data-id^="wire:"]')).toHaveCount(wires);
  await expect(page.locator('.react-flow__node-workflow .tri-nm', { hasText: 'e2e-board-wf' })).toBeVisible();
  await expect(page.locator('[data-panel="inspector"]')).toContainText(`Board: ${workflows.length} workflows`);
});

test('a triangle\'s solid arrow leaves its tip, its dashed line leaves its back, and a wire is a step\'s own', async ({ page }) => {
  const ids = await seed(SEED);
  await openAt(page);
  const tri = (await wfNode(page, ids.w1!).locator('.tri-shape').boundingBox())!;
  const entry = entryEdge(page, ids.w1!, ids.s1!);
  const line = cacheEdge(page, ids.w1!, ids.c1!);
  await expect(entry).toBeVisible();
  await expect(line).toBeVisible();
  // where each path starts, in screen px
  const from = async (sel: string, edge: typeof entry) => edge.locator(sel).evaluate((el) => {
    const p = el as SVGPathElement;
    const pt = p.getPointAtLength(0);
    const m = p.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  });
  const e = await from('path.entry-line', entry);
  const c = await from('path.cache-line', line);
  // the tip is the middle of the shape's right edge, the back the middle of its left edge
  expect(Math.abs(e.x - (tri.x + tri.width)), 'entry arrow starts at the tip').toBeLessThan(14);
  expect(Math.abs(e.y - (tri.y + tri.height / 2))).toBeLessThan(14);
  expect(Math.abs(c.x - tri.x), 'cache line starts at the back').toBeLessThan(14);
  expect(Math.abs(c.y - (tri.y + tri.height / 2))).toBeLessThan(14);
  // solid vs dashed
  expect(await entry.locator('path.entry-line').evaluate((el) => getComputedStyle(el).strokeDasharray)).toMatch(/^(none|)$/);
  expect(await line.locator('path.cache-line').evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toMatch(/^(none|)$/);
  // the step-to-step wire has its letter pill and is not drawn from the triangle
  await expect(wireEdge(page, ids.s1!, ids.s2!).locator('.pill')).toBeVisible();
  // no arrow into the orphan, no arrow from the second step's workflow
  await expect(entryEdge(page, ids.w1!, ids.orphan!)).toHaveCount(0);
  await expect(page.locator(`.react-flow__edge[data-id$=":${ids.orphan}"]`)).toHaveCount(0);
});

test('the minimap marks every triangle, step and cache, and a click on a mark jumps there', async ({ page }) => {
  const ids = await seed(SEED);
  const [workflows, steps, caches] = await Promise.all([getJson<Row[]>('/workflows'), getJson<Row[]>('/steps'), getJson<Row[]>('/caches')]);
  await openFitted(page);
  const mini = page.locator('.react-flow__minimap');
  await expect(mini).toBeVisible();
  await expect(mini.locator('[data-mini-triangle]')).toHaveCount(workflows.length);
  await expect(mini.locator('[data-mini-step]')).toHaveCount(steps.length);
  await expect(mini.locator('[data-mini-cache]')).toHaveCount(caches.length);
  await expect(mini.locator(`[data-mini-triangle="${ids.w1}"]`)).toHaveCount(1);
  // zoom in on the throwaway triangle through the minimap: a click centres the board on it
  const before = await page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform);
  await mini.locator(`[data-mini-triangle="${ids.w1}"]`).click({ force: true });
  await expect.poll(() => page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)).not.toBe(before);
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const tri = await centre(wfNode(page, ids.w1!));
  expect(Math.abs(tri.x - (pane.x + pane.width / 2)), 'centred across').toBeLessThan(pane.width / 4);
  expect(Math.abs(tri.y - (pane.y + pane.height / 2)), 'centred down').toBeLessThan(pane.height / 4);
});

test('Fit puts everything on the board in view', async ({ page }) => {
  await seed(SEED);
  await openAt(page, { x: 0, y: 0 }, 1);
  // zoomed in on the throwaway corner, most of the board is out of view
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const outside = async () => page.evaluate((p) => [...document.querySelectorAll('.react-flow__node')].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.left < p.x - 2 || r.top < p.y - 2 || r.right > p.x + p.width + 2 || r.bottom > p.y + p.height + 2;
  }).length, pane);
  expect(await outside()).toBeGreaterThan(0);
  const z0 = await zoomOf(page);
  // a press while React Flow is still measuring the nodes fits nothing: press again until the view changes
  await expect(async () => {
    await page.locator('.react-flow__controls-fitview').click();
    await expect.poll(() => zoomOf(page), { timeout: 2000 }).toBeLessThan(z0);
  }).toPass({ timeout: 15_000 });
  await expect.poll(outside).toBe(0);
  // and the controls zoom in and out
  const z1 = await zoomOf(page);
  await page.locator('.react-flow__controls-zoomin').click();
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(z1);
  await page.locator('.react-flow__controls-zoomout').click();
  await expect.poll(() => zoomOf(page)).toBeCloseTo(z1, 1);
});

test('every item is a React Flow node of its own kind: triangles, steps and caches, none a frame', async ({ page }) => {
  const ids = await seed(SEED);
  await openAt(page);
  await expect(wfNode(page, ids.w1!).locator('svg.tri-shape')).toBeVisible();
  await expect(wfNode(page, ids.w1!).locator('.tri-st')).toHaveText(/Stopped|Checking…|Unknown/);
  await expect(stNode(page, ids.s1!).locator('.sn')).toHaveText('e2e-board-first');
  await expect(stNode(page, ids.s1!).locator('.sp2')).toHaveText('archive-expander');
  await expect(caNode(page, ids.c1!).locator('.cache-nm')).toHaveText('e2e-board-cache');
  await expect(page.locator('.react-flow__node-frame, .frame, .react-flow__node-group')).toHaveCount(0);
  await expect(page.getByText(/^(FIRST|PARKED)$/)).toHaveCount(0);
});
