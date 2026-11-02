import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { box, documentPanel, emptySpot, inspector, labelsOf, node, openWorkflow, type Pt } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// What the Studio fills in for the user (2026-11-02), with the real mouse and keyboard: a new assignment's payload checked
// against its processor's config schema while typed, a Toolbox step named after its first processor, the Cron field's
// presets, an empty slot's schema template. Nothing is saved: the design is left unsaved on this run's throwaway
// (`e2e-8-…`), which is deleted afterwards with the fetcher-like processor and config schema made here.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
let fetcher: { id: string; name: string };
test.beforeAll(async ({ request }) => {
  t = await createThrowaway(request);
  // as file-fetcher-config is: two required integers and an optional list; named after the tag, so cleanup finds the schema
  const schema = await request.post('/api/v1/schemas', { data: {
    name: `${t.tag}-fetcher-config`, version: '1.0.0', description: null, definition: JSON.stringify({
      type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema', required: ['minimumSizeBytes', 'maximumSizeBytes'],
      properties: {
        maximumSizeBytes: { type: 'integer', minimum: 1 }, minimumSizeBytes: { type: 'integer', minimum: 0 },
        allowedExtensions: { type: ['array', 'null'], items: { type: 'string', minLength: 1 } },
      },
      additionalProperties: false,
    }),
  } });
  expect(schema.status()).toBe(201);
  const name = `${t.tag}-fetcher`;
  const proc = await request.post('/api/v1/processors', { data: {
    name, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: ((await schema.json()) as { id: string }).id,
  } });
  expect(proc.status()).toBe(201);
  fetcher = { id: ((await proc.json()) as { id: string }).id, name };
});
test.afterAll(async ({ request }) => {
  // before the throwaway's cleanup, which deletes the schemas named after the tag
  if (fetcher) await request.delete(`/api/v1/processors/${fetcher.id}`);
  await removeThrowaway(request);
});
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const toolbox = (page: Page) => page.locator('[data-pane="toolbox"]');
const tileOf = (page: Page, tool: string, id?: string) => toolbox(page).locator(`.tb-tile[data-tool="${tool}"]${id ? `[data-id="${id}"]` : ''}`);
const centre = async (l: Locator): Promise<Pt> => { const b = await box(l); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const field = (page: Page, label: string): Locator => inspector(page).getByLabel(label, { exact: true });
const pill = (page: Page): Locator => inspector(page).locator('.kindpill');
const checks = (page: Page): Locator => inspector(page).locator('[data-check]');

/** Presses a tile and moves the real mouse onto `to` in steps, then lets go. */
async function drag(page: Page, tile: Locator, to: Pt): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  const from = await centre(tile);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/** Replaces a field's text with the real keyboard: click, select all, type. */
async function typeInto(page: Page, label: string, text: string): Promise<void> {
  await field(page, label).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

const stepIds = (panel: Locator) => panel.locator('.react-flow__node-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!));

/** A Toolbox step dropped on an empty spot of the canvas; its id. */
async function newStep(page: Page, panel: Locator, avoid: Pt[] = []): Promise<{ id: string; at: Pt }> {
  const known = new Set(await stepIds(panel));
  // clear of the toolbar over the canvas's top, so the step's header can be clicked
  const area = await box(panel.locator('.react-flow'));
  const top = Array.from({ length: Math.ceil(area.width / 100) + 1 }, (_, i) => ({ x: area.x + i * 100, y: area.y + 40 }));
  const at = await emptySpot(panel, [...avoid, ...top]);
  await drag(page, tileOf(page, 'step'), at);
  await expect.poll(async () => (await stepIds(panel)).filter((id) => !known.has(id))).toHaveLength(1);
  return { id: (await stepIds(panel)).find((id) => !known.has(id))!, at };
}

async function selectStep(page: Page, panel: Locator, id: string): Promise<void> {
  await node(panel, id).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
}

test('a Toolbox step takes its first processor\'s name, not a later one, never a typed one; Undo brings its own back', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await toolbox(page).getByRole('searchbox', { name: 'Search the toolbox' }).fill(t.tag);
  await expect(tileOf(page, 'processor', fetcher.id)).toBeVisible();

  const a = await newStep(page, panel);
  await expect(pill(page)).toHaveText('STEP');
  const given = await field(page, 'Name').inputValue();
  expect(given).toMatch(/^step(-\d+)?$/);
  // the first processor: the step takes its name
  await drag(page, tileOf(page, 'processor', fetcher.id), await centre(node(panel, a.id)));
  await expect(node(panel, a.id).locator(`.chipg[data-processor="${fetcher.id}"]`)).toHaveCount(1);
  await selectStep(page, panel, a.id);
  await expect(field(page, 'Name')).toHaveValue(fetcher.name);
  // a second processor: the name stays
  await drag(page, tileOf(page, 'processor', t.processorId), await centre(node(panel, a.id)));
  await expect(node(panel, a.id).locator(`.chipg[data-processor="${t.processorId}"]`)).toHaveCount(1);
  await selectStep(page, panel, a.id);
  await expect(field(page, 'Name')).toHaveValue(fetcher.name);
  // Undo twice: the drops go back, and with the first one the Toolbox's name
  await panel.locator('.studio-canvas').focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(node(panel, a.id).locator('.chip-empty')).toHaveCount(1);
  await selectStep(page, panel, a.id);
  await expect(field(page, 'Name')).toHaveValue(given);

  // a step the user named: the name is kept when the processor arrives
  const b = await newStep(page, panel, [a.at]);
  await typeInto(page, 'Name', `${t.tag}-mine`);
  await drag(page, tileOf(page, 'processor', fetcher.id), await centre(node(panel, b.id)));
  await expect(node(panel, b.id).locator(`.chipg[data-processor="${fetcher.id}"]`)).toHaveCount(1);
  await selectStep(page, panel, b.id);
  await expect(field(page, 'Name')).toHaveValue(`${t.tag}-mine`);
});

test('＋ Create lays the payload out from the config schema and checks it while it is typed', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await toolbox(page).getByRole('searchbox', { name: 'Search the toolbox' }).fill(t.tag);
  const s = await newStep(page, panel);
  await drag(page, tileOf(page, 'processor', fetcher.id), await centre(node(panel, s.id)));
  await expect(node(panel, s.id).locator(`.chipg[data-processor="${fetcher.id}"]`)).toHaveCount(1);
  await selectStep(page, panel, s.id);

  await inspector(page).getByRole('button', { name: '＋ Create' }).click();
  await expect(pill(page)).toHaveText('ASSIGNMENT');
  await expect(field(page, 'Name')).toHaveValue(`${fetcher.name}-assignment`);
  await expect(field(page, 'Payload')).toHaveValue('{\n  "maximumSizeBytes": "<integer>",\n  "minimumSizeBytes": "<integer>",\n  "allowedExtensions": []\n}');
  await expect(checks(page)).toHaveText(['/maximumSizeBytes: still a placeholder: fill in an integer', '/minimumSizeBytes: still a placeholder: fill in an integer']);
  await expect(inspector(page).getByText(`checked against ${t.tag}-fetcher-config 1.0.0; Save checks it again`)).toBeVisible();
  await expect(field(page, 'Payload')).toHaveAttribute('aria-invalid', 'true');

  // filled in: no problems left
  await typeInto(page, 'Payload', '{"maximumSizeBytes": 1048576, "minimumSizeBytes": 1, "allowedExtensions": [".zip"]}');
  await expect(checks(page)).toHaveCount(0);
  await expect(field(page, 'Payload')).not.toHaveAttribute('aria-invalid');
  // a wrong type, a value under its minimum, a field the schema does not have
  await typeInto(page, 'Payload', '{"maximumSizeBytes": "abc", "minimumSizeBytes": -1, "extra": 1}');
  await expect.poll(async () => (await checks(page).allTextContents()).sort())
    .toEqual(['/: "extra" is not in the schema', '/maximumSizeBytes: must be integer', '/minimumSizeBytes: must be >= 0']);
  // a required field missing
  await typeInto(page, 'Payload', '{"maximumSizeBytes": 5}');
  await expect(checks(page)).toHaveText(['/: missing required "minimumSizeBytes"']);
  // nothing saved: the design is a draft
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('the Cron field\'s presets type the expression in, and say it in words', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await node(panel, 'wf').click();
  await expect(pill(page)).toHaveText('WORKFLOW');
  const presets = inspector(page).getByRole('combobox', { name: 'Cron presets' });
  await presets.click();
  await presets.selectOption({ label: 'Every 5 minutes · 0 */5 * * * *' });
  await expect(field(page, 'Cron')).toHaveValue('0 */5 * * * *');
  await expect(inspector(page).locator('.fhint').first()).toHaveText(/every 5 minutes/i);
  await expect(presets).toHaveValue('');
  await presets.selectOption({ label: 'Weekdays at 08:00 · 0 0 8 * * MON-FRI' });
  await expect(field(page, 'Cron')).toHaveValue('0 0 8 * * MON-FRI');
  await presets.selectOption({ label: 'Not scheduled' });
  await expect(field(page, 'Cron')).toHaveValue('');
  await expect(inspector(page).locator('.fhint').first()).toHaveText('Not scheduled');
});

test('＋ Define on an empty slot starts from the schema template; unedited, it is no change', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await node(panel, t.stepId).locator('.chipg').click();
  await expect(pill(page)).toHaveText('PROCESSOR');
  const out = inspector(page).locator('.slot').filter({ hasText: 'Out' });
  await out.getByRole('button', { name: '＋ Define' }).click();
  await expect(pill(page)).toHaveText('SCHEMA');
  await expect(field(page, 'Definition')).toHaveValue(JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: [], properties: {}, additionalProperties: false,
  }, null, 2));
  await expect(inspector(page).getByText('● unsaved changes')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '⤓ Save' })).toBeDisabled();
  expect(await labelsOf(panel)).toEqual([]);
});
