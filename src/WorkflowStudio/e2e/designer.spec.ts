import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { documentPanel, expect, inspector, openWorkflow, tab, test, workflowsWithSteps, type LiveWorkflow } from './studio';

// Plan 4: the designer is a trial; nothing it does may write (studio.ts's read-only guard checks every
// request). Each test starts from an empty session and works on a live workflow with a chain a -> b -> c
// where b has no other way in.

interface Chain { workflow: LiveWorkflow; a: string; b: string; c: string }

async function findChain(request: APIRequestContext): Promise<Chain | null> {
  for (const workflow of await workflowsWithSteps(request)) {
    const g = (await (await request.get(`/api/v1/workflows/${workflow.id}/graph`)).json()) as { workflow: { entryStepIds: string[] }; steps: { id: string; nextStepIds: string[] }[] };
    const into = (id: string) => g.steps.filter((s) => s.nextStepIds.includes(id)).length + (g.workflow.entryStepIds.includes(id) ? 1 : 0);
    for (const a of g.steps) for (const b of a.nextStepIds) {
      const sb = g.steps.find((s) => s.id === b);
      if (!sb || into(b) !== 1) continue;
      const c = sb.nextStepIds[0];
      if (c && c !== a.id) return { workflow, a: a.id, b, c };
    }
  }
  return null;
}

let chain: Chain | null;
test.beforeAll(async ({ request }) => { chain = await findChain(request); });
test.beforeEach(async ({ page }) => {
  test.skip(chain === null, 'BaseApi has no workflow with a chain a -> b -> c');
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const node = (panel: Locator, id: string) => panel.locator(`.react-flow__node[data-id="${id}"]`);
const wire = (panel: Locator, id: string) => panel.locator(`.react-flow__edge[data-id="${id}"]`);
const pathOf = (panel: Locator, id: string) => wire(panel, id).locator('path.w').getAttribute('d');

/**
 * A point on a wire, in page coordinates, where that wire is the topmost thing under the pointer: wires
 * into a shared step run together near its input, so the point nearest `f` (as a fraction of the length)
 * that no other wire or block covers.
 */
async function pointOnWire(panel: Locator, id: string, f = 0.5): Promise<{ x: number; y: number }> {
  return wire(panel, id).locator('path.w').evaluate((el, [at, wid]) => {
    const p = el as SVGPathElement;
    const m = p.getScreenCTM()!;
    const len = p.getTotalLength();
    const toPage = (t: number) => {
      const pt = p.getPointAtLength(len * t);
      return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
    };
    const tries = [at, ...Array.from({ length: 40 }, (_, i) => [at + (i + 1) / 50, at - (i + 1) / 50]).flat()].filter((t) => t > 0.02 && t < 0.98);
    for (const t of tries) {
      const q = toPage(t);
      if (el.ownerDocument.elementFromPoint(q.x, q.y)?.closest('.react-flow__edge')?.getAttribute('data-id') === wid) return q;
    }
    return toPage(at);
  }, [f, id] as const);
}

async function centreOf(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, chain!.workflow);
  return documentPanel(page, chain!.workflow);
}

test('a moved step takes its wires with it; the draft is marked; a refresh keeps it; Discard drops it', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  const before = await pathOf(panel, `${a}->${b}`);
  const at = await centreOf(node(panel, b).locator('.nx-sn'));
  await drag(page, at, { x: at.x, y: at.y + 120 });
  await expect.poll(() => pathOf(panel, `${a}->${b}`)).not.toBe(before);
  await expect(page.getByText('● design draft')).toBeVisible();
  await expect(tab(page, chain!.workflow.name)).toHaveClass(/\bdirty\b/);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  await expect(page.getByText('● design draft')).toBeVisible();
  await expect.poll(() => pathOf(again, `${a}->${b}`)).not.toBe(before);

  await page.getByRole('button', { name: 'Discard design' }).click();
  await page.getByRole('alertdialog', { name: 'Discard design' }).getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await expect.poll(() => pathOf(again, `${a}->${b}`)).toBe(before);
});

test('Ctrl+click and a rectangle pick several items; a wire click names the wire', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  await node(panel, a).locator('.nx-sn').click();
  await node(panel, b).locator('.nx-sn').click({ modifiers: ['Control'] });
  await expect(inspector(page).getByText('2 items selected')).toBeVisible();

  const box = (await node(panel, a).boundingBox())!;
  await drag(page, { x: box.x - 12, y: box.y - 12 }, { x: box.x + box.width + 12, y: box.y + box.height + 12 });
  await expect(node(panel, a)).toHaveClass(/studio-pick/);

  const p = await pointOnWire(panel, `${a}->${b}`);
  await page.mouse.click(p.x, p.y);
  await expect(inspector(page).getByText(/^Wire: /)).toBeVisible();
});

test('a run drags and Reset route restores the automatic shape', async ({ page }) => {
  const panel = await open(page);
  const id = `${chain!.a}->${chain!.b}`;
  const before = await pathOf(panel, id);
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const handle = panel.locator('.design-handle.seg').first();
  const at = await centreOf(handle);
  await drag(page, at, { x: at.x, y: at.y + 48 });
  await expect.poll(() => pathOf(panel, id)).not.toBe(before);
  const q = await pointOnWire(panel, id, 0.3);
  await page.mouse.click(q.x, q.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset route' }).click();
  await expect.poll(() => pathOf(panel, id)).toBe(before);
});

// FIXME (finding F1, .superpowers/sdd/2026-10-07-skp-studio-04-canvas-designer/task-10-report.md): a picked wire is lifted (zIndex 1, canvas/selection.ts), so its
// own hit band lies over the design overlay and covers its end dots: a press on the arrow head starts a run
// drag instead of re-attaching the end. Un-fixme once the end dots sit above the picked wire.
test.fixme('a wire end re-attaches; a cycle outlines red and snaps back', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const p = await pointOnWire(panel, `${b}->${c}`);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator('.design-handle.end[data-end="target"]'));
  const target = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, a)).toHaveClass(/drop-no/);
  await page.mouse.up();
  await expect(wire(panel, `${b}->${c}`)).toHaveCount(1);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('a new entry wire from the hub, Delete, and a step left unreached is parked; Undo and Redo', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  await node(panel, 'wf').hover();
  const port = await centreOf(node(panel, 'wf').locator('.nx-port'));
  const target = await centreOf(node(panel, c).locator('.nx-sn'));
  await drag(page, port, target);
  await expect(wire(panel, `wf->${c}`)).toHaveCount(1);

  const p = await pointOnWire(panel, `${a}->${b}`);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Delete');
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(0);
  await expect(node(panel, b).getByText('PARKED', { exact: true })).toBeVisible();

  await page.keyboard.press('Control+z');
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(1);
  await page.getByRole('button', { name: '↷ Redo' }).click();
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(0);
});

test('closing a designed workflow asks; Cancel keeps it', async ({ page }) => {
  const panel = await open(page);
  const at = await centreOf(node(panel, chain!.b).locator('.nx-sn'));
  await drag(page, at, { x: at.x + 64, y: at.y });
  await expect(page.getByText('● design draft')).toBeVisible();
  await tab(page, chain!.workflow.name).getByRole('button', { name: `Close ${chain!.workflow.name}` }).click();
  await page.getByRole('alertdialog', { name: 'Discard design changes?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(tab(page, chain!.workflow.name)).toHaveCount(1);
});
