import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  cacheTool, dragBy, dropTool, field, ghost, openAt, outLine, pickStep, regionPoint, renameTo, save, saveButton, selectWorkflowAlone,
  stNode, toolbar, toolboxStep, waitLoaded, wfNode, wireEdge, workflowTool, PROC_B,
} from '../helpers';
import { seed } from '../seed';
import { getJson, type Row } from '../stack';

// Regression 9 (user, 2026-11-24/25): the draft. Discard drops every change made since the last Save, never what was saved, as
// one undo step. Only a delete makes a ghost: a create taken back by Ctrl+Z or by Discard leaves none, while undoing a Restore
// (or redoing a delete) brings the ghost back. Ghosts drag like steps and keep their place across a reload, the right-click
// box picks them, and a restored step brings its wires back.

const discardButton = (page: Page) => page.locator('button.discard-board');
const ghosts = (page: Page) => page.locator('.react-flow__node.ghost');
const pane = (page: Page) => page.locator('.react-flow__pane');
/** Ctrl+Z / Ctrl+Y with the focus on the board, not in an Inspector field. */
async function key(page: Page, k: 'Control+z' | 'Control+y') {
  await pane(page).click({ position: { x: 20, y: 20 } });
  await page.keyboard.press(k);
}
const boxOf = async (l: ReturnType<typeof stNode>) => (await l.boundingBox())!;

test('Discard drops what is unsaved since the last Save, never what was saved', async ({ page }) => {
  const id = await seed({
    steps: [{ key: 'S', name: 'e2e-disc-S', at: { x: 300, y: 60 } }],
    workflows: [{ key: 'W', name: 'e2e-disc-W', at: { x: 0, y: 40 }, entry: ['S'] }],
  });
  await openAt(page);
  // a saved change: Discard must never take it back
  await selectWorkflowAlone(page, id.W!);
  await field(page, 'Name').fill('e2e-disc-W-saved');
  expect((await save(page)).applied).toBe(true);
  await expect(discardButton(page)).toBeDisabled();

  // three unsaved ones: a rename, a move, a new step
  const at0 = await boxOf(stNode(page, id.S!));
  await selectWorkflowAlone(page, id.W!);
  await field(page, 'Name').fill('e2e-disc-W-unsaved');
  await pane(page).click({ position: { x: 20, y: 20 } });
  await dragBy(page, stNode(page, id.S!), 0, 180);
  const made = await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 700, y: 60 }));
  await expect(saveButton(page)).toHaveText('Save · 3');
  await expect(discardButton(page)).toBeEnabled();

  await discardButton(page).click();
  await expect(saveButton(page)).toHaveText('Save');
  await expect(saveButton(page)).toBeDisabled();
  await expect(discardButton(page)).toBeDisabled();
  await expect(wfNode(page, id.W!).locator('.tri-nm')).toHaveText('e2e-disc-W-saved');
  const at1 = await boxOf(stNode(page, id.S!));
  expect(Math.abs(at1.x - at0.x)).toBeLessThan(2);
  expect(Math.abs(at1.y - at0.y)).toBeLessThan(2);
  await expect(stNode(page, made)).toHaveCount(0);
  await expect(outLine(page, 'Discarded 3 unsaved changes — Ctrl+Z brings them back')).toBeVisible();
  expect((await getJson<Row>(`/workflows/${id.W}`)).name).toBe('e2e-disc-W-saved');

  // one undo step each way
  await key(page, 'Control+z');
  await expect(saveButton(page)).toHaveText('Save · 3');
  await expect(wfNode(page, id.W!).locator('.tri-nm')).toHaveText('e2e-disc-W-unsaved');
  await expect(stNode(page, made)).toHaveCount(1);
  await key(page, 'Control+y');
  await expect(saveButton(page)).toHaveText('Save');

  // the draft went with them
  await page.reload();
  await waitLoaded(page);
  await expect(saveButton(page)).toHaveText('Save');
  await expect(discardButton(page)).toBeDisabled();
  await expect(wfNode(page, id.W!).locator('.tri-nm')).toHaveText('e2e-disc-W-saved');
});

test('only a delete makes a ghost', async ({ page }) => {
  await openAt(page);
  const g0 = await ghosts(page).count();
  const spot = () => regionPoint(page, { x: 200, y: 140 });

  // a create undone leaves nothing behind
  for (const [tool, kind] of [[workflowTool(page), 'workflow'], [toolboxStep(page, PROC_B), 'step'], [cacheTool(page), 'cache']] as const) {
    const made = await dropTool(page, tool, kind, await spot());
    await key(page, 'Control+z');
    await expect(page.locator(`.react-flow__node[data-id$="${made}"]`), `${kind} undone`).toHaveCount(0);
    await expect(ghosts(page), `${kind} undone`).toHaveCount(g0);
  }
  // nor do creates discarded
  await dropTool(page, workflowTool(page), 'workflow', await spot());
  await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 500, y: 140 }));
  await dropTool(page, cacheTool(page), 'cache', await regionPoint(page, { x: 200, y: 340 }));
  await discardButton(page).click();
  await expect(saveButton(page)).toHaveText('Save');
  await expect(ghosts(page), 'discarded creates').toHaveCount(g0);

  // a delete is a ghost; its undo takes it away, its redo brings it back
  const gone = await dropTool(page, toolboxStep(page, PROC_B), 'step', await spot());
  await renameTo(page, 'e2e-ghostrule-gone');
  await pane(page).click({ position: { x: 20, y: 20 } });
  await pickStep(page, gone);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  await expect(ghost(page, 'e2e-ghostrule-gone')).toHaveCount(1);
  await key(page, 'Control+z');
  await expect(ghost(page, 'e2e-ghostrule-gone')).toHaveCount(0);
  await expect(stNode(page, gone)).toHaveCount(1);
  await key(page, 'Control+y');
  await expect(ghost(page, 'e2e-ghostrule-gone')).toHaveCount(1);

  // Restore, then undo the Restore: back to the deleted state, ghost and all
  await ghost(page, 'e2e-ghostrule-gone').click();
  await toolbar(page, 'ghost').getByRole('button', { name: 'Restore' }).click();
  await expect(ghost(page, 'e2e-ghostrule-gone')).toHaveCount(0);
  await expect(stNode(page, gone)).toHaveCount(1);
  await key(page, 'Control+z');
  await expect(ghost(page, 'e2e-ghostrule-gone')).toHaveCount(1);
  await expect(stNode(page, gone)).toHaveCount(0);
});

test('restore brings its wires, ghosts drag and keep their place, and the right-click box picks them', async ({ page }) => {
  const id = await seed({
    steps: [
      { key: 'A', name: 'e2e-rg-A', at: { x: 0, y: 60 }, next: ['B'] },
      { key: 'B', name: 'e2e-rg-B', at: { x: 320, y: 60 }, next: ['C'] },
      { key: 'C', name: 'e2e-rg-C', at: { x: 640, y: 60 } },
    ],
  });
  await openAt(page);
  await pickStep(page, id.B!);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  const G = ghost(page, 'e2e-rg-B');
  await expect(G).toHaveCount(1);
  const ghostWire = (from: string, to: string) => page.locator(`.react-flow__edge.ghost[data-id="ghost:wire:${from}:${to}"]`);
  await expect(ghostWire(id.A!, id.B!)).toHaveCount(1);
  await expect(ghostWire(id.B!, id.C!)).toHaveCount(1);

  // a ghost drags like a step (the place is clear, nothing is pushed) and keeps its place across a reload
  const before = await boxOf(G);
  await dragBy(page, G, 0, 200);
  await expect.poll(async () => (await boxOf(G)).y).toBeGreaterThan(before.y + 150);
  const moved = await boxOf(G);
  await page.reload();
  await waitLoaded(page);
  await expect.poll(async () => Math.round((await boxOf(G)).y)).toBe(Math.round(moved.y));

  // the right-click box picks a ghost, in the accent frame
  const b = await boxOf(G);
  await page.mouse.move(b.x - 20, b.y - 20);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.move(b.x + b.width + 20, b.y + b.height + 20, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await expect(G.locator('.node.sel')).toHaveCount(1);

  // Restore from the box-picked ghost's own toolbar (a click now would un-pick it): back where the ghost was put, with both wires
  await toolbar(page, 'ghost').getByRole('button', { name: 'Restore' }).click();
  await expect(stNode(page, id.B!)).toHaveCount(1);
  expect(Math.round((await boxOf(stNode(page, id.B!))).y)).toBe(Math.round(moved.y));
  await expect(wireEdge(page, id.A!, id.B!)).toHaveCount(1);
  await expect(wireEdge(page, id.B!, id.C!)).toHaveCount(1);
  await expect(page.locator('.react-flow__node.ghost, .react-flow__edge.ghost')).toHaveCount(0);
});
