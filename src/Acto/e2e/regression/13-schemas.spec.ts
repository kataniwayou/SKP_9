import type { Locator, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  clickEmptyBoard, dragBy, field, flowPos, holdOver, inspector, openAt, pickStep, save, saveButton, selbar, stNode, tab, waitLoaded,
} from '../helpers';
import { seed, type Seeded } from '../seed';
import { getJson, type Row } from '../stack';

// Regression 13 (user, 2026-11-26): the Schemas mode. One toggle shows schema cards, the processors no step uses and the
// reference wires between them; orphans alone can be deleted (a ghost until Save); schema and processor cards drag, nudge and
// settle like steps; the Inspector shows them read-only; and a move of a real card saves its location and nothing else.
// Plan: docs/superpowers/plans/2026-11-26-acto-schemas-mode-regression.md (Task B).

/**
 * The seed, made again for every test (the fixture deletes every e2e- row after each one): e2e-proc-a (Input e2e-in, Config
 * e2e-cfg) runs e2e-s1 → e2e-s2 in e2e-wf; e2e-proc-b (Config e2e-held) has no step; three orphans. Region units (seed.ts).
 */
/** BaseAPI takes a source hash only as 64 lowercase hex characters. */
const HASH_A = 'e2e0'.padEnd(64, 'a');
const HASH_B = 'e2e0'.padEnd(64, 'b');
const SEED = {
  schemas: [
    { key: 'IN', name: 'e2e-in', definition: '{"type":"object"}', at: { x: 180, y: 200 } },
    { key: 'CFG', name: 'e2e-cfg', definition: '{"type":"object"}', at: { x: 480, y: 200 } },
    { key: 'HELD', name: 'e2e-held', at: { x: 180, y: 480 } },
    { key: 'O1', name: 'e2e-orph-1', at: { x: 460, y: 340 } },
    { key: 'O2', name: 'e2e-orph-2', at: { x: 700, y: 340 } },
    { key: 'O3', name: 'e2e-orph-3', at: { x: 780, y: 40 } },
  ],
  processors: [
    { key: 'PA', name: 'e2e-proc-a', sourceHash: HASH_A, input: 'IN', config: 'CFG' },
    { key: 'PB', name: 'e2e-proc-b', sourceHash: HASH_B, config: 'HELD', at: { x: 180, y: 340 } },
  ],
  steps: [
    { key: 'S1', name: 'e2e-s1', at: { x: 180, y: 40 }, processor: 'PA', next: ['S2'] },
    { key: 'S2', name: 'e2e-s2', at: { x: 480, y: 40 }, processor: 'PA' },
  ],
  workflows: [{ key: 'W', name: 'e2e-wf', at: { x: 0, y: 60 }, entry: ['S1'] }],
} as const;
const GAP = 16;

const toggle = (page: Page) => page.locator('button.schemas-toggle');
const orphanBadge = (page: Page) => toggle(page).locator('.schemas-n');
const scNode = (page: Page, id: string) => page.locator(`.react-flow__node-schema[data-id="sc:${id}"]`);
const prNode = (page: Page, id: string) => page.locator(`.react-flow__node-processor[data-id="pr:${id}"]`);
const scGhost = (page: Page, id: string) => page.locator(`.react-flow__node.ghost[data-id="ghost:schema:${id}"]`);
const allSchemaCards = (page: Page) => page.locator('.react-flow__node-schema');
const refEdges = (page: Page) => page.locator('.react-flow__edge-schemaRef');
/** The reference wires leaving an owner (`step` or `processor`), optionally only those into one schema. */
const refsFrom = (page: Page, kind: 'step' | 'processor', owner: string, schema?: string) =>
  page.locator(`.react-flow__edge-schemaRef[data-id^="sr:${kind}:${owner}:"]${schema ? `[data-id$=":${schema}"]` : ''}`);
const refsInto = (page: Page, schema: string) => page.locator(`.react-flow__edge-schemaRef[data-id$=":${schema}"]`);
const schemaToolbar = (page: Page) => page.getByRole('toolbar', { name: 'schema actions' });
const ghostToolbar = (page: Page) => page.getByRole('toolbar', { name: 'ghost actions' });
const pane = (page: Page) => page.locator('.react-flow__pane');
const box = async (l: Locator) => (await l.boundingBox())!;
const kindLine = (page: Page) => inspector(page).locator('.kind');
const undoBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true });
const redoBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Redo', exact: true });

/** Clicks a schema card on its name (Ctrl when `add`). */
const pickSchema = (page: Page, id: string, add = false) => scNode(page, id).locator('.card-nm').click(add ? { modifiers: ['Control'] } : {});
const pickProcessor = (page: Page, id: string, add = false) => prNode(page, id).locator('.card-nm').click(add ? { modifiers: ['Control'] } : {});

async function modeOn(page: Page) {
  if ((await toggle(page).getAttribute('aria-pressed')) !== 'true') await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
}
async function modeOff(page: Page) {
  if ((await toggle(page).getAttribute('aria-pressed')) === 'true') await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
}
/** Ctrl+Z / Ctrl+Y with the focus on the board, not in an Inspector field. */
async function key(page: Page, k: 'Control+z' | 'Control+y') {
  await pane(page).click({ position: { x: 20, y: 20 } });
  await page.keyboard.press(k);
}
/**
 * Turning the mode on places every card that has no stored place (the stack's real schemas, the first time ever): a layout
 * change that goes out with the next Save. Saved here (location only, which the guard allows), so a test starts with nothing unsaved.
 */
async function flushPlacements(page: Page) {
  if (await saveButton(page).isEnabled()) {
    const answer = await save(page);
    expect(answer.applied, 'the placements saved').toBe(true);
  }
  await expect(saveButton(page)).toHaveText('Save');
}
async function openSeeded(page: Page): Promise<Seeded> {
  const id = await seed(SEED);
  await openAt(page);
  return id;
}
/** The clear space between two boxes along the axis that separates them (negative when they overlap). */
async function spacing(a: Locator, b: Locator) {
  const p = await box(a), q = await box(b);
  const h = Math.max(q.x - (p.x + p.width), p.x - (q.x + q.width));
  const v = Math.max(q.y - (p.y + p.height), p.y - (q.y + q.height));
  return Math.max(h, v);
}
/** A right-button box from one screen point to another. */
async function rightBox(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up({ button: 'right' });
}
const changesOf = (req: Request) => ((req.postDataJSON() ?? {}) as { changes?: { op: string; table: string; id: string; row?: Record<string, unknown> }[] }).changes ?? [];
/** Fields of a change's row that differ from the stored row (location aside). */
function beyondLocation(stored: Row, row: Record<string, unknown>): string[] {
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v);
  return Object.keys(row).filter((k) => k !== 'boardX' && k !== 'boardY' && k !== 'definition' && JSON.stringify(norm(stored[k])) !== JSON.stringify(norm(row[k])))
    .concat(row.definition !== undefined && JSON.stringify(JSON.parse(String(row.definition))) !== JSON.stringify(JSON.parse(String(stored.definition))) ? ['definition'] : []);
}

test('1 · the toggle: off by default, a red orphan count, remembered across a reload, left of Board only', async ({ page }) => {
  const id = await openSeeded(page);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(allSchemaCards(page)).toHaveCount(0);
  await expect(page.locator('.react-flow__node-processor')).toHaveCount(0);
  await expect(orphanBadge(page)).toBeVisible();
  expect(Number(await orphanBadge(page).innerText()), 'the orphan count').toBeGreaterThanOrEqual(3);
  expect(await orphanBadge(page).evaluate((e) => getComputedStyle(e).backgroundColor), 'the count is red (--danger)').toMatch(/^rgb\((1\d\d|2\d\d), \d{1,2}, \d{1,2}\)$/);

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page)).toHaveClass(/\bon\b/);
  await expect(scNode(page, id.IN!)).toBeVisible();
  await expect(prNode(page, id.PB!)).toBeVisible();
  await expect(refEdges(page).first()).toBeAttached();
  expect(await page.evaluate(() => localStorage.getItem('acto.schemas'))).toBe('1');

  await page.reload();
  await waitLoaded(page);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(scNode(page, id.O1!)).toBeVisible();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(allSchemaCards(page)).toHaveCount(0);
  await expect(page.locator('.react-flow__node-processor')).toHaveCount(0);
  await expect(refEdges(page)).toHaveCount(0);
  await expect(orphanBadge(page), 'the count shows with the mode off too').toBeVisible();

  // Schemas sits right before Board only, the two buttons at the board's top right
  const btns = page.locator('.board-btns > button');
  await expect(btns).toHaveCount(2);
  await expect(btns.nth(0)).toHaveClass(/\bschemas-toggle\b/);
  await expect(btns.nth(1)).toHaveClass(/\bboard-only\b/);
});

test('2 · cards and wires: wired, held, orphan; I and C pills; hover thickens; a wire is never picked', async ({ page }) => {
  const id = await openSeeded(page);
  await modeOn(page);
  for (const s of [id.IN!, id.CFG!]) await expect(scNode(page, s).locator('.schema-tag'), 'a wired schema has no tag').toHaveCount(0);

  // one wire per step and slot: e2e-s1 and e2e-s2 each to e2e-in (I) and to e2e-cfg (C)
  for (const step of [id.S1!, id.S2!]) {
    await expect(refsFrom(page, 'step', step)).toHaveCount(2);
    await expect(refsFrom(page, 'step', step, id.IN!).locator('text.schema-ref-slot')).toHaveText('I');
    await expect(refsFrom(page, 'step', step, id.CFG!).locator('text.schema-ref-slot')).toHaveText('C');
  }
  await expect(refsInto(page, id.IN!)).toHaveCount(2);
  await expect(refsInto(page, id.CFG!)).toHaveCount(2);

  // held: tagged, one C wire from e2e-proc-b's card, which reads PROCESSOR · no step
  await expect(scNode(page, id.HELD!).locator('.schema-tag')).toHaveText('held');
  await expect(refsInto(page, id.HELD!)).toHaveCount(1);
  await expect(refsFrom(page, 'processor', id.PB!, id.HELD!).locator('text.schema-ref-slot')).toHaveText('C');
  await expect(prNode(page, id.PB!).locator('.card-k')).toHaveText(/^PROCESSOR\s*no step$/);
  await expect(prNode(page, id.PB!).locator('.card-nm')).toHaveText('e2e-proc-b');
  await expect(page.locator(`.react-flow__node-processor[data-id="pr:${id.PA}"]`), 'a processor a step uses has no card').toHaveCount(0);

  for (const o of [id.O1!, id.O2!, id.O3!]) {
    await expect(scNode(page, o).locator('.schema-tag')).toHaveText('orphan');
    await expect(scNode(page, o).locator('.schema-tag')).toHaveClass(/\borphan\b/);
    await expect(refsInto(page, o)).toHaveCount(0);
  }

  // hovering e2e-in thickens its two wires only
  const width = (l: Locator) => l.locator('path.schema-ref-line').evaluateAll((ps) => ps.map((p) => p.getAttribute('stroke-width')));
  await scNode(page, id.IN!).hover();
  await expect.poll(() => width(refsInto(page, id.IN!))).toEqual(['2.6', '2.6']);
  expect(await width(refsInto(page, id.CFG!))).toEqual(['1.8', '1.8']);
  expect(await width(refsInto(page, id.HELD!))).toEqual(['1.8']);
  await page.mouse.move(5, 5);
  await expect.poll(() => width(refsInto(page, id.IN!))).toEqual(['1.8', '1.8']);

  // a click on a wire's pill picks nothing (and an already picked card is let go, as a click on empty board does)
  await pickSchema(page, id.O1!);
  await expect(scNode(page, id.O1!).locator('.schema-card.sel')).toHaveCount(1);
  const pill = await centreOf(refsFrom(page, 'processor', id.PB!, id.HELD!).locator('circle.schema-ref-pill'));
  await page.mouse.click(pill.x, pill.y);
  await expect(page.locator('.schema-card.sel, .proc-card.sel, .node.sel, .react-flow__edge.selected')).toHaveCount(0);
  await expect(selbar(page)).toHaveCount(0);
  await expect(inspector(page).getByRole('tablist', { name: 'Inspector tabs' })).toHaveCount(0);
});
async function centreOf(l: Locator) {
  const b = await box(l);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test('3 · the look, light and dark', async ({ page }) => {
  const id = await openSeeded(page);
  await modeOn(page);
  await clickEmptyBoard(page);
  await page.mouse.move(5, 5);
  const style = (l: Locator, props: string[]) => l.evaluate((e, ps) => {
    const cs = getComputedStyle(e);
    return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p)]));
  }, props);
  const card = scNode(page, id.O1!).locator('.schema-card');
  const proc = prNode(page, id.PB!).locator('.proc-card');
  const line = refsInto(page, id.IN!).first().locator('path.schema-ref-line');

  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  expect(await style(card, ['background-color', 'border-top-color', 'border-top-left-radius'])).toEqual({
    'background-color': 'rgb(230, 238, 251)', 'border-top-color': 'rgb(0, 89, 220)', 'border-top-left-radius': '3px',
  });
  expect((await style(proc, ['background-color']))['background-color']).toBe('rgb(30, 30, 30)');
  expect((await style(line, ['stroke']))['stroke']).toBe('rgb(0, 89, 220)');
  expect(await line.getAttribute('stroke-dasharray')).toBe('1 4');
  await page.screenshot({ path: 'test-results/13-schemas-light.png' });

  await page.locator('button.theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await style(card, ['border-top-color']))['border-top-color']).toBe('rgb(61, 124, 240)');
  expect((await style(line, ['stroke']))['stroke']).toBe('rgb(122, 167, 255)');
  expect((await style(proc, ['background-color']))['background-color']).toBe('rgb(43, 43, 43)');
  await page.screenshot({ path: 'test-results/13-schemas-dark.png' });
});

test('4 · toolbar and bar: Delete on orphans only; any other mix has no action in common; the Delete key does nothing', async ({ page }) => {
  const id = await openSeeded(page);
  await modeOn(page);

  await pickSchema(page, id.O1!);
  await expect(schemaToolbar(page).getByRole('button')).toHaveText(['Delete']);
  for (const [what, pickIt] of [
    ['wired', () => pickSchema(page, id.IN!)], ['held', () => pickSchema(page, id.HELD!)], ['processor', () => pickProcessor(page, id.PB!)],
  ] as const) {
    await clickEmptyBoard(page);
    await pickIt();
    await expect(page.locator('.schema-card.sel, .proc-card.sel'), `${what} picked`).toHaveCount(1);
    await expect(page.getByRole('toolbar', { name: /actions$/ }).filter({ hasNot: page.locator('.selbar-pill') }), `${what}: no toolbar`).toHaveCount(0);
  }

  // two orphans: their bar has Delete alone
  await clickEmptyBoard(page);
  await pickSchema(page, id.O1!);
  await pickSchema(page, id.O2!, true);
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('2 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['Delete']);
  // orphan + wired, orphan + step: nothing in common
  for (const [what, addIt] of [['wired', () => pickSchema(page, id.IN!, true)], ['step', () => pickStep(page, id.S1!, true)]] as const) {
    await clickEmptyBoard(page);
    await pickSchema(page, id.O1!);
    await addIt();
    await expect(selbar(page).locator('.selbar-pill'), `orphan + ${what}`).toHaveText('2 SELECTED');
    await expect(selbar(page).locator('.selbar-text'), `orphan + ${what}`).toHaveText('no action in common');
    await expect(selbar(page).getByRole('button'), `orphan + ${what}`).toHaveCount(0);
  }

  // a right-click box over two orphans and the processor card picks the three; they share nothing
  await clickEmptyBoard(page);
  const p = await box(prNode(page, id.PB!)), o2 = await box(scNode(page, id.O2!));
  await rightBox(page, { x: p.x - 10, y: p.y - 8 }, { x: o2.x + o2.width + 10, y: p.y + p.height + 8 });
  await expect(page.locator('.schema-card.sel, .proc-card.sel')).toHaveCount(3);
  for (const l of [scNode(page, id.O1!).locator('.schema-card'), scNode(page, id.O2!).locator('.schema-card'), prNode(page, id.PB!).locator('.proc-card')]) {
    await expect(l).toHaveClass(/\bsel\b/);
  }
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('3 SELECTED');
  await expect(selbar(page).locator('.selbar-text')).toHaveText('no action in common');

  // the Delete key deletes nothing, even on a lone picked orphan
  await clickEmptyBoard(page);
  await pickSchema(page, id.O1!);
  const label = await saveButton(page).innerText();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await expect(scNode(page, id.O1!)).toHaveCount(1);
  await expect(scGhost(page, id.O1!)).toHaveCount(0);
  await expect(saveButton(page), 'nothing new to save').toHaveText(label);
});

test('5 · delete an orphan: a ghost that drags and restores; undone it leaves nothing; saved it is gone', async ({ page }) => {
  const id = await openSeeded(page);
  await modeOn(page);
  await flushPlacements(page);
  const n0 = Number(await orphanBadge(page).innerText());
  const del = async () => {
    await clickEmptyBoard(page);
    await pickSchema(page, id.O1!);
    await schemaToolbar(page).getByRole('button', { name: 'Delete' }).click();
  };

  // a delete taken back by Ctrl+Z: no ghost, nothing to save
  await del();
  await expect(scGhost(page, id.O1!)).toHaveCount(1);
  await key(page, 'Control+z');
  await expect(scGhost(page, id.O1!)).toHaveCount(0);
  await expect(scNode(page, id.O1!)).toHaveCount(1);
  await expect(saveButton(page), 'nothing to save').toHaveText('Save');
  await expect(saveButton(page)).toBeDisabled();
  await expect(orphanBadge(page)).toHaveText(String(n0));

  // a delete: a ghost, one orphan fewer, Restore · Remove
  await del();
  const G = scGhost(page, id.O1!);
  await expect(G).toHaveCount(1);
  await expect(scNode(page, id.O1!)).toHaveCount(0);
  await expect(orphanBadge(page)).toHaveText(String(n0 - 1));
  await expect(G.locator('.schema-card.ghost')).toHaveCount(1);
  await G.locator('.card-nm').click();
  await expect(ghostToolbar(page).getByRole('button')).toHaveText(['Restore', 'Remove']);

  // the ghost drags 120 px; Restore puts the card back where the ghost was put
  await clickEmptyBoard(page);
  const g0 = await box(G);
  await dragBy(page, G, 0, 120);
  await expect.poll(async () => (await box(G)).y).toBeGreaterThan(g0.y + 100);
  const moved = await box(G);
  await G.locator('.card-nm').click();
  await ghostToolbar(page).getByRole('button', { name: 'Restore' }).click();
  await expect(scNode(page, id.O1!)).toHaveCount(1);
  await expect(G).toHaveCount(0);
  const back = await box(scNode(page, id.O1!));
  expect(Math.abs(back.x - moved.x), 'restored where the ghost was put (x)').toBeLessThanOrEqual(1);
  expect(Math.abs(back.y - moved.y), 'restored where the ghost was put (y)').toBeLessThanOrEqual(1);
  await expect(orphanBadge(page)).toHaveText(String(n0));

  // deleted again and saved: /model/apply deletes the schema row
  await del();
  await expect(G).toHaveCount(1);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/model/apply');
  expect((await save(page)).applied).toBe(true);
  const changes = changesOf(await sent);
  expect(changes.filter((c) => c.table === 'schemas' && c.id === id.O1).map((c) => ({ op: c.op, table: c.table }))).toEqual([{ op: 'delete', table: 'schemas' }]);
  expect((await getJson<Row[]>('/schemas')).some((s) => s.id === id.O1), 'the row is gone from BaseAPI').toBe(false);

  // after a reload: the card is gone for good, the board has nothing unsaved, and the ghost is still there (a ghost outlives a
  // Save and a reload, as for steps: ghosts.spec "a ghost outlives a Save"; Restore would make the schema anew)
  await page.reload();
  await waitLoaded(page);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(scNode(page, id.O2!)).toBeVisible();
  await expect(scNode(page, id.O1!)).toHaveCount(0);
  await expect(saveButton(page)).toHaveText('Save');
  await expect(G).toHaveCount(1);
  await expect(orphanBadge(page)).toHaveText(String(n0 - 1));
});

test('6 · drag, nudge and settle: a drop slides clear, a nudge stops, turning on pushes a covered card aside', async ({ page }) => {
  const id = await openSeeded(page);
  await modeOn(page);
  await flushPlacements(page);
  const [S1, S2, O2, O3] = [stNode(page, id.S1!), stNode(page, id.S2!), scNode(page, id.O2!), scNode(page, id.O3!)];

  // dropped onto e2e-s1: slides off, a full gap clear
  await holdOver(page, O2, S1);
  await page.mouse.up();
  await expect.poll(async () => spacing(O2, S1)).toBeGreaterThanOrEqual(GAP - 1);

  // nudged left toward e2e-s2: it stops short, and one more nudge is refused
  await clickEmptyBoard(page);
  await pickSchema(page, id.O3!);
  const x0 = (await flowPos(O3)).x;
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await flowPos(O3)).x).toBeLessThan(x0 - 40);
  const stopped = await flowPos(O3);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  expect(await flowPos(O3), 'the last nudge is refused').toEqual(stopped);
  const short = (await box(O3)).x - ((await box(S2)).x + (await box(S2)).width);
  expect(short, 'stopped right by e2e-s2').toBeGreaterThanOrEqual(0);
  expect(short, 'stopped right by e2e-s2').toBeLessThan(8);

  // mode off: e2e-s2 dragged onto e2e-orph-3's stored place (hidden, so no obstacle)
  await clickEmptyBoard(page);
  await modeOff(page);
  const s2Before = await flowPos(S2);
  const o3Stored = stopped;
  await dragBy(page, S2, o3Stored.x - s2Before.x, 0, { x: 105, y: 14 });
  await expect.poll(async () => (await flowPos(S2)).x).toBeGreaterThan(s2Before.x + 150);
  const s2Dropped = await flowPos(S2);
  // it lies over e2e-orph-3's stored place (flow units: a step is 210 × 92, a schema 190 × 52)
  expect(s2Dropped.x < o3Stored.x + 190 && o3Stored.x < s2Dropped.x + 210 && s2Dropped.y < o3Stored.y + 52 && o3Stored.y < s2Dropped.y + 92,
    'e2e-s2 covers the stored place of e2e-orph-3').toBe(true);

  // mode on: e2e-orph-3 was pushed aside, e2e-s2 stayed
  await modeOn(page);
  await expect.poll(async () => spacing(O3, S2)).toBeGreaterThanOrEqual(GAP - 1);
  expect(await flowPos(S2)).toEqual(s2Dropped);
  const settled = await flowPos(O3);
  expect(settled).not.toEqual(o3Stored);

  // Ctrl+Z takes e2e-s2 back; e2e-orph-3 keeps its settled place (the settle is no undo step)
  await key(page, 'Control+z');
  await expect.poll(async () => Math.round((await flowPos(S2)).x)).toBe(Math.round(s2Before.x));
  expect(await flowPos(O3), 'e2e-orph-3 stays where it was settled').toEqual(settled);

  // Save: schema locations only; no step, workflow or processor row, and no field but boardX/boardY changes
  const stored = new Map((await getJson<Row[]>('/schemas')).map((r) => [r.id, r]));
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/model/apply');
  expect((await save(page)).applied).toBe(true);
  const changes = changesOf(await sent);
  expect(changes.map((c) => c.table).filter((t) => t !== 'schemas'), 'only schema rows').toEqual([]);
  const o3 = changes.find((c) => c.id === id.O3);
  expect(o3, 'e2e-orph-3 is in the Save').toBeDefined();
  expect(o3!.op).toBe('update');
  for (const c of changes) expect(beyondLocation(stored.get(c.id)!, c.row ?? {}), `${stored.get(c.id)?.name}: location only`).toEqual([]);
  const row = await getJson<Row>(`/schemas/${id.O3}`);
  expect(Math.abs((row.boardX as number) - settled.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((row.boardY as number) - settled.y)).toBeLessThanOrEqual(1);
});

test('7 · the Inspector: read-only schema and processor forms, Used by and Held by chips, Undo and Redo locked', async ({ page }) => {
  const id = await openSeeded(page);
  await modeOn(page);
  // a board move, so Undo has something to undo
  await dragBy(page, scNode(page, id.O2!), 0, 40);
  await clickEmptyBoard(page);
  await pickSchema(page, id.O1!);
  await expect(tab(page, 'Schema')).toHaveAttribute('aria-selected', 'true');
  await expect(kindLine(page)).toHaveText('schema · orphan');
  await expect(inspector(page).getByText('Orphan: no processor references this schema.', { exact: true })).toBeVisible();
  const editable = inspector(page).locator('[role="tabpanel"] input:not([disabled]), [role="tabpanel"] textarea:not([disabled]), [role="tabpanel"] select:not([disabled])');
  await expect(inspector(page).locator('[role="tabpanel"] input, [role="tabpanel"] textarea').first()).toBeVisible();
  await expect(editable).toHaveCount(0);
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();

  // wired e2e-in: I of e2e-proc-a, used by e2e-s1 and e2e-s2; a chip picks the step, whose Undo is live again
  await clickEmptyBoard(page);
  await pickSchema(page, id.IN!);
  await expect(kindLine(page)).toHaveText('schema · I of e2e-proc-a');
  const usedBy = inspector(page).locator('[aria-label="Used by"] .chip-nm');
  expect((await usedBy.allInnerTexts()).sort()).toEqual(['e2e-s1', 'e2e-s2']);
  await expect(undoBtn(page)).toBeDisabled();
  await inspector(page).getByRole('button', { name: 'Open step e2e-s1' }).click();
  await expect(stNode(page, id.S1!).locator('.node.sel')).toHaveCount(1);
  await expect(page.locator('.schema-card.sel')).toHaveCount(0);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(undoBtn(page)).toBeEnabled();

  // held: held by e2e-proc-b; its chip picks the processor card
  await clickEmptyBoard(page);
  await pickSchema(page, id.HELD!);
  await expect(inspector(page).getByText('Held by e2e-proc-b 1.0.0, a processor no step uses.', { exact: true })).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Open processor e2e-proc-b' }).click();
  await expect(prNode(page, id.PB!).locator('.proc-card.sel')).toHaveCount(1);

  // the processor card: no step, fields disabled, its Config schema child tab read-only
  await expect(tab(page, 'Processor')).toHaveAttribute('aria-selected', 'true');
  await expect(kindLine(page)).toHaveText('processor · no step');
  await expect(field(page, 'Source hash')).toBeDisabled();
  await expect(field(page, 'Source hash')).toHaveValue(HASH_B);
  await expect(field(page, 'Instance id')).toBeDisabled();
  await expect(editable).toHaveCount(0);
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();
  await inspector(page).getByRole('tablist', { name: 'Processor tabs' }).getByRole('tab', { name: 'Config schema' }).click();
  await expect(inspector(page).locator('#ins-subpanel textarea, #ins-subpanel input').first()).toBeVisible();
  await expect(inspector(page).locator('#ins-subpanel input:not([disabled]), #ins-subpanel textarea:not([disabled]), #ins-subpanel select:not([disabled])')).toHaveCount(0);
  await expect(inspector(page).locator('#ins-subpanel').getByRole('button', { name: /Save|Copy|Apply/ })).toHaveCount(0);
});

test('8 · moves save: a real wired schema and a real stepless processor, location only, no dry run', async ({ page, stack }) => {
  await seed(SEED);
  // the real rows: a wired schema (a processor some step uses references it) and a processor no step uses that holds a schema
  const steps = stack.snapshot.steps, procs = stack.snapshot.processors, schemas = stack.snapshot.schemas;
  const used = new Set(steps.map((s) => s.processorId as string));
  const slots = (p: Row) => [p.inputSchemaId, p.outputSchemaId, p.configSchemaId].filter((v): v is string => typeof v === 'string' && schemas.some((s) => s.id === v));
  const wired = schemas.find((s) => procs.some((p) => used.has(p.id) && slots(p).includes(s.id)));
  expect(wired, 'the stack has a real wired schema').toBeDefined();
  const stepless = procs.find((p) => !used.has(p.id) && slots(p).length > 0);
  if (!stepless) test.info().annotations.push({ type: 'skipped half', description: 'no real processor without a step holds a schema: the processor half is skipped' });

  // the view on the real cards: open, turn the mode on (placing what has no place yet), save those placements, then look there
  await openAt(page);
  await modeOn(page);
  await flushPlacements(page);
  const cards = [scNode(page, wired!.id), ...(stepless ? [prNode(page, stepless.id)] : [])];
  for (const c of cards) await expect(c).toBeAttached();

  for (const card of cards) {
    const at = await flowPos(card);
    await page.evaluate((v) => localStorage.setItem('acto.view', JSON.stringify(v)), { x: 400 - at.x, y: 200 - at.y, zoom: 1, selection: null });
    await page.reload();
    await waitLoaded(page);
    await expect(card).toBeVisible();
    // a drop that lands on another card slides to the nearest free place, which may be where it came from (an earlier run left
    // these cards moved): tried down, up, right and left until the card ends up somewhere else (the place is read back)
    const far = async () => { const p = await flowPos(card); return Math.hypot(p.x - at.x, p.y - at.y); };
    for (const [dx, dy] of [[0, 90], [0, -90], [140, 0], [-140, 0]] as const) {
      await dragBy(page, card, dx, dy, { x: 40, y: 12 });
      await page.waitForTimeout(400); // longer than a slide (280 ms)
      if (await far() > 20) break;
    }
    expect(await far(), 'the card moved').toBeGreaterThan(20);
  }
  const placed = await Promise.all(cards.map((c) => flowPos(c)));

  const requests: string[] = [];
  const onReq = (r: Request) => { if (r.method() !== 'GET') requests.push(`${r.method()} ${new URL(r.url()).pathname}`); };
  page.on('request', onReq);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/model/apply');
  expect((await save(page)).applied, 'the guard passed the moves as location-only and BaseAPI applied them').toBe(true);
  const changes = changesOf(await sent);
  page.off('request', onReq);
  expect(requests.filter((r) => /^POST \/api\/v1\/workflows\/[^/]+\/validate$/.test(r)), 'no dry run for a move').toEqual([]);
  expect(requests.filter((r) => /\/diagram$/.test(r)), 'no workflow was touched, so no diagram published').toEqual([]);
  expect(changes.map((c) => `${c.op} ${c.table}`).sort()).toEqual([...(stepless ? ['update processors'] : []), 'update schemas'].sort());
  test.info().annotations.push({ type: 'moved', description: `schema ${wired!.name} ${wired!.version}${stepless ? `, processor ${stepless.name} ${stepless.version}` : ''}` });

  const sRow = await getJson<Row>(`/schemas/${wired!.id}`);
  expect(Math.abs((sRow.boardX as number) - placed[0]!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((sRow.boardY as number) - placed[0]!.y)).toBeLessThanOrEqual(1);
  expect(sRow.definition === wired!.definition || JSON.stringify(JSON.parse(String(sRow.definition))) === JSON.stringify(JSON.parse(String(wired!.definition))), 'the definition is unchanged').toBe(true);
  if (stepless) {
    const pRow = await getJson<Row>(`/processors/${stepless.id}`);
    expect(Math.abs((pRow.boardX as number) - placed[1]!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs((pRow.boardY as number) - placed[1]!.y)).toBeLessThanOrEqual(1);
    for (const k of ['name', 'version', 'sourceHash', 'instanceId', 'inputSchemaId', 'outputSchemaId', 'configSchemaId', 'description']) {
      expect(pRow[k], `processor ${k} unchanged`).toEqual(stepless[k]);
    }
  }
});
