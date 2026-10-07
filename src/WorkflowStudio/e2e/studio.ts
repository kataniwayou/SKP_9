import { expect, test as base, type APIRequestContext, type Locator, type Page } from '@playwright/test';

export { expect };

/** Escapes a name for use inside a RegExp (workflow names are live data). */
export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The page test with a read-only guard: every request the browser context makes (the main window
 * and any pop-out) is recorded, and the test fails if one is neither a GET nor the validate dry run.
 */
export const test = base.extend<{ readOnly: void }>({
  readOnly: [async ({ context }, use) => {
    const writes: string[] = [];
    context.on('request', (r) => {
      const url = new URL(r.url());
      if (r.method() === 'GET' || r.method() === 'HEAD') return;
      if (r.method() === 'POST' && /^\/api\/v1\/workflows\/[^/]+\/validate$/.test(url.pathname)) return;
      writes.push(`${r.method()} ${url.pathname}`);
    });
    await use();
    expect(writes, 'the e2e tests must only read from BaseApi').toEqual([]);
  }, { auto: true }],
});


export interface LiveWorkflow { id: string; name: string; version: string; label: string }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The entity-name rule (model/entityNames.ts), so a test can find a workflow in the picker. */
const label = (name: string, version: string, id: string) => `${name}_${version}-${GUID.test(id) ? id.slice(19).toLowerCase() : id}`;

const TOOL_NAMES = new Set(['Toolbox', 'Inspector', 'Problems', 'Output']);

/**
 * Every workflow with a step, each with a distinct name that is not a tool window's. Read-only. Skips
 * workflows named `e2e-…`: those are another spec's throwaway entities (e2e/throwaway.ts), which it edits.
 */
export async function workflowsWithSteps(request: APIRequestContext): Promise<LiveWorkflow[]> {
  const list = await request.get('/api/v1/workflows');
  expect(list.ok()).toBe(true);
  const found: LiveWorkflow[] = [];
  const names = new Set<string>(TOOL_NAMES);
  for (const w of (await list.json()) as { id: string; name: string; version: string }[]) {
    if (names.has(w.name) || w.name.startsWith('e2e-')) continue;
    const graph = await request.get(`/api/v1/workflows/${w.id}/graph`);
    if (graph.ok() && ((await graph.json()) as { steps?: unknown[] }).steps?.length) {
      names.add(w.name);
      found.push({ id: w.id, name: w.name, version: w.version, label: label(w.name, w.version, w.id) });
    }
  }
  return found;
}

/** `count` workflows with distinct names (and none named like a tool window) that have a step. Read-only. */
export async function liveWorkflows(request: APIRequestContext, count: number): Promise<LiveWorkflow[]> {
  const found = await workflowsWithSteps(request);
  if (found.length < count) throw new Error(`BaseApi has fewer than ${count} workflows with steps and distinct names`);
  return found.slice(0, count);
}

/** File › Open workflow…, search by unique name, Enter; waits until the canvas has drawn. */
export async function openWorkflow(page: Page, workflow: LiveWorkflow): Promise<void> {
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Open workflow/ }).click();
  await page.getByRole('textbox', { name: 'Search workflows' }).fill(workflow.label);
  // on a cold dev server the list can still be loading: Enter on an empty list opens nothing
  await expect(page.getByRole('listbox', { name: 'Workflows' }).getByText(workflow.label, { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(documentPanel(page, workflow).locator('.react-flow__node').first()).toBeVisible();
}

/** A tab by the text it shows (a document's name, or a pane's title). */
export const tab = (page: Page, name: string): Locator => page.locator('.dv-tab .doctab').filter({ has: page.locator('.nm', { hasText: new RegExp(`^${esc(name)}$`) }) });

/** A document's panel, found by the unique name its toolbar carries. */
export const documentPanel = (page: Page, workflow: LiveWorkflow): Locator =>
  page.locator('.docpanel').filter({ has: page.locator(`.crumb[data-tip="${workflow.label.replace(/["\\]/g, '\\$&')}"]`) });

/** The Inspector's body wherever it is (docked, floating or in the flyout). */
export const inspector = (page: Page): Locator => page.locator('[data-pane="inspector"]');

/** The group (dockview's `.dv-groupview`) that holds a tab. */
export const groupOf = (page: Page, name: string): Locator => page.locator('.dv-groupview').filter({ has: tab(page, name) });

export async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not laid out');
  return b;
}

/** Moves a floating group (dockview positions it with inline left/top) so it covers `target`'s centre. */
export async function floatOver(floating: Locator, target: { x: number; y: number; width: number; height: number }): Promise<void> {
  const f = await box(floating);
  const dx = target.x + target.width / 2 - (f.x + f.width / 2);
  const dy = target.y + target.height / 2 - (f.y + f.height / 2);
  await floating.evaluate((el, [x, y]) => {
    const e = el as HTMLElement;
    e.style.left = `${parseFloat(e.style.left) + x!}px`;
    e.style.top = `${parseFloat(e.style.top) + y!}px`;
  }, [dx, dy]);
}

/** The rectangle two boxes share, or null. */
export function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width), t = Math.min(a.y + a.height, b.y + b.height);
  return r > x && t > y ? { x, y, width: r - x, height: t - y } : null;
}

/**
 * Selects a processor chip whose Inspector shows the three schema slots. Returns false when no chip
 * of the open document qualifies, so a test can skip with a reason instead of failing confusingly.
 */
export async function selectProcessor(page: Page, panel: Locator): Promise<boolean> {
  const chips = panel.locator('.react-flow__node-step .chipg');
  const n = Math.min(await chips.count(), 8);
  for (let i = 0; i < n; i++) {
    await chips.nth(i).click();
    if ((await inspector(page).locator('.kindpill').textContent()) === 'PROCESSOR' && (await inspector(page).locator('.slot').count()) === 3) return true;
  }
  return false;
}

/**
 * Waits until a canvas's view stops moving (a wheel zoom eases in; a resized canvas keeps its centre) and
 * returns its transform: re-read every 150 ms until two reads in a row match, at most 20 tries.
 */
export async function settledView(page: Page, viewport: Locator): Promise<string | null> {
  let last = await viewport.getAttribute('style');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const now = await viewport.getAttribute('style');
    if (now === last) return now;
    last = now;
  }
  throw new Error('the view did not settle: its transform still changed after 20 reads 150 ms apart');
}
