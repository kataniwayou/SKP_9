import { test as plain, type Locator, type Page, type Route } from '@playwright/test';
import { documentPanel, expect, inspector, liveWorkflows, openWorkflow, outputLines, selectProcessor, tab, test, type LiveWorkflow } from './studio';

// The user's fixes of 2026-11-01, with the real mouse against the live BaseApi. Nothing is written: a test that presses
// Save answers the PUT itself (route.fulfill), so the request never leaves the browser; the others only read.
let wf: LiveWorkflow;
plain.beforeAll(async ({ request }) => { [wf] = await liveWorkflows(request, 1); });

async function fresh(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
}

/** The groups of the dock as `x,y w×h [tabs]`, left to right and top to bottom. */
const layout = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.dv-groupview')].map((e) => {
  const r = e.getBoundingClientRect();
  return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} [${[...e.querySelectorAll('.dv-tab .nm')].map((t) => t.textContent).join('|')}]`;
}));

/** Answers the next Save with `log` (BaseApi's lines) and keeps the body the studio sent; nothing reaches BaseApi. */
async function answerSave(page: Page, log: (body: SentBody) => { level: string; message: string }[]): Promise<() => SentBody | null> {
  let sent: SentBody | null = null;
  await page.route('**/design', async (route: Route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    sent = JSON.parse(route.request().postData() ?? '{}') as SentBody;
    const lines = log(sent).map((l) => ({ stage: 'processors', kind: 'processor', id: null, ...l }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ applied: false, errors: [], log: lines }) });
  });
  return () => sent;
}
interface SentBody { processors: { id: string; fields: Record<string, unknown>; slots: Record<string, string> }[]; schemas: { id: string }[] }

async function saveNow(page: Page, panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: '⤓ Save' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveCount(0, { timeout: 20_000 });
}

/** The first processor of the open document with a schema in its In slot, picked in the Inspector. */
async function processorWithInput(page: Page, panel: Locator): Promise<boolean> {
  if (!(await selectProcessor(page, panel))) return false;
  const chips = panel.locator('.react-flow__node-step .chipg');
  for (let i = 0; i < Math.min(await chips.count(), 10); i++) {
    await chips.nth(i).click();
    if (await inspector(page).getByRole('button', { name: 'Clear the In schema' }).count()) return true;
  }
  return false;
}

test('a schema definition is shown one field to a line, and laid out it is no edit', async ({ page }) => {
  await fresh(page);
  await openWorkflow(page, wf);
  const panel = documentPanel(page, wf);
  test.skip(!(await processorWithInput(page, panel)), 'no processor of this workflow has an input schema');
  await inspector(page).locator('.slot button.drill').first().click();
  const definition = inspector(page).getByLabel('Definition', { exact: true });
  await expect(definition).toHaveValue(/^\{\n {2}"/);
  await expect(inspector(page).locator('.unsaved')).toHaveCount(0);
  // typed into, then back to the same JSON however laid out: no unsaved change
  const text = await definition.inputValue();
  await definition.fill(JSON.stringify(JSON.parse(text)));
  await expect(inspector(page).locator('.unsaved')).toHaveCount(0);
});

plain('a processor slot can be cleared: the block shows ∅ and Save sends the slot as null', async ({ page }) => {
  await fresh(page);
  await openWorkflow(page, wf);
  const panel = documentPanel(page, wf);
  plain.skip(!(await processorWithInput(page, panel)), 'no processor of this workflow has an input schema');
  const pid = await inspector(page).locator('.uname .ro').textContent();
  const sent = await answerSave(page, () => []);
  await inspector(page).getByRole('button', { name: 'Clear the In schema' }).click();
  await expect(inspector(page).locator('.slot').first()).toContainText('∅');
  await expect(inspector(page).locator('.slot').first().getByRole('button', { name: '＋ Define' })).toBeVisible();
  const chip = panel.locator(`.react-flow__node-step:has(.chipg) .chipg`).filter({ has: page.locator('.nx-tn') });
  await expect(chip.first()).toBeVisible();
  await saveNow(page, panel);
  const body = sent();
  expect(body?.processors).toHaveLength(1);
  expect(body!.processors[0]!.fields).toEqual({ inputSchemaId: null });
  expect(pid).toContain(body!.processors[0]!.id.slice(19));
});

plain('Output names the ids its lines carry as the Inspector names them', async ({ page }) => {
  await fresh(page);
  await openWorkflow(page, wf);
  const panel = documentPanel(page, wf);
  plain.skip(!(await processorWithInput(page, panel)), 'no processor of this workflow has an input schema');
  const unique = (await inspector(page).locator('.uname .ro').textContent())!;
  await answerSave(page, (b) => [{ level: 'error', message: `processor ${b.processors[0]!.id.toUpperCase()}: not re-pointed` }]);
  await inspector(page).getByRole('button', { name: 'Clear the In schema' }).click();
  await saveNow(page, panel);
  await expect((await outputLines(page)).filter({ hasText: 'not re-pointed' })).toContainText(`BaseApi · processor ${unique}: not re-pointed`);
});

test('the Toolbox tile shows a cleared or renamed slot as the canvas does, marked unsaved, until Revert', async ({ page }) => {
  await fresh(page);
  await openWorkflow(page, wf);
  const panel = documentPanel(page, wf);
  test.skip(!(await processorWithInput(page, panel)), 'no processor of this workflow has an input schema');
  const id = await panel.locator('.react-flow__node-step .chipg[data-processor]').evaluateAll((chips, unique) =>
    chips.map((c) => c.getAttribute('data-processor')!).find((pid) => unique.endsWith(pid.slice(19))), (await inspector(page).locator('.uname .ro').textContent())!);
  const tile = page.locator(`.tb-tile[data-id="${id}"]`);
  const inRow = () => tile.locator('.nx-tl', { hasText: 'in' }).locator('xpath=following-sibling::*[1]');
  const before = await inRow().textContent();
  await inspector(page).getByRole('button', { name: 'Clear the In schema' }).click();
  await expect(inRow()).toHaveText('∅');
  await expect(tile.locator('.tb-unsaved')).toHaveCount(1);
  await inspector(page).getByRole('button', { name: 'Revert' }).click();
  await expect(inRow()).toHaveText(before!);
  await expect(tile.locator('.tb-unsaved')).toHaveCount(0);
  await inspector(page).locator('.slot button.drill').first().click();
  await inspector(page).getByLabel('Name', { exact: true }).fill('renamed-in');
  await expect(inRow()).toHaveText(/^renamed-in/);
  await expect(tile.locator('.tb-unsaved')).toHaveCount(1);
});

test('closing the last document keeps every other window where it is and as large', async ({ page, request }) => {
  await fresh(page);
  const [a, b] = await liveWorkflows(request, 2).catch(() => [wf, wf]);
  await openWorkflow(page, a!);
  if (b!.id !== a!.id) await openWorkflow(page, b!);
  // the Toolbox made wider than the default first, so a re-spread layout would show
  const sash = await page.locator('.dv-groupview').first().boundingBox();
  await page.mouse.move(sash!.x + sash!.width + 1, 400);
  await page.mouse.down();
  await page.mouse.move(sash!.x + sash!.width + 81, 400, { steps: 8 });
  await page.mouse.up();
  const before = (await layout(page)).map((g) => g.replace(/\[.*\]/, ''));
  for (const w of new Set([a!.name, b!.name])) await tab(page, w).locator('.x').click();
  await expect(page.locator('.docpanel')).toHaveCount(0);
  expect((await layout(page)).map((g) => g.replace(/\[.*\]/, ''))).toEqual(before);
  // the next document goes back into the same place
  await openWorkflow(page, a!);
  expect((await layout(page)).map((g) => g.replace(/\[.*\]/, ''))).toEqual(before);
});

plain('resizing a pane keeps the place being read in Output; at its end it stays at the end', async ({ page }) => {
  await fresh(page);
  await openWorkflow(page, wf);
  const panel = documentPanel(page, wf);
  plain.skip(!(await processorWithInput(page, panel)), 'no processor of this workflow has an input schema');
  await answerSave(page, () => Array.from({ length: 80 }, (_, i) => ({ level: 'info', message: `line ${i}` })));
  await inspector(page).getByRole('button', { name: 'Clear the In schema' }).click();
  await saveNow(page, panel);
  const log = (await outputLines(page)).first().locator('..');
  const atEnd = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  await expect.poll(atEnd).toBe(true);
  // scrolled up to read, then the Output group made taller by dragging the sash above it
  await log.evaluate((el) => { el.scrollTop = 40; });
  await dragSash(page, -120);
  expect(await log.evaluate((el) => el.scrollTop)).toBe(40);
  // back at the end, a resize keeps it there
  await log.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await dragSash(page, 160);
  await expect.poll(atEnd).toBe(true);
});

/** Drags the dock's one horizontal sash (between the documents and Output) by `dy`, with the real mouse. */
async function dragSash(page: Page, dy: number): Promise<void> {
  const at = await page.evaluate(() => {
    const s = [...document.querySelectorAll('.dv-sash')].map((e) => e.getBoundingClientRect()).find((r) => r.width > r.height);
    return s ? { x: s.x + s.width / 2, y: s.y + s.height / 2 } : null;
  });
  expect(at, 'the layout has a sash above Output').not.toBeNull();
  await page.mouse.move(at!.x, at!.y);
  await page.mouse.down();
  await page.mouse.move(at!.x, at!.y + dy, { steps: 8 });
  await page.mouse.up();
}

test('a light theme from the menu strip, remembered across a reload; the blocks keep their dark art', async ({ page }) => {
  await fresh(page);
  await openWorkflow(page, wf);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Light theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(238, 242, 247)');
  const name = documentPanel(page, wf).locator('.chipg .nx-pn').first();
  expect(await name.evaluate((el) => getComputedStyle(el).fill)).toBe('rgb(230, 238, 248)');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.getByRole('menuitem', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Dark theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});
