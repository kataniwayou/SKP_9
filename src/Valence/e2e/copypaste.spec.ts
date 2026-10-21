import { expect, test } from './valence';

// Copy and paste (spec "Copy/paste", 2026-10-17): Ctrl+C copies the pinned atom's own values; Ctrl+V puts its copy on the
// pointer, sized as its tile, and a click drops it under the Toolbox's rules. Arrows are not copied (only the mandatory
// one, from where it lands); a cache's root and a processor's source hash paste empty (unique in the database).

/** Ctrl+V with the pointer at a point, then a click there. */
async function pasteAt(v: import('./valence').Valence, at: { x: number; y: number }) {
  await v.page.mouse.move(at.x, at.y, { steps: 6 });
  await v.page.keyboard.press('Control+v');
  await v.page.mouse.move(at.x + 2, at.y + 1, { steps: 2 });
  await v.page.waitForTimeout(150);
  await v.page.mouse.click(at.x + 2, at.y + 1);
  await v.page.waitForTimeout(500);
}

test('a processor copied and pasted on empty canvas: its values, no schema arrows, the source hash empty', async ({ v }) => {
  const src = v.key('proc', 'archive-expander');
  await v.pin(src);
  await v.canvasKey('Control+c');
  expect(await v.lastLine()).toBe('Copied archive-expander: Ctrl+V on the canvas pastes it as a new processor.');

  await pasteAt(v, await v.empty());
  const made = await v.made();
  expect(made).toHaveLength(1);
  const key = made[0]!.key;
  const row = { ...made[0]!.row, ...((await v.session()).edits?.[key] ?? {}) };
  expect(row.name).toBe('archive-expander');
  expect(row.sourceHash ?? '').toBe('');
  const out = await v.page.evaluate((k) => {
    const el = [...document.querySelectorAll('.mol')].find((e) => (e as unknown as { __molecule?: unknown }).__molecule) as unknown as { __molecule: { arrows: { a: { atom: { key: string } } }[] } };
    return el.__molecule.arrows.filter((x) => x.a.atom.key === k).length;
  }, key);
  expect(out).toBe(0);
  expect(await v.lastLine()).toMatch(/^Pasted a copy of archive-expander in Valence \(not applied\): only its mandatory arrow came with it\.$/);
  // unique source hash: the paste lands unfinished
  await expect(v.inspector().locator('.insp-virtual.made')).toContainText('unfinished: fill in');
});

test('a step pastes only onto a processor; one copy pastes any number of times; Ctrl+Z takes a paste back', async ({ v }) => {
  const proc = v.key('proc', 'archive-expander');
  const step = `step:${v.api.project.steps.find((s) => s.processorId === proc.split(':')[1])!.id}`;
  await v.pin(step);
  await v.canvasKey('Control+c');

  await pasteAt(v, await v.spot(proc));
  await pasteAt(v, await v.spot(proc));
  const made = await v.made();
  expect(made).toHaveLength(2);
  for (const m of made) expect(await v.arrowOn('uses', m.key, proc)).toBe(true);

  await v.canvasKey('Control+z');
  expect(await v.made()).toHaveLength(1);
  expect(await v.lastLine()).toMatch(/^Undid: /);
});

test('Escape cancels a paste: nothing is made', async ({ v }) => {
  await v.pin(v.key('schema', 'gateA-sample-compatible'));
  await v.canvasKey('Control+c');
  const at = await v.empty();
  await v.page.mouse.move(at.x, at.y, { steps: 4 });
  await v.page.keyboard.press('Control+v');
  await expect(v.page.locator('.tb-ghost')).toHaveCount(1);
  await v.page.keyboard.press('Escape');
  await expect(v.page.locator('.tb-ghost')).toHaveCount(0);
  await v.page.mouse.click(at.x, at.y);
  await v.page.waitForTimeout(300);
  expect(await v.made()).toHaveLength(0);
});

test('a deleted atom and an updated one cannot be copied', async ({ v }) => {
  const del = v.key('schema', 'gateA-badconfig-clash');
  await v.pin(del);
  await v.canvasKey('Delete');
  await v.canvasKey('Control+c');
  expect(await v.lastLine()).toMatch(/deleted atom cannot be copied/);

  const step = `step:${v.api.project.steps[0]!.id}`;
  await v.pin(step);
  await v.fill({ description: 'edited by the e2e suite' });
  await v.canvasKey('Control+c');
  expect(await v.lastLine()).toMatch(/updated atom cannot be copied/);
});

test('Ctrl+C in an Inspector field is the browser\'s copy: no atom is copied', async ({ v }) => {
  await v.pin(v.key('schema', 'gateA-sample-compatible'));
  await v.park();
  const before = await v.lastLine();
  await v.field('name').focus();
  await v.page.keyboard.press('Control+c');
  await v.page.waitForTimeout(300);
  expect(await v.lastLine()).toBe(before);
});

test('the keys follow the physical key: Ctrl+V under a Hebrew layout (ה on the V key) pastes', async ({ v }) => {
  await v.pin(v.key('schema', 'gateA-sample-compatible'));
  await v.canvasKey('Control+c');
  const at = await v.empty();
  await v.page.mouse.move(at.x, at.y, { steps: 4 });
  await v.page.evaluate(() => {
    const el = [...document.querySelectorAll('.mol')].find((e) => (e as unknown as { __molecule?: unknown }).__molecule) as HTMLElement;
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ה', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await expect(v.page.locator('.tb-ghost')).toHaveCount(1);
  await v.page.mouse.click(at.x + 1, at.y);
  await v.page.waitForTimeout(400);
  expect(await v.made()).toHaveLength(1);
});
