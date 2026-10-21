import { expect, test } from './valence';

// The Toolbox (spec "Toolbox", approved 2026-10-17): atom tiles are dropped (lone ones anywhere, the rest on their target),
// arrow tiles are dropped on their tail and then the head is clicked. Everything made is virtual until Apply.

const GREEN = '#4ade80', AMBER = '#fbbf24';

test('the Toolbox has six atom tiles and seven arrow tiles', async ({ v }) => {
  const tools = await v.page.locator('[data-pane="toolbox"] [data-tool]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tool));
  expect(tools).toEqual(['schema', 'cache', 'proc', 'step', 'asg', 'wf', 'entry', 'next', 'wfAsg', 'wfCache', 'input', 'output', 'config']);
});

test('the search finds a tile', async ({ v }) => {
  await v.page.getByRole('searchbox', { name: 'Search the toolbox' }).fill('cache');
  const shown = await v.page.locator('[data-pane="toolbox"] [data-tool]:visible').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tool));
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.every((t) => /cache/i.test(t ?? ''))).toBe(true);
});

test('a Schema dropped on empty canvas: made, pinned, unfinished until named, then a green halo and a dry run that passes', async ({ v }) => {
  const at = await v.empty();
  const ghost = await v.dragTile('schema', at);
  // over the canvas the ghost is the size the atom will be there
  expect(ghost?.sized).toBe(true);
  const made = await v.made();
  expect(made).toHaveLength(1);
  const key = made[0]!.key;
  expect(key.startsWith('schema:')).toBe(true);
  expect(await v.pinned()).toBe(key);
  expect(Math.abs(ghost!.px - (await v.atom(key)).px)).toBeLessThan(0.6);
  expect(await v.said(/^Made a new /)).toMatch(/^Made a new schema in Valence \(not applied\): fill in its fields in the Inspector\.$/);
  await expect(v.inspector().locator('.insp-virtual.made')).toContainText('unfinished: fill in');
  // made atoms breathe the green halo from the moment they land
  expect(await v.halo(key)).toBe(GREEN);

  const runs = v.api.dryRuns.length;
  await v.fill({ name: 'e2e-schema', definition: '{"type":"object","properties":{"id":{"type":"string"}}}' });
  await expect(v.inspector().locator('.insp-virtual.made')).toHaveText(/● New in Valence only, not applied/);
  await v.dryRunAfter(runs);
  const sent = v.api.dryRuns.at(-1)!;
  expect(sent.some((c) => c.op === 'create' && c.table === 'schemas' && c.row?.name === 'e2e-schema')).toBe(true);
  expect(await v.said(/^Dry run by BaseApi/)).toMatch(/all pass/);
  await expect(v.page.locator('.doctab.dirty')).toHaveCount(1);
  await expect(v.page.locator('.menubar .ap-b')).toHaveAttribute('aria-disabled', 'false');
});

test('a Step is dropped on a processor: on empty canvas it is refused, on the processor it is made with its processor arrow', async ({ v }) => {
  const ghost = await v.dragTile('step', await v.empty());
  expect(ghost?.refused).toBe(true);
  expect(await v.made()).toHaveLength(0);
  expect(await v.lastLine()).toMatch(/^A step is dropped on a processor/);

  const proc = v.key('proc', 'archive-expander');
  const step = await v.make('step', proc);
  expect(await v.arrowOn('uses', step, proc)).toBe(true);
  expect(await v.said(/^Made a new /)).toBe('Made a new step on archive-expander in Valence (not applied): fill in its fields in the Inspector.');
  // the processor's row does not change: no halo on it
  expect(await v.halo(proc)).toBeNull();
});

test('arrows are drawn tail first, then the head clicked: next step, entry step, assignment, cache', async ({ v }) => {
  test.setTimeout(180_000); // a dozen drags and fills under software WebGL
  const proc = v.key('proc', 'archive-expander');
  const s1 = await v.make('step', proc);
  await v.fill({ name: 'e2e-first' });
  const s2 = await v.make('step', proc);
  await v.fill({ name: 'e2e-second' });

  await v.draw('next', s1, s2);
  expect(await v.arrowOn('next', s1, s2)).toBe(true);
  // the names typed in the Inspector, as the canvas labels show them (fixed 2026-10-21)
  expect(await v.lastLine()).toBe('Drew e2e-first → e2e-second (Step → next Step) in Valence (not applied).');
  expect(await v.added()).toContain(`next|${s1}|${s2}`);

  // a next step onto itself is refused
  await v.draw('next', s2, s2);
  expect(await v.arrowOn('next', s2, s2)).toBe(false);

  // a Workflow dropped on a step: that step is its entry
  const wf = await v.make('wf', s1);
  expect(await v.arrowOn('entry', wf, s1)).toBe(true);
  await v.fill({ name: 'e2e-flow' });

  // an Assignment on a step, then the workflow → assignment arrow
  const asg = await v.make('asg', s2);
  expect(await v.arrowOn('asg', asg, s2)).toBe(true);
  await v.fill({ name: 'e2e-asg', payload: '{"mode":"full"}' });
  await v.draw('wfAsg', wf, asg);
  expect(await v.arrowOn('wfAsg', wf, asg)).toBe(true);

  // a Cache, drawn from an existing workflow: that workflow's row changes, so it breathes the amber update halo
  const cache = await v.make('cache');
  await v.fill({ name: 'e2e-cache', root: 'e2e-root', items: '{"seed":"1"}' });
  const abc = v.key('wf', 'simple-abc');
  const runs = v.api.dryRuns.length;
  await v.draw('wfCache', abc, cache);
  expect(await v.arrowOn('wfCache', abc, cache)).toBe(true);
  await v.park();
  await v.dryRunAfter(runs);
  expect(await v.halo(abc)).toBe(AMBER);
  // the dry run sees the new cache created and simple-abc updated with it
  const sent = v.api.dryRuns.at(-1)!;
  const abcId = abc.split(':')[1];
  expect(sent.some((c) => c.op === 'update' && c.table === 'workflows' && c.id === abcId)).toBe(true);
});

test('Escape cancels a tile drag and an arrow being drawn: nothing is made', async ({ v }) => {
  await v.dragTile('schema', await v.empty(), { escape: true });
  expect(await v.made()).toHaveLength(0);

  const proc = v.key('proc', 'archive-expander');
  const s = await v.make('step', proc);
  await v.dragTile('next', await v.spot(s));
  await expect(v.page.locator('[data-pane="toolbox"] .tb-aim')).toHaveCount(1);
  await v.page.keyboard.press('Escape');
  await expect(v.page.locator('[data-pane="toolbox"] .tb-aim')).toHaveCount(0);
  expect(await v.added()).toHaveLength(0);
});

test('a drop keeps the view: the camera and the slide stay where they were', async ({ v }) => {
  // slide the picture first (Ctrl+drag on empty canvas), then drop a schema
  const from = await v.empty();
  await v.drag(from, { x: from.x + 120, y: from.y - 60 }, { ctrl: true });
  const anchor = v.key('wf', 'simple-abc');
  const before = await v.atom(anchor), cam = await v.camera();
  await v.make('schema');
  const after = await v.atom(anchor);
  expect(await v.camera()).toBe(cam);
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1);
});
