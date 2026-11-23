import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { regionCorner, type Pt } from './seed';
import { API, getJson, type Row } from './stack';

export const PROC_A = 'archive-expander';
export const PROC_B = 'sk-normalizer';

/** Plays an HTML5 drag from `source` onto the page point (x, y) with the app's own payload. */
export async function dragOnto(page: Page, source: Locator, x: number, y: number) {
  const handle = await source.elementHandle();
  await page.evaluate(({ el, x, y }) => {
    const dt = new DataTransfer();
    const fire = (target: Element, type: string) =>
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    fire(el as Element, 'dragstart');
    const over = document.elementFromPoint(x, y)!;
    fire(over, 'dragenter');
    fire(over, 'dragover');
    fire(over, 'drop');
    fire(el as Element, 'dragend');
  }, { el: handle, x, y });
}

// ---- Output --------------------------------------------------------------------------------------------------------

export const out = (page: Page) => page.locator('[data-panel="output"]');
/** An Output line with exactly this text (or matching this pattern). */
export const outLine = (page: Page, text: string | RegExp) =>
  out(page).locator('[role="listitem"] span').filter({ hasText: typeof text === 'string' ? new RegExp(`^${escapeRe(text)}$`) : text });
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const clearOutput = (page: Page) => out(page).getByRole('button', { name: 'Clear all' }).click();

// ---- Opening the board ---------------------------------------------------------------------------------------------

export const LOADED = /Board loaded: \d+ workflows?/;

/** The board after a load: every row in, the viewport laid out. */
export async function waitLoaded(page: Page) {
  await expect(outLine(page, LOADED).first()).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.waitForTimeout(250);
}

/**
 * Opens the board with the view on the throwaway region (see seed.ts): flow point `at` (from the region's corner) sits 70 px
 * from the board's top-left, at `zoom`. The view is set once per tab, so a reload keeps the one the app remembered.
 */
export async function openAt(page: Page, at: Pt = { x: 0, y: 0 }, zoom = 1) {
  const c = regionCorner();
  const view = { x: 70 - (c.x + at.x) * zoom, y: 70 - (c.y + at.y) * zoom, zoom, selection: null };
  await page.addInitScript((v) => {
    try {
      if (!sessionStorage.getItem('e2e.view')) { localStorage.setItem('acto.view', JSON.stringify(v)); sessionStorage.setItem('e2e.view', '1'); }
    } catch { /* no storage */ }
  }, view);
  await page.goto('/');
  await waitLoaded(page);
}

/** Opens the board the way a new visitor sees it: fitted to everything. */
export async function openFitted(page: Page) {
  await page.goto('/');
  await waitLoaded(page);
  await expect.poll(() => page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform))
    .not.toBe('translate(0px, 0px) scale(1)');
  await page.waitForTimeout(400);
}

export const zoomOf = (page: Page) => page.evaluate(() =>
  Number(/scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)?.[1] ?? 1));

// ---- Locators ------------------------------------------------------------------------------------------------------

export const wfNode = (page: Page, id: string) => page.locator(`.react-flow__node-workflow[data-id="wf:${id}"]`);
export const stNode = (page: Page, id: string) => page.locator(`.react-flow__node-step[data-id="st:${id}"]`);
export const caNode = (page: Page, id: string) => page.locator(`.react-flow__node-cache[data-id="ca:${id}"]`);
export const entryEdge = (page: Page, wf: string, step: string) => page.locator(`.react-flow__edge[data-id="entry:${wf}:${step}"]`);
export const cacheEdge = (page: Page, wf: string, cache: string) => page.locator(`.react-flow__edge[data-id="cache:${wf}:${cache}"]`);
export const wireEdge = (page: Page, from: string, to: string) => page.locator(`.react-flow__edge[data-id="wire:${from}:${to}"]`);
export const allWorkflows = (page: Page) => page.locator('.react-flow__node-workflow');
export const allSteps = (page: Page) => page.locator('.react-flow__node-step');
export const allCaches = (page: Page) => page.locator('.react-flow__node-cache');

export const toolbar = (page: Page, kind: 'workflow' | 'step' | 'wire' | 'cache' | 'entry' | 'cacheLink' | 'ghost') => page.getByRole('toolbar', { name: `${kind} actions` });
export const selbar = (page: Page) => page.getByRole('toolbar', { name: 'selection actions' });
export const inspector = (page: Page) => page.locator('[data-panel="inspector"]');
export const field = (page: Page, label: string | RegExp) =>
  inspector(page).locator('label.fld', { has: page.locator('span', { hasText: typeof label === 'string' ? new RegExp(`^${escapeRe(label)}$`) : label }) }).locator('input, textarea, select, button[role=combobox]');
const topRow = (page: Page) => inspector(page).getByRole('tablist', { name: 'Inspector tabs' });
const childRow = (page: Page, parent: 'Step' | 'Processor') => inspector(page).getByRole('tablist', { name: `${parent} tabs` });
/** A top Inspector tab by its label (Step, Processor, Workflow, Cache, Link, Deleted). */
export const tab = (page: Page, name: string) => topRow(page).getByRole('tab', { name: new RegExp(`^${escapeRe(name)}$`) });
/** The Inspector's top tab labels, in order. */
export const tabLabels = (page: Page) => topRow(page).getByRole('tab');
/**
 * A child tab by its label [user, 2026-11-18]: under Step a selected workflow's name (its assignment), under Processor a
 * schema (Input schema, Output schema, Config schema).
 */
export const childTab = (page: Page, parent: 'Step' | 'Processor', name: string) => childRow(page, parent).getByRole('tab', { name: new RegExp(`^${escapeRe(name)}$`) });
/** A parent's child tab labels, in order (none: the row is not drawn). */
export const childLabels = (page: Page, parent: 'Step' | 'Processor') => childRow(page, parent).getByRole('tab');
/** A ghost node (a deleted step, cache or triangle drawn at its last place) by its name. */
export const ghost = (page: Page, name: string) =>
  page.locator('.react-flow__node.ghost').filter({ has: page.locator('.sn, .cache-nm, .tri-nm', { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
/** Studio's prettyJson: what a JSON field shows once it is not being typed in. */
export const pretty = (json: string) => JSON.stringify(JSON.parse(json), null, 2);
/**
 * Opens the workflow-named tab of the picked step (its assignment) and answers its Payload field. With no assignment yet the
 * tab has no Payload, only ＋ Create (as Studio [user, 2026-11-19]): it is pressed first, so the field exists.
 */
export async function payloadOf(page: Page, workflow: string) {
  // the workflow's assignment is a child of Step: open Step first unless its row is already shown
  if (await childTab(page, 'Step', workflow).count() === 0) await tab(page, 'Step').click();
  await childTab(page, 'Step', workflow).click();
  const create = inspector(page).getByRole('button', { name: '＋ Create' });
  await expect(field(page, 'Payload').or(create)).toBeVisible();
  if (await create.count() > 0) await create.click();
  return field(page, 'Payload');
}
export const saveButton = (page: Page) => page.locator('button.save-board');
export const workflowTool = (page: Page) => page.getByRole('button', { name: /Workflow\s*drop on the board/ });
export const cacheTool = (page: Page) => page.getByRole('button', { name: /Cache\s*drop on the board/ });
export const toolboxStep = (page: Page, processor: string) =>
  page.getByTestId('toolbox-step').filter({ has: page.locator('.tx', { hasText: new RegExp(`^${escapeRe(processor)}`) }) }).first();

export async function centre(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// ---- Picking -------------------------------------------------------------------------------------------------------

/** Clicks a triangle on its name. */
export const pickWorkflow = (page: Page, id: string) => wfNode(page, id).locator('.tri-nm').click();
/**
 * Makes the triangle the whole selection: the board is cleared first, since a plain click on a triangle keeps the
 * selected steps and a click on a selected one takes it out [user, 2026-11-18].
 */
export async function selectWorkflowAlone(page: Page, id: string) {
  await clickEmptyBoard(page);
  await pickWorkflow(page, id);
  await expect(wfNode(page, id).locator('.tri.sel')).toHaveCount(1);
}
/** Clicks a step card on its name line, with Ctrl when `add`. */
export const pickStep = (page: Page, id: string, add = false) => stNode(page, id).locator('.sn').click(add ? { modifiers: ['Control'] } : {});
export const pickCache = (page: Page, id: string, add = false) => caNode(page, id).locator('.cache-nm').click(add ? { modifiers: ['Control'] } : {});
/**
 * Shows the step (or cache) in the Inspector: clicked only when it is not picked already, since a plain click on a picked
 * item unpicks it [user, 2026-11-18] (a reload restores the last selection, say).
 */
export async function showStep(page: Page, id: string) {
  if (await stNode(page, id).locator('.node.sel').count() === 0) await pickStep(page, id);
  await expect(stNode(page, id).locator('.node.sel')).toHaveCount(1);
}
export async function showCache(page: Page, id: string) {
  if (await caNode(page, id).locator('.cache-chip.sel').count() === 0) await pickCache(page, id);
  await expect(caNode(page, id).locator('.cache-chip.sel')).toHaveCount(1);
}

/** Clicks an edge on the middle of its curve (its wide hit path), with Ctrl when `add`. */
export async function pickEdge(page: Page, edge: Locator, add = false) {
  const p = await edge.locator('path.wire-hit, path.edge-hit').first().evaluate((el) => {
    const path = el as SVGPathElement;
    const pt = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  });
  if (add) await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  if (add) await page.keyboard.up('Control');
}

/** A click on empty board: a point whose topmost element is the pane. */
export async function clickEmptyBoard(page: Page) {
  const p = await page.evaluate(() => {
    const board = document.querySelector('.react-flow__pane')!.getBoundingClientRect();
    for (let y = board.bottom - 40; y > board.top + 40; y -= 20) for (let x = board.left + 300; x < board.right - 260; x += 20) {
      const el = document.elementFromPoint(x, y);
      if (el?.classList.contains('react-flow__pane')) return { x, y };
    }
    return null;
  });
  expect(p, 'an empty spot on the board').not.toBeNull();
  await page.mouse.click(p!.x, p!.y);
}

// ---- Real mouse gestures -------------------------------------------------------------------------------------------

/** A real mouse drag from a handle onto the middle of `to` (or a page point). The hover grows the handle: aim where it is drawn once hovered. */
export async function dragFromHandle(page: Page, handle: Locator, to: Locator | Pt) {
  // a connection is made on a handle (React Flow's connection radius is 20 px): aim at the target node's own target handle, else its middle
  const target = 'x' in to ? to : await (async () => {
    const t = to.locator('.react-flow__handle.target');
    return (await t.count()) > 0 ? centre(t.first()) : centre(to);
  })();
  const h0 = (await handle.boundingBox())!;
  await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
  await page.waitForTimeout(200);
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
}
/** Step wire: from `from`'s right handle onto `to`. */
export const drawWire = (page: Page, from: Locator, to: Locator) => dragFromHandle(page, from.locator('.react-flow__handle.source'), to);
/** Entry arrow: from the triangle's tip onto a step. */
export const drawEntry = (page: Page, wf: Locator, step: Locator) => dragFromHandle(page, wf.locator('.react-flow__handle[data-handleid="tip"]'), step);
/** Cache link: from the triangle's back onto a cache. */
export const drawCacheLink = (page: Page, wf: Locator, cache: Locator) => dragFromHandle(page, wf.locator('.react-flow__handle[data-handleid="back"]'), cache);

/** A real mouse drag of `what` by (dx, dy) screen px, grabbed at its (gx, gy) offset (default: its middle). */
export async function dragBy(page: Page, what: Locator, dx: number, dy: number, grab?: Pt, release = true) {
  const b = (await what.boundingBox())!;
  const x = b.x + (grab?.x ?? b.width / 2), y = b.y + (grab?.y ?? b.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  if (release) await page.mouse.up();
}

/** Where a node is on the board, as React Flow placed it (flow units). */
export async function flowPos(l: Locator) {
  return l.evaluate((n) => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec((n as HTMLElement).style.transform);
    return { x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0) };
  });
}

// ---- Toolbox drops -------------------------------------------------------------------------------------------------

/** Drops a toolbox item at the screen point; answers the id of the node that appeared (`wf:`, `st:` or `ca:`). */
export async function dropTool(page: Page, tool: Locator, kind: 'workflow' | 'step' | 'cache', at: Pt): Promise<string> {
  const sel = `.react-flow__node-${kind}`;
  const before = new Set(await page.locator(sel).evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.id)));
  await dragOnto(page, tool, at.x, at.y);
  await expect(page.locator(sel)).toHaveCount(before.size + 1);
  const now = await page.locator(sel).evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.id!));
  return now.find((i) => !before.has(i))!.replace(/^(wf|st|ca):/, '');
}

/** The screen point at (dx, dy) flow units from the region's corner as the view is now (zoom 1 views from openAt). */
export async function regionPoint(page: Page, rel: Pt): Promise<Pt> {
  const c = regionCorner();
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const t = await page.evaluate(() => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  });
  return { x: pane.x + t.x + (c.x + rel.x) * t.z, y: pane.y + t.y + (c.y + rel.y) * t.z };
}

/** Renames the picked row in the Inspector (the Name field) so it is an e2e- row; waits for the board to show it. */
export async function renameTo(page: Page, name: string) {
  await field(page, 'Name').fill(name);
}

/**
 * Presses Save and waits until the whole Save has finished: the dry run (POST /workflows/validate) and, when it passed, the push
 * (/model/apply), the read back and the diagrams [user, 2026-11-23]. A dry run that refuses pushes nothing: the answer then is
 * { applied: false, checked: <the dry run answer> }.
 */
export async function save(page: Page) {
  await expect(saveButton(page)).toBeEnabled();
  await clearOutput(page);
  const isPost = (r: import('@playwright/test').Response, path: string) => r.request().method() === 'POST' && new URL(r.url()).pathname === path;
  const checked = page.waitForResponse((r) => isPost(r, '/api/v1/workflows/validate'));
  const pushed = page.waitForResponse((r) => isPost(r, '/api/v1/model/apply'));
  pushed.catch(() => undefined); // never awaited when the dry run refuses
  await saveButton(page).click();
  const check = (await (await checked).json()) as { valid?: boolean };
  let answer: { applied?: boolean; made?: Record<string, string>; checked?: unknown } = { applied: false, checked: check };
  if (check.valid === true) answer = (await (await pushed).json()) as typeof answer;
  // the button says Saving… from the press until the dry run refused, or the push, read back and diagrams are done
  await expect(saveButton(page)).not.toHaveText('Saving…', { timeout: 60_000 });
  // what Output said, kept with the test result
  test.info().annotations.push({ type: 'save', description: (await out(page).locator('[role="listitem"] span').allInnerTexts()).join(' | ').slice(0, 1500) });
  return answer;
}

/** The Items table of a cache's Inspector (the key/value editor). */
export const itemKey = (page: Page, n: number) => inspector(page).getByRole('textbox', { name: `Key ${n}`, exact: true });
export const itemValue = (page: Page, n: number) => inspector(page).getByRole('textbox', { name: `Value ${n}`, exact: true });

/** Adds an item as row `n` (1-based) of the Items table: "+ Add item", its key, its value (each committed with Enter). */
export async function addItem(page: Page, n: number, key: string, value: string) {
  await inspector(page).getByRole('button', { name: '+ Add item' }).click();
  await itemKey(page, n).fill(key);
  await itemKey(page, n).press('Enter');
  await itemValue(page, n).fill(value);
  await itemValue(page, n).press('Enter');
}

// ---- Regression suite (e2e/regression): build through the UI, read BaseAPI back ------------------------------------

/** The processors the regression builds with, chosen so their schemas chain (envelope -> document -> envelope -> locator -> envelope). */
export const EXPANDER = 'archive-expander'; // in file-envelope, out archive-document; config { maxDepth?: integer >= 1 }
export const NORMALIZER = 'sk-normalizer'; // in archive-document, out archive-document; config { handler: Acme|AlphaBeta|Sample }
export const COLLAPSER = 'archive-collapser'; // in archive-document, out file-envelope; config {}
export const PERSISTER = 'file-persister'; // in file-envelope, out locator; config { folderPath }
export const FETCHER = 'file-fetcher'; // in locator, out file-envelope; config { minimumSizeBytes, maximumSizeBytes }
/** A payload each of those processors' config schema accepts. */
export const VALID_PAYLOAD: Record<string, string> = {
  [EXPANDER]: '{"maxDepth": 2}',
  [NORMALIZER]: '{"handler": "Acme"}',
  [COLLAPSER]: '{}',
  [PERSISTER]: '{"folderPath": "/tmp/e2e-regression"}',
  [FETCHER]: '{"minimumSizeBytes": 0, "maximumSizeBytes": 1024}',
};
/** The five entry conditions: picker option name, stored value, pill letter. */
export const CONDITION = {
  Completed: { value: 1, letter: 'C' }, Failed: { value: 2, letter: 'F' }, Cancelled: { value: 3, letter: 'X' },
  Always: { value: 4, letter: 'A' }, Never: { value: 5, letter: 'N' },
} as const;
export type ConditionName = keyof typeof CONDITION;

/** The Save button's count (0 when it says just Save). */
export async function unsavedCount(page: Page): Promise<number> {
  const t = await saveButton(page).innerText();
  return t === 'Save' ? 0 : Number(/·\s*(\d+)/.exec(t)?.[1] ?? NaN);
}

/** Drops a triangle from the toolbox at the region point and renames it in the Inspector; answers its (client) id. */
export async function newWorkflow(page: Page, at: Pt, name: string): Promise<string> {
  // nothing picked first: a dropped triangle is added to the picks as a click would add it, so a picked step would stay beside it
  await clickEmptyBoard(page);
  const id = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, at));
  await expect(tabLabels(page)).toHaveText(['Workflow']);
  await renameTo(page, name);
  await expect(wfNode(page, id).locator('.tri-nm')).toHaveText(name);
  return id;
}
/** Drops a step of `processor` at the region point and renames it; answers its (client) id. */
export async function newStep(page: Page, processor: string, at: Pt, name: string): Promise<string> {
  await clickEmptyBoard(page);
  const id = await dropTool(page, toolboxStep(page, processor), 'step', await regionPoint(page, at));
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(field(page, 'Name')).toHaveValue(processor);
  await renameTo(page, name);
  await expect(stNode(page, id).locator('.sn')).toHaveText(name);
  return id;
}
/** Drops a cache at the region point, renames it and gives it a Root (BaseAPI refuses a cache without one); answers its (client) id. */
export async function newCache(page: Page, at: Pt, name: string, root = name): Promise<string> {
  await clickEmptyBoard(page);
  const id = await dropTool(page, cacheTool(page), 'cache', await regionPoint(page, at));
  await expect(tabLabels(page)).toHaveText(['Cache']);
  await renameTo(page, name);
  await field(page, 'Root').fill(root);
  await expect(caNode(page, id).locator('.cache-nm')).toHaveText(name);
  return id;
}

/** A wire from step `from` to step `to`, checked on the board. */
export async function wire(page: Page, from: string, to: string) {
  await drawWire(page, stNode(page, from), stNode(page, to));
  await expect(wireEdge(page, from, to)).toHaveCount(1);
}
/** An entry arrow from the triangle to the step, checked on the board. */
export async function entry(page: Page, wf: string, step: string) {
  await drawEntry(page, wfNode(page, wf), stNode(page, step));
  await expect(entryEdge(page, wf, step)).toHaveCount(1);
}
/** A cache line from the triangle to the cache, checked on the board. */
export async function link(page: Page, wf: string, cache: string) {
  await drawCacheLink(page, wfNode(page, wf), caNode(page, cache));
  await expect(cacheEdge(page, wf, cache)).toHaveCount(1);
}

/** Picks the step alone and chooses its entry condition in Studio's picker, by mouse; the card's pill follows. */
export async function setCondition(page: Page, step: string, name: ConditionName) {
  await clickEmptyBoard(page);
  await pickStep(page, step);
  await field(page, /^Entry condition/).click();
  await inspector(page).getByRole('listbox', { name: 'Entry conditions' }).getByRole('option', { name: new RegExp(name) }).click();
  await expect(field(page, /^Entry condition/)).toHaveAttribute('data-value', String(CONDITION[name].value));
  await expect(stNode(page, step).locator('.cond-pill')).toHaveText(CONDITION[name].letter);
}

/** The triangle alone, then the step beside it: types the payload into that workflow's assignment tab under Step. */
export async function typePayload(page: Page, wf: string, wfName: string, step: string, json: string) {
  await selectWorkflowAlone(page, wf);
  await pickStep(page, step);
  await expect(stNode(page, step).locator('.node.sel')).toHaveCount(1);
  await (await payloadOf(page, wfName)).fill(json);
}

/** Every row of a table whose name starts with `prefix`, as BaseAPI has it now. */
export async function rowsNamed(table: 'workflows' | 'steps' | 'caches' | 'assignments', prefix: string): Promise<Row[]> {
  return (await getJson<Row[]>(`/${table}`)).filter((r) => r.name.startsWith(prefix));
}
/** One row by its exact name (fails when there is not exactly one). */
export async function rowNamed(table: 'workflows' | 'steps' | 'caches' | 'assignments', name: string): Promise<Row> {
  const rows = (await getJson<Row[]>(`/${table}`)).filter((r) => r.name === name);
  expect(rows, `exactly one ${table} row named ${name}`).toHaveLength(1);
  return rows[0]!;
}

export interface Problem { gate: string; title: string; detail: string }
/** BaseAPI's own dry run of the stored workflow (POST /workflows/{id}/validate: it always rolls back). */
export async function validateStored(id: string): Promise<{ valid: boolean; problems: Problem[] }> {
  const r = await fetch(`${API}/workflows/${id}/validate`, { method: 'POST' });
  if (!r.ok) throw new Error(`validate ${id} answered ${r.status}`);
  return (await r.json()) as { valid: boolean; problems: Problem[] };
}
/** The dry-run lines Output shows for the workflow after a Save (its Kibana line and a failed-validate line aside). */
export async function dryRunLines(page: Page, wfName: string): Promise<string[]> {
  const all = await out(page).locator('[role="listitem"] span').allInnerTexts();
  return all.filter((t) => t.startsWith(`${wfName}: `) && !/: Kibana diagram (published|not published)/.test(t) && !t.startsWith(`${wfName}: could not validate`));
}
/**
 * Acto's dry run of a workflow equals BaseAPI's: the Output lines for it are BaseAPI's problems (same count, same titles and details),
 * and the triangle's badge shows their count (no badge when there are none). Answers BaseAPI's problems.
 */
export async function expectDryRunMatches(page: Page, wf: string, wfName: string): Promise<Problem[]> {
  const truth = await validateStored(wf);
  const want = truth.problems.map((p) => `${wfName}: ${p.title ?? p.gate} — ${p.detail ?? ''}`).sort();
  test.info().annotations.push({ type: 'dry run', description: `${wfName}: ${want.length} problem(s)${want.length ? ` — ${truth.problems.map((p) => p.gate).join(', ')}` : ''}` });
  expect((await dryRunLines(page, wfName)).sort(), `${wfName}: Output's dry-run lines are BaseAPI's problems`).toEqual(want);
  const badge = wfNode(page, wf).locator('.tri-problems');
  if (want.length === 0) await expect(badge, `${wfName}: no problem badge`).toHaveCount(0);
  else await expect(badge, `${wfName}: the badge counts BaseAPI's problems`).toHaveText(String(want.length));
  return truth.problems;
}
/** Output says the workflow's Kibana diagram was published, once. */
export const expectPublished = (page: Page, wfName: string) => expect(outLine(page, `${wfName}: Kibana diagram published`)).toHaveCount(1);

/**
 * What the board shows, ghosts aside: each node (id, its name line, its place, unsaved mark, condition pill, key chips), each edge id
 * with its pill letter, and the Save label. Two equal snapshots are the same board.
 */
export async function boardSnapshot(page: Page) {
  const nodes = await page.locator('.react-flow__node:not(.ghost)').evaluateAll((ns) => ns.map((n) => {
    const e = n as HTMLElement;
    const name = e.querySelector('.sn, .cache-nm, .tri-nm')?.textContent ?? '';
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(e.style.transform);
    return [e.dataset.id, name, m ? `${Math.round(Number(m[1]))},${Math.round(Number(m[2]))}` : '', !!e.querySelector('.unsaved-mark'),
      e.querySelector('.cond-pill')?.textContent ?? '', [...e.querySelectorAll('.key-chip')].map((c) => c.textContent).join('|')].join(' ');
  }).sort());
  const edges = await page.locator('.react-flow__edge:not(.ghost)').evaluateAll((es) => es
    .filter((e) => !e.querySelector('.ghost'))
    .map((e) => `${(e as HTMLElement).dataset.id} ${e.querySelector('.pilltx')?.textContent ?? ''}`).sort());
  return { nodes, edges, save: await saveButton(page).innerText() };
}

/** The node's place on the board in flow units, rounded. */
export async function placeOf(l: Locator): Promise<Pt> {
  const p = await flowPos(l);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
/** A stored row's location equals the board's (to a unit). */
export function expectAt(row: Row, at: Pt, what = row.name) {
  expect(Math.abs((row.boardX as number) - at.x), `${what} boardX`).toBeLessThanOrEqual(1);
  expect(Math.abs((row.boardY as number) - at.y), `${what} boardY`).toBeLessThanOrEqual(1);
}
/** JSON text compared as data (BaseAPI and the editor may lay it out differently). */
export const sameJson = (a: unknown, b: string) => expect(JSON.parse(String(a))).toEqual(JSON.parse(b));
