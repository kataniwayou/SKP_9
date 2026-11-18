import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { openAt, openFitted, out, pickStep, selectWorkflowAlone, selbar, waitLoaded } from './helpers';
import { seed } from './seed';

// Panels and theme, Output, and no keyboard hints. Nothing here writes to BaseAPI.

const width = async (page: Page, panel: string) => Math.round((await page.locator(`[data-panel="${panel}"]`).boundingBox())!.width);
const height = async (page: Page, panel: string) => Math.round((await page.locator(`[data-panel="${panel}"]`).boundingBox())!.height);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('acto.panels') ?? '{}') as Record<string, number | null>);

/** A real pointer drag of the named splitter by (dx, dy). */
async function dragSplitter(page: Page, name: string, dx: number, dy: number) {
  const b = (await page.getByRole('separator', { name }).boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + Math.min(b.height / 2, 120);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test('the four splitters resize their panels, the sizes are kept across a reload, a double-click resets each', async ({ page }) => {
  await openFitted(page);
  await expect(page.getByRole('separator')).toHaveCount(4);
  const w0 = { tools: await width(page, 'toolbox'), insp: await width(page, 'inspector'), bottom: await height(page, 'output'), output: await width(page, 'output') };
  expect(w0.tools).toBe(200);
  expect(w0.insp).toBe(300);
  expect(w0.bottom).toBe(190);

  await dragSplitter(page, 'Resize toolbox', 60, 0);
  await dragSplitter(page, 'Resize inspector', -80, 0);
  await dragSplitter(page, 'Resize bottom panels', 0, -50);
  // the Output takes half the bottom row until it is dragged: what the other splitters left it, then 100 px more
  const outputBefore = await width(page, 'output');
  await dragSplitter(page, 'Resize output', 100, 0);
  const want = { tools: 260, insp: 380, bottom: 240, output: outputBefore + 100 };
  await expect.poll(() => width(page, 'toolbox')).toBe(want.tools);
  await expect.poll(() => width(page, 'inspector')).toBe(want.insp);
  await expect.poll(() => height(page, 'output')).toBe(want.bottom);
  await expect.poll(async () => Math.abs((await width(page, 'output')) - want.output)).toBeLessThanOrEqual(1);
  const saved = await stored(page);
  expect(saved).toMatchObject({ tools: 260, inspector: 380, bottom: 240 });
  expect(Math.abs((saved.output ?? 0) - want.output)).toBeLessThanOrEqual(1);

  await page.reload();
  await waitLoaded(page);
  expect(await width(page, 'toolbox')).toBe(want.tools);
  expect(await width(page, 'inspector')).toBe(want.insp);
  expect(await height(page, 'output')).toBe(want.bottom);
  expect(Math.abs((await width(page, 'output')) - want.output)).toBeLessThanOrEqual(1);

  // limits: the toolbox stops at 340
  await dragSplitter(page, 'Resize toolbox', 400, 0);
  await expect.poll(() => width(page, 'toolbox')).toBe(340);

  for (const name of ['Resize toolbox', 'Resize inspector', 'Resize bottom panels', 'Resize output']) {
    await page.getByRole('separator', { name }).dblclick();
  }
  await expect.poll(() => width(page, 'toolbox')).toBe(200);
  await expect.poll(() => width(page, 'inspector')).toBe(300);
  await expect.poll(() => height(page, 'output')).toBe(190);
  await expect.poll(async () => Math.abs((await width(page, 'output')) - w0.output)).toBeLessThanOrEqual(1);
  expect(await stored(page)).toEqual({ tools: 200, inspector: 300, bottom: 190, output: null });
});

/** Panels (and big surfaces in them) whose background is light: none may be in the dark theme. */
const lightSurfaces = (page: Page) => page.evaluate(() => {
  const lum = (c: string) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const out: string[] = [];
  const check = (el: Element, what: string) => {
    const l = lum(getComputedStyle(el).backgroundColor);
    if (l !== null && l > 0.5) out.push(`${what} (${getComputedStyle(el).backgroundColor})`);
  };
  check(document.body, 'body');
  check(document.querySelector('.acto')!, 'page');
  for (const p of document.querySelectorAll<HTMLElement>('.pane')) {
    check(p, `pane ${p.dataset.panel}`);
    // what fills most of a panel (a log, a list, an input box), not the frames and cards on the board
    for (const el of p.querySelectorAll<HTMLElement>('*')) {
      // the frames and cards keep the light look in both themes (tokens.css), and the floating toolbars are inverted
      // on purpose (--bar is light in the dark theme); the minimap has its own test below
      if (el.closest('.react-flow__node, .react-flow__edges, .react-flow__edgelabel-renderer, .toolbar, .react-flow__minimap')) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 4000) continue;
      const l = lum(getComputedStyle(el).backgroundColor);
      if (l !== null && l > 0.5) out.push(`${p.dataset.panel}: ${el.tagName.toLowerCase()}.${[...el.classList].join('.')} (${getComputedStyle(el).backgroundColor})`);
    }
  }
  return out;
});

test('the theme toggle switches to dark and back, the choice survives a reload, and no panel stays white', async ({ page }) => {
  await openFitted(page);
  const html = page.locator('html');
  const toggle = page.locator('.theme-toggle');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveText('Dark');
  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveText('Light');
  expect(await page.evaluate(() => localStorage.getItem('acto.theme'))).toBe('dark');
  await page.reload();
  await waitLoaded(page);
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveText('Light');
  // with things picked too (the Inspector's editors show)
  await page.locator('.react-flow__node-workflow .tri-nm').first().click();
  expect(await lightSurfaces(page), 'light surfaces in the dark theme').toEqual([]);
  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await waitLoaded(page);
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test("in the dark theme the minimap stays the board's white card, like the frames and step cards", async ({ page }) => {
  // By design (tokens.css, board.css: "a rounded white card"): the board keeps the reactflow.dev look in both themes.
  // Pinned here so a change to it is a decision, not an accident.
  await openFitted(page);
  await page.locator('.theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await page.locator('.react-flow__minimap').evaluate((el) => getComputedStyle(el).backgroundColor);
  const card = await page.locator('.react-flow__node-step .node').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(card);
  const paper = await page.locator('.react-flow').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(paper).not.toBe(bg);
});

test('Output: Clear all empties it; Newest first / Newest last reorders and is remembered', async ({ page }) => {
  await openFitted(page);
  const o = out(page);
  const rows = o.locator('[role="listitem"] span');
  await expect(rows.first()).toBeVisible();
  await o.getByRole('button', { name: 'Clear all' }).click();
  await expect(o.getByText('No messages.')).toBeVisible();
  await expect(o.locator('.cnt')).toHaveText('');
  // three refusals as messages: Ctrl+V with nothing copied
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+v');
  await expect(o.locator('.cnt')).toHaveText('3 messages');
  await expect(rows.last()).toHaveText('Nothing copied yet');
  await expect(o.locator('.k-warn')).toHaveCount(3);
  await expect(o.getByRole('button', { name: 'Newest last' })).toHaveAttribute('aria-pressed', 'true');
  await o.getByRole('button', { name: 'Newest first' }).click();
  await expect(o.getByRole('button', { name: 'Newest first' })).toHaveAttribute('aria-pressed', 'true');
  await expect(o.getByRole('button', { name: 'Newest last' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('acto.outputNewestFirst'))).toBe('true');
  await page.reload();
  await waitLoaded(page);
  await expect(o.getByRole('button', { name: 'Newest first' })).toHaveAttribute('aria-pressed', 'true');
  // newest first after the reload too: the board-loaded line just logged is on top
  await expect(rows.first()).toHaveText(/^Board loaded/);
  await o.getByRole('button', { name: 'Newest last' }).click();
  await expect(rows.last()).toHaveText(/^Board loaded/);
  expect(await page.evaluate(() => localStorage.getItem('acto.outputNewestFirst'))).toBe('false');
});

test('no keyboard hints anywhere: no Ctrl+ or ⌘ in any text, title, label or placeholder', async ({ page }) => {
  const hints = () => page.evaluate(() => {
    const re = /Ctrl\s*\+|Ctrl-|Cmd\s*\+|⌘|Shift\s*\+|Alt\s*\+/i;
    const found: string[] = [];
    if (re.test(document.body.innerText)) found.push(...document.body.innerText.split('\n').filter((l) => re.test(l)));
    for (const el of document.querySelectorAll('[title], [aria-label], [placeholder], [aria-description]')) {
      for (const a of ['title', 'aria-label', 'placeholder', 'aria-description']) {
        const v = el.getAttribute(a);
        if (v && re.test(v)) found.push(`${a}="${v}"`);
      }
    }
    return found;
  });
  const id = await seed({
    steps: [{ key: 's1', name: 'e2e-shell-a', at: { x: 300, y: 100 }, next: ['s2'] }, { key: 's2', name: 'e2e-shell-b', at: { x: 600, y: 100 } }],
    caches: [{ key: 'c', name: 'e2e-shell-cache', at: { x: 40, y: 360 } }],
    workflows: [{ key: 'w', name: 'e2e-shell-wf', at: { x: 0, y: 30 }, entry: ['s1'], caches: ['c'] }],
  });
  await openAt(page);
  expect(await hints(), 'fresh board').toEqual([]);
  await selectWorkflowAlone(page, id.w!);
  expect(await hints(), 'a triangle picked').toEqual([]);
  await pickStep(page, id.s1!);
  expect(await hints(), 'a step picked').toEqual([]);
  await pickStep(page, id.s2!, true);
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('2 SELECTED');
  expect(await hints(), 'two steps picked').toEqual([]);
  await page.locator('.theme-toggle').click();
  expect(await hints(), 'dark theme').toEqual([]);
});
