import { expect, test } from './valence';

// One history (spec §6c): edits, Revert, deletions, made atoms, drawn arrows and AI drawings are steps of one undo / redo
// list; Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo. The session keeps the draft, the history and the view across a
// refresh (the view: camera, slide, every atom's place; never sent to BaseApi).

test('an edit, a delete and a drawn atom walk back with Ctrl+Z and forward with Ctrl+Y and Ctrl+Shift+Z', async ({ v }) => {
  const schema = v.key('schema', 'gateA-sample-compatible');
  await v.pin(schema);
  await v.fill({ description: 'edited by the e2e suite' });
  await v.canvasKey('Delete');
  const made = await v.make('cache');

  await v.canvasKey('Control+z');
  expect(await v.made()).toHaveLength(0);
  await v.canvasKey('Control+z');
  expect(await v.removed()).toEqual({ atoms: [], arrows: [] });
  expect(await v.lastLine()).toBe('Undid: delete schema gateA-sample-compatible.');
  await v.canvasKey('Control+z');
  expect((await v.session()).edits?.[schema]).toBeUndefined();
  await v.canvasKey('Control+z');
  expect(await v.lastLine()).toBe('Nothing to undo.');

  await v.canvasKey('Control+y');
  expect((await v.session()).edits?.[schema]?.description).toBe('edited by the e2e suite');
  await v.canvasKey('Control+Shift+z');
  expect((await v.session()).removed?.atoms).toEqual([schema]);
  await v.canvasKey('Control+y');
  expect((await v.made()).map((m) => m.key)).toEqual([made]);
  await v.canvasKey('Control+y');
  expect(await v.lastLine()).toBe('Nothing to redo.');
});

test('typing in one field is one step; Revert is a step too', async ({ v }) => {
  const schema = v.key('schema', 'gateA-sample-compatible');
  await v.pin(schema);
  await v.park();
  await v.field('description').click();
  await v.page.keyboard.type(' more words', { delay: 20 });
  await v.page.waitForTimeout(300);
  // the session is written ~300 ms after a change: read it by polling
  const edit = async () => (await v.session()).edits?.[schema]?.description;
  await v.inspector().getByRole('button', { name: 'Revert' }).click();
  await expect.poll(edit).toBeUndefined();
  await v.canvasKey('Control+z');
  await expect.poll(edit).toMatch(/ more words$/);
  await v.canvasKey('Control+z');
  await expect.poll(edit).toBeUndefined();
});

test('a refresh keeps the draft and its history: Ctrl+Z still walks it back', async ({ v }) => {
  const schema = v.key('schema', 'gateA-badconfig-clash');
  await v.pin(schema);
  await v.canvasKey('Delete');
  const made = await v.make('schema');
  await v.fill({ name: 'e2e-kept' });

  await v.refresh();
  const s = await v.session();
  expect(s.removed?.atoms).toEqual([schema]);
  expect((s.created ?? []).map((c: { key: string }) => c.key)).toEqual([made]);
  expect(s.edits?.[made]?.name).toBe('e2e-kept');
  await expect(v.page.locator('.doctab.dirty')).toHaveCount(1);

  await v.canvasKey('Control+z'); // the name
  await v.canvasKey('Control+z'); // the made schema
  expect(await v.made()).toHaveLength(0);
  await v.canvasKey('Control+z'); // the delete
  expect(await v.removed()).toEqual({ atoms: [], arrows: [] });
  await v.refresh();
  // undone on refresh too, and redo is still there
  expect(await v.removed()).toEqual({ atoms: [], arrows: [] });
  await v.canvasKey('Control+y');
  expect((await v.session()).removed?.atoms).toEqual([schema]);
});

test('the view is kept in this browser: a turn, a slide and a moved atom come back after a refresh', async ({ v }) => {
  // a turn, a slide and an atom moved by Ctrl+drag; the view is reported once it holds still (400 ms), saved 300 ms later
  const e = await v.empty();
  await v.drag(e, { x: e.x + 60, y: e.y - 20 }, { steps: 8 });
  await v.page.waitForTimeout(600);
  const e2 = await v.empty();
  await v.drag(e2, { x: e2.x + 90, y: e2.y - 40 }, { ctrl: true });
  const key = v.key('wf', 'simple-abc');
  const p = await v.spot(key);
  await v.drag(p, { x: p.x + 50, y: p.y + 30 }, { ctrl: true });
  await v.park();
  await v.page.waitForTimeout(1200);
  expect((await v.session()).view).toBeTruthy();

  const cam = await v.camera(), before = await v.atoms();
  await v.refresh();
  // the view keeps the camera to 4 decimals
  const now = (await v.camera()).split(',').map(Number), was = cam.split(',').map(Number);
  expect(Math.max(...now.map((n, i) => Math.abs(n - was[i]!)))).toBeLessThan(0.001);
  const after = await v.atoms();
  const worst = Math.max(...Object.keys(before).map((k) => Math.hypot(after[k]!.x - before[k]!.x, after[k]!.y - before[k]!.y)));
  expect(worst).toBeLessThan(1);
  // a move by hand is no step of the history (wand only, the user's choice)
  await v.canvasKey('Control+z');
  expect(await v.lastLine()).toBe('Nothing to undo.');
});

test('the pin and the filter\'s picks survive a refresh', async ({ v }) => {
  const key = v.key('wf', 'simple-abc');
  await v.pin(key);
  await v.page.locator('.menubar .wfsel-b').click();
  await v.page.locator('.wfsel-list [role=option]', { hasText: 'simple-abc' }).click();
  await v.page.keyboard.press('Escape');
  await v.refresh();
  expect(await v.pinned()).toBe(key);
  await expect(v.page.locator('.menubar .wfsel-n')).toHaveText('1 highlighted');
});

test('Ctrl+Z follows the physical Z key (a Hebrew layout types ז)', async ({ v }) => {
  const schema = v.key('schema', 'gateA-sample-compatible');
  await v.pin(schema);
  await v.fill({ description: 'to undo' });
  await v.page.evaluate(() => {
    const el = [...document.querySelectorAll('.mol')].find((e) => (e as unknown as { __molecule?: unknown }).__molecule) as HTMLElement;
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ז', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await v.page.waitForTimeout(400);
  expect(await v.lastLine()).toMatch(/^Undid: edit description/);
});
