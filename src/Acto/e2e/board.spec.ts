import { test, expect } from './fixtures';
import { frameOf, LOADED, openBoard, outLine, pickFrame, waitLoaded, zoomOf } from './helpers';

// Features 1 (the board) and 3 (the minimap). Read-only: the pre-existing workflows are only looked at, picked and
// centred (the guard refuses any write).

test('every workflow BaseAPI holds has a frame, with the state badge the live set says', async ({ page, request }) => {
  const workflows = (await (await request.get('/api/v1/workflows')).json()) as { id: string; name: string; version: string }[];
  const live = new Set(((await (await request.get('/api/v1/orchestration/live')).json()) as string[]).map((x) => x.toLowerCase()));
  expect(workflows.length).toBeGreaterThan(0);
  const unplaced: string[] = [];
  page.on('console', (m) => { if (m.text().includes("Couldn't create edge")) unplaced.push(m.text()); });
  await openBoard(page);
  await expect(outLine(page, `Board loaded: ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`)).toHaveCount(1);
  await expect(page.locator('.react-flow__node-workflow')).toHaveCount(workflows.length);
  for (const w of workflows) {
    const f = frameOf(page, w.id);
    await expect(f).toBeVisible();
    await expect(f.locator('.nm')).toHaveText(w.name);
    await expect(f.locator('.meta')).toContainText(w.version);
    const want = live.has(w.id.toLowerCase()) ? 'Running' : 'Stopped';
    await expect(f.locator('.state-badge'), `${w.name} state`).toHaveText(want);
    await expect(f.locator('.frame')).toHaveClass(want === 'Running' ? /is-on/ : /is-off/);
  }
  expect(unplaced, 'React Flow could place every wire').toEqual([]);
});

test('step cards show at the first fit, every one inside its frame below the header', async ({ page, request }) => {
  const workflows = (await (await request.get('/api/v1/workflows')).json()) as { id: string }[];
  let graphSteps = 0;
  for (const w of workflows) graphSteps += ((await (await request.get(`/api/v1/workflows/${w.id}/graph`)).json()) as { steps: unknown[] }).steps.length;
  await openBoard(page);
  const steps = page.locator('.react-flow__node-step');
  // the graphs' steps, plus parked steps their layouts list
  expect(await steps.count()).toBeGreaterThanOrEqual(graphSteps);
  const report = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
    const zoom = Number(/scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)?.[1] ?? 1);
    const all = [...document.querySelectorAll<HTMLElement>('.react-flow__node-step')];
    const hidden: string[] = [];
    const outside: string[] = [];
    for (const n of all) {
      const s = n.getBoundingClientRect();
      const style = getComputedStyle(n);
      const card = n.querySelector('.node')?.getBoundingClientRect();
      if (s.width <= 0 || s.height <= 0 || !card || card.width <= 0 || style.visibility === 'hidden' || style.display === 'none'
        || s.right < pane.left || s.left > pane.right || s.bottom < pane.top || s.top > pane.bottom) hidden.push(n.dataset.id!);
      const [, wf] = (n.dataset.id ?? '').split(':');
      const f = document.querySelector<HTMLElement>(`.react-flow__node-workflow[data-id="wf:${wf}"]`);
      if (!f) { outside.push(`${n.dataset.id}: no frame`); continue; }
      const r = f.getBoundingClientRect();
      const tol = 1;
      if (s.left < r.left - tol || s.right > r.right + tol || s.bottom > r.bottom + tol || s.top < r.top + 46 * zoom - tol) outside.push(n.dataset.id!);
    }
    return { total: all.length, hidden, outside };
  });
  expect(report.hidden, 'step cards not shown at the first fit').toEqual([]);
  expect(report.outside, 'step cards outside their frame or in its header').toEqual([]);
});

test('frames arrive as their graphs do, then the board settles with no frame over another', async ({ page, request }) => {
  const workflows = (await (await request.get('/api/v1/workflows')).json()) as { id: string; name: string }[];
  test.skip(workflows.length < 2, 'needs two workflows');
  const slow = workflows[workflows.length - 1]!;
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/v1/workflows/${slow.id}/graph`, async (route) => { await held; await route.fallback(); });
  await page.goto('/');
  // the others are in while one graph is held back; the board is not loaded yet
  for (const w of workflows.slice(0, -1)) await expect(frameOf(page, w.id)).toBeVisible();
  await expect(frameOf(page, slow.id)).toHaveCount(0);
  await expect(outLine(page, LOADED)).toHaveCount(0);
  release();
  await waitLoaded(page);
  await expect(frameOf(page, slow.id)).toBeVisible();
  const boxes = await page.locator('.react-flow__node-workflow').evaluateAll((ns) => ns.map((n) => {
    const r = n.getBoundingClientRect();
    return { id: (n as HTMLElement).dataset.id!, x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) overlaps.push(`${a.id} / ${b.id}`);
  }
  expect(overlaps).toEqual([]);
});

test('a fresh board is unsaved only where a stored design left work, and a wobbly click on a frame picks it and moves nothing', async ({ page, stack }) => {
  await openBoard(page);
  const unsaved = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.react-flow__node-workflow')]
    .filter((n) => n.querySelector('.unsaved-tag')).map((n) => n.dataset.id!.slice(3)).sort());
  expect(await unsaved()).toEqual([...stack.designed].sort());
  for (const id of stack.designed) {
    const name = stack.workflows.find((w) => w.id === id)!.name;
    await expect(outLine(page, `${name}: loaded unsaved work from a save that failed`)).toHaveCount(1);
  }
  // a click whose pointer wobbles a few pixels picks the frame and moves nothing
  const target = stack.workflows.find((w) => !stack.designed.includes(w.id))!;
  const frame = frameOf(page, target.id);
  const before = await frame.evaluate((n) => (n as HTMLElement).style.transform);
  const b = (await frame.locator('.nm').boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let k = 1; k <= 3; k++) await page.mouse.move(x - k, y - k);
    await page.mouse.up();
  }
  expect(await unsaved()).toEqual([...stack.designed].sort());
  expect(await frame.evaluate((n) => (n as HTMLElement).style.transform)).toBe(before);
  await expect(page.locator('.react-flow__node-workflow.selected')).toHaveCount(1);
  await expect(frame).toHaveClass(/selected/);
});

test.describe('minimap', () => {
  test('names every frame; a click on one centres it at the same zoom; a picked frame is drawn in the accent', async ({ page, stack }) => {
    await openBoard(page);
    const mini = page.locator('.react-flow__minimap');
    await expect(mini).toBeVisible();
    const frames = mini.locator('g[data-mini-frame]');
    await expect(frames).toHaveCount(stack.workflows.length);
    for (const w of stack.workflows) await expect(mini.locator(`g[data-mini-frame="${w.id}"] title`)).toHaveText(w.name);
    // names are written on the frames that have room (shortened with … when long)
    expect(await mini.locator('g[data-mini-frame] text').count()).toBeGreaterThan(0);

    // pick the frame farthest from the middle of the view, then jump to it from the minimap
    const pane = (await page.locator('.react-flow').boundingBox())!;
    const mid = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
    let far = stack.workflows[0]!, dist = -1;
    for (const w of stack.workflows) {
      const r = (await frameOf(page, w.id).boundingBox())!;
      const d = Math.hypot(r.x + r.width / 2 - mid.x, r.y + r.height / 2 - mid.y);
      if (d > dist) { dist = d; far = w; }
    }
    const zoom = await zoomOf(page);
    await mini.locator(`g[data-mini-frame="${far.id}"] rect`).click();
    await expect.poll(async () => {
      const r = (await frameOf(page, far.id).boundingBox())!;
      return Math.round(Math.hypot(r.x + r.width / 2 - mid.x, r.y + r.height / 2 - mid.y));
    }).toBeLessThanOrEqual(3);
    expect(Math.abs((await zoomOf(page)) - zoom)).toBeLessThan(0.001);

    // the picked frame's outline is the theme's accent (the --accent token: #FF0072 in the light theme)
    const rect = mini.locator(`g[data-mini-frame="${far.id}"] rect`);
    const accent = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.color = 'var(--accent)';
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(accent).toBe('rgb(255, 0, 114)');
    await expect(rect).not.toHaveCSS('stroke', accent);
    await pickFrame(frameOf(page, far.id));
    await expect(rect).toHaveCSS('stroke', accent);
  });
});
