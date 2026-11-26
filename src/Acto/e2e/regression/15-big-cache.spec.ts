import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  field, inspector, LOADED, openAt, out, outLine, save, saveButton, showCache, storedKey, storedValue, unsavedCount, addItem, waitLoaded,
} from '../helpers';
import { seed } from '../seed';
import { apply, appendItems, bodyOf, getJson, itemsPage, orchestrate, type Row } from '../stack';

// Regression 15 (spec docs/superpowers/specs/2026-11-26-cache-items-append-design.md, 7.3; report: BIG-CACHE-REPORT.md): a cache of
// 1,000,000 items (keys k0000000.., 500-character values) in front of the board. On demand only: SKP_SCALE=1 (it builds the cache over
// HTTP, 20 appends of 50,000, and A3 starts a workflow on it, which fills the dev Redis with a million entries). Everything the run makes is
// named e2e-; the workflow is stopped and its L2 keys removed here (the product never removes a deleted workflow's keys), and the guard's
// teardown deletes the rows. The 1M cache cannot outlive a test (the guard deletes every e2e- row after each), so each test builds its own (~30 s).
//
// A1 board load as fast with the cache as without; A2 first page and paging; A3 edits across 3 pages, Undo, one Save, the running
// workflow's Redis; A4 stale Save + Take stored keeps item edits; A5 a Save over 30 MB is refused, nothing applied, edits kept.

test.skip(process.env.SKP_SCALE !== '1', 'the big-cache run: set SKP_SCALE=1');
test.use({ actionTimeout: 60_000 });

const TOTAL = 1_000_000;
const PAGE = 500;
const ROOT = 'e2e-big';
const key = (n: number) => `k${String(n).padStart(7, '0')}`;
const val = (n: number) => `${n.toString(36)}-`.repeat(100).slice(0, 500);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const note = (what: string, value: unknown) => {
  const line = `${what}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  console.log(`[big-cache] ${line}`);
  test.info().annotations.push({ type: 'measure', description: line });
};

const kubectl = (...args: string[]) => execFileSync('kubectl', ['-n', 'skp', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
const redisGet = (k: string) => kubectl('exec', 'redis-0', '--', 'redis-cli', 'get', k).replace(/\r?\n$/, '');
const redisCard = (k: string) => Number(kubectl('exec', 'redis-0', '--', 'redis-cli', 'scard', k).trim());
const entryKey = (wf: string, k: string) => `skp:wf:${wf}:cache:${ROOT}:${k}`;

/** The throwaway cache with a million items, bound to a throwaway workflow whose one step is outcome-recorder (live, no schema). */
async function seedMillion(): Promise<{ cache: string; wf: string }> {
  const id = await seed({
    steps: [{ key: 's', name: 'e2e-big-step', at: { x: 0, y: 0 }, processor: 'outcome-recorder' }],
    caches: [{ key: 'c', name: 'e2e-big-cache', at: { x: 300, y: 0 }, root: ROOT }],
    workflows: [{ key: 'w', name: 'e2e-big-wf', at: { x: 150, y: 200 }, entry: ['s'], caches: ['c'] }],
  });
  const t = Date.now();
  for (let b = 0; b < 20; b++) {
    const items: Record<string, string> = {};
    for (let n = b * 50_000; n < (b + 1) * 50_000; n++) items[key(n)] = val(n);
    await appendItems(id.c!, items);
  }
  note('built the 1,000,000-item cache over HTTP (20 x 50,000), seconds', Math.round((Date.now() - t) / 1000));
  expect((await getJson<Row>(`/caches/${id.c}`)).itemCount).toBe(TOTAL);
  return { cache: id.c!, wf: id.w! };
}

async function startAndWait(wf: string) {
  const t = Date.now();
  const r = await orchestrate('start', wf);
  expect(r.status, `start: ${await r.clone().text()}`).toBe(202);
  const last = entryKey(wf, key(TOTAL - 1));
  for (let i = 0; i < 240 && redisGet(last) !== val(TOTAL - 1); i++) await new Promise((x) => setTimeout(x, 500));
  expect(redisGet(last), 'the last entry reached Redis').toBe(val(TOTAL - 1));
  // the start is complete once the workflow is in the live set
  for (let i = 0; i < 120 && !((await getJson<string[]>('/orchestration/live')).includes(wf)); i++) await new Promise((x) => setTimeout(x, 500));
  note('Start of a workflow on the 1M cache until live, seconds', ((Date.now() - t) / 1000).toFixed(1));
}

async function stopAndClean(wf: string) {
  await orchestrate('stop', wf).catch(() => null);
  await new Promise((x) => setTimeout(x, 4000));
  try {
    kubectl('exec', 'redis-0', '--', 'sh', '-c', `redis-cli --scan --pattern 'skp:wf:${wf}*' | xargs -n 1000 redis-cli unlink > /dev/null`);
  } catch { /* nothing left to remove */ }
}

/** A stored value edited: typed, then committed with Enter (a cell commits on Enter or leaving it). */
async function editValue(page: Page, k: string, v: string) {
  await storedValue(page, k).fill(v);
  await storedValue(page, k).press('Enter');
}
const undoBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true });
const nextBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Next', exact: true });
const prevBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Previous', exact: true });

test('A1 + A2: the board opens with the 1M cache as fast as without it and fetches no items; the Cache tab shows the first page fast and pages correctly', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const loadMs = async () => {
    const t = Date.now();
    await page.goto('/');
    await expect(outLine(page, LOADED).first()).toBeVisible();
    return Date.now() - t;
  };
  const itemRequests: string[] = [];
  page.on('request', (r) => { if (/\/caches\/[^/]+\/items/.test(r.url())) itemRequests.push(r.url()); });

  await loadMs(); // warm-up
  const without = median([await loadMs(), await loadMs(), await loadMs(), await loadMs(), await loadMs()]);
  const { cache } = await seedMillion();
  await loadMs(); // warm-up after the seed
  const withMillion = median([await loadMs(), await loadMs(), await loadMs(), await loadMs(), await loadMs()]);
  note('A1 board load, ms, median of 5: without the 1M cache / with it / difference %', [without, withMillion, Math.round(((withMillion - without) / without) * 100)]);
  expect(itemRequests, 'loading the board fetched no cache items').toEqual([]);
  expect(Math.abs(withMillion - without) / without, 'board load within 20 %').toBeLessThanOrEqual(0.2);

  // A2: the first page
  await openAt(page);
  const t = Date.now();
  await showCache(page, cache);
  await expect(storedValue(page, key(0))).toBeVisible();
  const firstMs = Date.now() - t;
  note('A2 first page of the 1M cache visible after picking it, ms', firstMs);
  expect(firstMs).toBeLessThan(2000);
  await expect(inspector(page).getByText(/1,?000,?000 stored/)).toBeVisible();
  for (const n of [0, 1, 250, PAGE - 1]) await expect(storedValue(page, key(n))).toHaveValue(val(n));
  await expect(storedKey(page, key(PAGE))).toHaveCount(0);
  await expect(prevBtn(page)).toBeDisabled();

  // next, next, previous: each page's keys and values are the stored ones
  for (const [page2, n] of [[1, PAGE], [2, 2 * PAGE]] as const) {
    const t2 = Date.now();
    await nextBtn(page).click();
    await expect(storedValue(page, key(n))).toBeVisible();
    note(`A2 page ${page2 + 1} visible after Next, ms`, Date.now() - t2);
    for (const m of [n, n + 1, n + 250, n + PAGE - 1]) await expect(storedValue(page, key(m))).toHaveValue(val(m));
    await expect(storedKey(page, key(n - 1))).toHaveCount(0);
  }
  await prevBtn(page).click();
  await expect(storedValue(page, key(PAGE))).toHaveValue(val(PAGE));
  await expect(storedKey(page, key(2 * PAGE))).toHaveCount(0);
  await prevBtn(page).click();
  await expect(storedValue(page, key(0))).toHaveValue(val(0));
  await expect(prevBtn(page)).toBeDisabled();
});

test('A3: edits across three pages, Undo, one Save: stored in BaseApi and in the running workflow\'s Redis', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const { cache, wf } = await seedMillion();
  try {
    await startAndWait(wf);
    await openAt(page);
    await showCache(page, cache);
    await expect(storedValue(page, key(10))).toBeVisible();

    await editValue(page, key(10), 'edited-page-1');
    await expect(inspector(page).getByText(/stored · 1 unsaved/)).toBeVisible();
    await nextBtn(page).click();
    await editValue(page, key(PAGE + 10), 'edited-page-2');
    await nextBtn(page).click();
    await editValue(page, key(2 * PAGE + 10), 'edited-page-3');
    await inspector(page).getByRole('button', { name: `Remove ${key(2 * PAGE + 11)}`, exact: true }).click();
    await addItem(page, 'big-new-item', 'added');
    await expect(inspector(page).getByText(/1,?000,?000 stored · 5 unsaved/)).toBeVisible();
    note('A3 unsaved count shown after 3 edits, 1 removal, 1 add (expected 5)', 5);

    // Undo takes back the last edit (the add), nothing else
    await undoBtn(page).click();
    await expect(inspector(page).getByText(/1,?000,?000 stored · 4 unsaved/)).toBeVisible();
    await expect(inspector(page).getByRole('textbox', { name: 'Unsaved key big-new-item', exact: true })).toHaveCount(0);
    // and the unsaved edits of the other pages are still there after going back
    await prevBtn(page).click();
    await prevBtn(page).click();
    await expect(storedValue(page, key(10))).toHaveValue('edited-page-1');
    await expect(inspector(page).getByText(/1,?000,?000 stored · 4 unsaved/)).toBeVisible();

    const applies: { changes?: { op: string; table: string }[] }[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/v1/model/apply')) applies.push(r.postDataJSON()); });
    const t = Date.now();
    expect((await save(page)).applied).toBe(true);
    note('A3 Save (apply + read back) ms', Date.now() - t);
    expect(applies.length, 'the Save is one model/apply').toBe(1);
    expect(applies[0]!.changes!.filter((c) => c.table === 'cache_items').map((c) => c.op).sort()).toEqual(['append', 'remove']);
    await expect(saveButton(page)).toBeDisabled();

    // BaseApi
    const first = await itemsPage(cache, undefined, 2000);
    const at = Object.fromEntries(first.items.map((i) => [i.key, i.value]));
    expect([at[key(10)], at[key(PAGE + 10)], at[key(2 * PAGE + 10)]]).toEqual(['edited-page-1', 'edited-page-2', 'edited-page-3']);
    expect(at[key(2 * PAGE + 11)], 'the removed item').toBeUndefined();
    expect(at['big-new-item'], 'the undone add was never sent').toBeUndefined();
    expect((await getJson<Row>(`/caches/${cache}`)).itemCount).toBe(TOTAL - 1);

    // the running workflow's Redis: the edits, the removal, and the key set, a few seconds after the Save
    const want: [string, string][] = [[key(10), 'edited-page-1'], [key(PAGE + 10), 'edited-page-2'], [key(2 * PAGE + 10), 'edited-page-3'], [key(2 * PAGE + 11), '']];
    const t2 = Date.now();
    for (let i = 0; i < 60 && want.some(([k, v]) => redisGet(entryKey(wf, k)) !== v); i++) await new Promise((x) => setTimeout(x, 500));
    note('A3 running workflow saw the edits in Redis after ms', Date.now() - t2);
    for (const [k, v] of want) expect(redisGet(entryKey(wf, k)), `Redis ${k}`).toBe(v);
    expect(redisCard(`skp:wf:${wf}:cache:${ROOT}::keys`)).toBe(TOTAL - 1);
  } finally {
    await stopAndClean(wf);
  }
});

test('A4: a Save refused because the cache row changed elsewhere; Take stored drops the field edit and keeps the item edits', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const { cache } = await seedMillion();
  await openAt(page);
  await showCache(page, cache);
  await expect(storedValue(page, key(10))).toBeVisible();
  await editValue(page, key(10), 'mine-item');
  await field(page, 'Description').fill('my description');
  await expect(inspector(page).getByText(/stored · 1 unsaved/)).toBeVisible();
  expect(await unsavedCount(page)).toBeGreaterThanOrEqual(1);

  // someone else changes the cache row
  const row = await getJson<Row>(`/caches/${cache}`);
  await apply([{ op: 'update', table: 'caches', id: cache, row: { ...bodyOf(row), description: 'changed elsewhere' }, updatedAt: row.updatedAt as string }]);

  const answer = await save(page);
  expect(answer.applied, 'refused').toBe(false);
  await expect(outLine(page, 'e2e-big-cache changed elsewhere — Take stored drops your change to it')).toHaveCount(1);
  const take = page.locator('button.take-stored');
  await expect(take).toBeVisible();
  note('A4 Take stored button says', await take.innerText());
  const stored = await itemsPage(cache, undefined, 20);
  expect(stored.items.find((i) => i.key === key(10))?.value, 'nothing was saved').toBe(val(10));

  await take.click();
  await expect(take).toHaveCount(0);
  await expect(field(page, 'Description')).toHaveValue('changed elsewhere');
  await expect(storedValue(page, key(10))).toHaveValue('mine-item'); // the item edit is kept
  await expect(inspector(page).getByText(/1,?000,?000 stored · 1 unsaved/)).toBeVisible();
  expect((await save(page)).applied).toBe(true);
  const after = await itemsPage(cache, undefined, 20);
  expect(after.items.find((i) => i.key === key(10))?.value).toBe('mine-item');
  expect((await getJson<Row>(`/caches/${cache}`)).description).toBe('changed elsewhere');
});

test('A5: a Save over 30 MB is refused: an error is logged, nothing is applied, the edits are kept', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const { cache } = await seedMillion();
  await openAt(page);
  await showCache(page, cache);
  await expect(storedValue(page, key(0))).toBeVisible();
  // 31 items of 1,000,000 characters (the value limit is 1,048,576): a request body of about 31 MB
  const big = 'x'.repeat(1_000_000);
  for (let i = 0; i < 31; i++) await addItem(page, `big-${String(i).padStart(2, '0')}`, big);
  await expect(inspector(page).getByText(/1,?000,?000 stored · 31 unsaved/)).toBeVisible();

  const sent: { status?: number; failure?: string }[] = [];
  page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().endsWith('/api/v1/model/apply')) sent.push({ status: r.status() }); });
  page.on('requestfailed', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/v1/model/apply')) sent.push({ failure: r.failure()?.errorText }); });
  await clearOut(page);
  const t = Date.now();
  await saveButton(page).click();
  await expect(saveButton(page)).not.toHaveText('Saving…', { timeout: 120_000 });
  note('A5 the Save button came back after ms', Date.now() - t);
  await expect.poll(() => sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const lines = await out(page).locator('[role="listitem"] span').allInnerTexts();
  note('A5 what the browser saw of the request', sent);
  note('A5 what Output said', lines);

  expect(lines.length, 'Output logged something').toBeGreaterThan(0);
  expect(lines.some((l) => /fail|refus|error|large|reset|network|413|too big|could not|didn't|did not/i.test(l)), 'an error line in Output').toBe(true);
  expect(lines.some((l) => /^Pushed /.test(l)), 'no "Pushed" line: nothing was applied').toBe(false);
  expect(sent.every((s) => s.status !== 200), 'the request was not accepted').toBe(true);
  // nothing applied (the reset can take a port-forward down for a moment: retry the reads)
  const retry = async <T>(f: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 30) throw e; await new Promise((x) => setTimeout(x, 1000)); } }
  };
  expect((await retry(() => getJson<Row>(`/caches/${cache}`))).itemCount).toBe(TOTAL);
  const head = await retry(() => itemsPage(cache, undefined, 5));
  expect(head.items.map((i) => i.key), 'no big- item was stored').not.toContain('big-00');
  // the edits are kept
  await expect(inspector(page).getByText(/1,?000,?000 stored · 31 unsaved/)).toBeVisible();
  expect(await unsavedCount(page), 'the Save button still counts the unsaved work').toBeGreaterThanOrEqual(1);
  // what Acto does about it, recorded: the Save is locked with its own reason until a reload (the connection was cut mid-upload, so
  // the outcome was not read), which is why the BaseApi reads above matter
  note('A5 Save button after the failed Save', { disabled: await saveButton(page).isDisabled(), title: await saveButton(page).getAttribute('title'), text: await saveButton(page).innerText() });
  await expect(saveButton(page)).toHaveAttribute('title', /Save outcome unknown/);
  // and after a reload: does the draft (browser storage) still hold the 31 unsaved items?
  await page.reload();
  await waitLoaded(page);
  const after = await saveButton(page).innerText();
  note('A5 after a reload the Save button says', after);
});

const clearOut = (page: Page) => out(page).getByRole('button', { name: 'Clear all' }).click();
