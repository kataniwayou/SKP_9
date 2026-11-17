import { test, expect } from './fixtures';
import {
  cachesOf, cacheTool, dragOnto, drawWire, dropStep, dropWorkflow, frameOf, inspector, emptyPoint, openEmptyBoard, outLine,
  pickWire, PROC_A, PROC_B, stepsOf, throwaway, toolbar, toolboxStep, wiresOf, workflowTool,
} from './helpers';

// Features 5 (create) and 6 (wires). Everything here happens in throwaway frames that are never saved: nothing is sent.

test.describe('create from the toolbox', () => {
  test('Workflow dropped on empty board: a new-workflow-N frame, unsaved and picked', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await dropWorkflow(page);
    expect(f.name).toMatch(/^new-workflow-\d+$/);
    await expect(f.frame.locator('.unsaved-tag')).toBeVisible();
    await expect(f.frame).toHaveClass(/selected/);
    await expect(toolbar(page, 'workflow')).toBeVisible();
    await expect(toolbar(page, 'workflow').locator('.toolbar-arrow')).toBeAttached();
    await expect(outLine(page, `${f.name} created — it is saved only when you press Save`)).toHaveCount(1);
    await expect(f.frame.locator('.empty')).toContainText('Empty workflow');
    await expect(f.frame.locator('.meta')).toHaveText('1.0.0 · not scheduled');
    await expect(inspector(page).locator('.ins-title b')).toHaveText(f.name);

    // a second one takes the next free number
    const g = await dropWorkflow(page);
    const n = (s: string) => Number(/\d+$/.exec(s)![0]);
    expect(n(g.name)).toBeGreaterThan(n(f.name));

    // where things may not go
    const fb = (await f.frame.boundingBox())!;
    await dragOnto(page, workflowTool(page), fb.x + fb.width / 2, fb.y + fb.height / 2);
    await expect(outLine(page, 'Drop a new workflow on empty board')).toHaveCount(1);
    const empty = await emptyPoint(page);
    await dragOnto(page, toolboxStep(page, PROC_A), empty.x, empty.y);
    await expect(outLine(page, 'Drop a step inside a workflow')).toHaveCount(1);
    await dragOnto(page, cacheTool(page), empty.x, empty.y);
    await expect(outLine(page, 'Drop a cache inside a workflow')).toHaveCount(1);
    await expect(page.locator('.react-flow__node-workflow', { hasText: /new-workflow-/ })).toHaveCount(2);
  });

  test('a Steps item adds a step with that processor; dropped on a step it swaps the processor', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await dropWorkflow(page);
    const s = await dropStep(page, f, PROC_A, 30, 30);
    await expect(s.locator('.sp2')).toHaveText(PROC_A);
    await expect(s.locator('.sn')).toHaveText(PROC_A);
    await expect(f.frame.locator('.empty')).toHaveCount(0);
    // the only step of a workflow runs as its first step
    await expect(s.locator('.tag')).toHaveText('FIRST');
    const b = (await s.boundingBox())!;
    await dragOnto(page, toolboxStep(page, PROC_B), b.x + b.width / 2, b.y + b.height / 2);
    await expect(s.locator('.sp2')).toHaveText(PROC_B);
    await expect(stepsOf(page, f.id)).toHaveCount(1);
    // the swap keeps the step's name; a second step of a processor already named in the workflow gets a unique name
    await expect(s.locator('.sn')).toHaveText(PROC_A);
    const t = await dropStep(page, f, PROC_A, 300, 30);
    await expect(t.locator('.sn')).toHaveText(`${PROC_A}-2`);
    // two unwired steps are both parked
    await expect(s.locator('.tag')).toHaveText('PARKED');
    await expect(t.locator('.tag')).toHaveText('PARKED');
  });

  test('Create › Cache makes a new cache chip; a Caches item links one; the chip toolbar Delete unlinks it', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await dropWorkflow(page);
    const fb = (await f.frame.boundingBox())!;
    await dragOnto(page, cacheTool(page), fb.x + fb.width / 2, fb.y + fb.height / 2);
    await expect(cachesOf(page, f.id)).toHaveCount(1);
    await expect(cachesOf(page, f.id).locator('.cache-nm')).toHaveText(/^new-cache-\d+$/);

    const item = page.getByTestId('toolbox-cache').first();
    const cacheName = (await item.locator('.tx').evaluate((el) => el.firstChild?.textContent ?? ''))!.trim();
    const fb2 = (await f.frame.boundingBox())!;
    await dragOnto(page, item, fb2.x + fb2.width / 2, fb2.y + 70);
    await expect(cachesOf(page, f.id)).toHaveCount(2);
    await expect(cachesOf(page, f.id).locator('.cache-nm', { hasText: cacheName })).toHaveCount(1);
    // linking it twice is refused
    await dragOnto(page, item, fb2.x + fb2.width / 2, fb2.y + 70);
    await expect(outLine(page, `${cacheName} is already linked to ${f.name}`)).toHaveCount(1);
    await expect(cachesOf(page, f.id)).toHaveCount(2);

    // pick the linked chip: its toolbar has Delete only, which unlinks it
    const chip = cachesOf(page, f.id).filter({ hasText: cacheName });
    await chip.click();
    await expect(toolbar(page, 'cache')).toBeVisible();
    await expect(toolbar(page, 'cache').getByRole('button')).toHaveText(['Delete']);
    await expect(inspector(page).locator('.ins-title b')).toHaveText(cacheName);
    await toolbar(page, 'cache').getByRole('button', { name: 'Delete' }).click();
    await expect(cachesOf(page, f.id)).toHaveCount(1);
    await expect(f.frame).toHaveClass(/selected/);
  });
});

test.describe('wires', () => {
  test('a drag from a step\'s right handle onto another step draws a wire in the target\'s entry colour', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await throwaway(page, 2);
    const [a, b] = f.steps as [ReturnType<typeof page.locator>, ReturnType<typeof page.locator>];
    await drawWire(page, a, b);
    await expect(wiresOf(page, f.id)).toHaveCount(1);
    const w = wiresOf(page, f.id).first();
    await expect(w.locator('g.link-wire')).toHaveAttribute('data-condition', 'Completed');
    await expect(w.locator('text.pilltx')).toHaveText('C');
    await expect(w.locator('path.wire')).toHaveAttribute('stroke', '#0F9488');
    await expect(a.locator('.tag')).toHaveText('FIRST');
    await expect(b.locator('.tag')).toHaveCount(0);
  });

  test("a step's right handle stays under the pointer when the pointer rests on it", async ({ page }) => {
    // Was an app bug (fixed 2026-11-18): the hover rule `.node:hover .react-flow__handle { transform: translate(-50%, -50%)
    // scale(1.3) }` replaced React Flow's `translate(50%, -50%)` for the RIGHT handle, so on hover it jumped about 11 px
    // left, out from under the pointer, and a press where it was drawn dragged the card instead of drawing a wire.
    await openEmptyBoard(page);
    const f = await throwaway(page, 2);
    const handle = f.steps[0]!.locator('.react-flow__handle.source');
    const h = (await handle.boundingBox())!;
    const at = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(300);
    const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('react-flow__handle') ?? false, at);
    expect(under, 'the handle is still under the pointer after the hover transition').toBe(true);
  });

  test('refused wires say why in Output and draw nothing', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await throwaway(page, 2);
    const g = await throwaway(page, 1);
    const [a, b] = f.steps as [ReturnType<typeof page.locator>, ReturnType<typeof page.locator>];
    await drawWire(page, a, await emptyPoint(page));
    await expect(outLine(page, 'A wire must end on a step')).toHaveCount(1);
    await drawWire(page, a, a);
    await expect(outLine(page, 'A step cannot wire to itself')).toHaveCount(1);
    await drawWire(page, a, b);
    await expect(wiresOf(page, f.id)).toHaveCount(1);
    await drawWire(page, a, b);
    await expect(outLine(page, 'That wire already exists')).toHaveCount(1);
    await drawWire(page, a, g.steps[0]!);
    await expect(outLine(page, 'A wire stays inside its workflow')).toHaveCount(1);
    await expect(wiresOf(page, f.id)).toHaveCount(1);
    await expect(wiresOf(page, g.id)).toHaveCount(0);
  });

  test('a picked wire\'s toolbar Delete removes it and picks its workflow', async ({ page }) => {
    // APP BUG: the wire toolbar (rendered by EdgeLabelRenderer) is drawn UNDER the workflow frame: in the viewport
    // .react-flow__edgelabel-renderer comes before .react-flow__nodes with the same z-index, and the wire always lies
    // inside its frame, so the frame covers the toolbar and a click on its Delete lands on the frame ("<div class="frame
    // is-off"> … intercepts pointer events"). The wire cannot be deleted from its toolbar.
    test.fail();
    await openEmptyBoard(page);
    const f = await throwaway(page, 2);
    await drawWire(page, f.steps[0]!, f.steps[1]!);
    const w = wiresOf(page, f.id).first();
    await pickWire(page, w);
    await expect(toolbar(page, 'wire')).toBeVisible();
    await expect(toolbar(page, 'wire').getByRole('button')).toHaveText(['Delete']);
    await expect(inspector(page).locator('.ins-title b')).toHaveText(`${PROC_A} → ${PROC_A}-2`);
    // the topmost element where the button is drawn must be the button itself
    const btn = toolbar(page, 'wire').getByRole('button', { name: 'Delete' });
    const bb = (await btn.boundingBox())!;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 })).toBe('Delete');
    await btn.click({ timeout: 5000 });
    await expect(wiresOf(page, f.id)).toHaveCount(0);
    await expect(frameOf(page, f.id)).toHaveClass(/selected/);
  });
});
