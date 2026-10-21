import { expect, test } from './valence';

// Deleting (spec §6a–§6c). The user's rule #1: an atom is deletable only when no arrow points to it, relaxed on 2026-10-16
// to "every arrow pointing at it is a deletable one" (those go with it). Refused: an incoming step → processor or
// assignment → step arrow (re-point only), or being a workflow's only entry step. Deletes are virtual: red ghosts.

const RED = '#ff5a5a';

test('a processor that steps run on cannot be deleted: Output says which arrows hold it', async ({ v }) => {
  const proc = v.key('proc', 'archive-expander');
  await v.pin(proc);
  await expect(v.inspector().locator('.insp-delete.no')).toContainText('cannot be deleted');
  await v.canvasKey('Delete');
  expect(await v.lastLine()).toMatch(/^archive-expander cannot be deleted: 2 arrows that can only be re-pointed point to it — .*\(Step → Processor\)/);
  expect(await v.removed()).toEqual({ atoms: [], arrows: [] });
});

test('a schema nothing points to is deleted alone; a schema processors point to goes with those arrows', async ({ v }) => {
  // kafka-importer-config: one processor's config slot points to it; gateA-sample-compatible: nothing does
  const used = v.key('schema', 'kafka-importer-config');
  const unused = v.key('schema', 'gateA-sample-compatible');
  await v.pin(unused);
  await expect(v.inspector().locator('.insp-delete.ok')).toBeVisible();
  await v.canvasKey('Delete');
  expect(await v.lastLine()).toBe('Deleted schema gateA-sample-compatible in Valence (not applied).');
  expect((await v.session()).removed?.atoms).toEqual([unused]);

  await v.pin(used);
  await v.canvasKey('Delete');
  expect(await v.lastLine()).toMatch(/^Deleted schema kafka-importer-config in Valence \(not applied\); 1 arrow went with it\.$/);
  const s = await v.session();
  expect(s.removed?.atoms).toEqual([unused, used]);
  await expect(v.page.locator('.doctab.dirty')).toHaveCount(1);
});

test('a deleted atom is a red ghost, read-only in the Inspector until undone', async ({ v }) => {
  const key = v.key('schema', 'gateA-badconfig-clash');
  await v.pin(key);
  await v.canvasKey('Delete');
  await v.park();
  expect(await v.halo(key)).toBe(RED);
  await expect(v.inspector().locator('.insp-virtual.ghost')).toContainText('Deleted in Valence only, not applied');
  await expect(v.field('name')).not.toBeEditable();

  await v.canvasKey('Control+z');
  expect(await v.lastLine()).toBe('Undid: delete schema gateA-badconfig-clash.');
  expect(await v.halo(key)).not.toBe(RED);
  await expect(v.field('name')).toBeEditable();
});

test('a workflow\'s only entry step cannot be deleted', async ({ v }) => {
  const wf = v.api.project.workflows.find((w) => w.name === 'simple-abc')!;
  const entry = `step:${(wf.entryStepIds as string[])[0]}`;
  await v.pin(entry);
  await v.canvasKey('Delete');
  // either the entry rule or an assignment holding it refuses it; both are rule #1 working
  expect(await v.lastLine()).toMatch(/cannot be deleted: (it is the only entry step of simple-abc|.*can only be re-pointed)/);
  expect(await v.removed()).toEqual({ atoms: [], arrows: [] });
});

test('an arrow is pinned by a click and deleted on its own; a step → processor arrow can only be re-pointed', async ({ v }) => {
  // the cache arrow of filefetcher-archiveexpander-chain: hover finds it along its shaft
  const wf = v.api.project.workflows.find((w) => w.name === 'filefetcher-archiveexpander-chain')!;
  const from = `wf:${wf.id}`, to = `cache:${(wf.cacheIds as string[])[0]}`;
  const key = `wfCache|${from}|${to}`;
  await v.pinArrow('wfCache', from, to);
  await expect(v.inspector()).toContainText('If deleted');
  await v.canvasKey('Delete');
  expect(await v.lastLine()).toMatch(/^Deleted the arrow filefetcher-archiveexpander-chain → .* \(Workflow → Cache\) in Valence \(not applied\)\.$/);
  expect((await v.session()).removed?.arrows).toEqual([key]);
  // the cache now has nothing pointing at it: it can be deleted
  await v.pin(to);
  await expect(v.inspector().locator('.insp-delete.ok')).toBeVisible();

  // a step → processor arrow, through the arrow's own verdict
  const step = v.api.project.steps.find((s) => s.processorId === v.api.project.processors.find((p) => p.name === 'archive-expander')!.id)!;
  const sk = `step:${step.id}`, pk = v.key('proc', 'archive-expander');
  await v.pinArrow('uses', sk, pk);
  await v.canvasKey('Delete');
  expect(await v.lastLine()).toMatch(/^Step → Processor can only be re-pointed, not deleted: the column steps\.processor_id is NOT NULL\.$/);
});

test('Delete typed in an Inspector field edits the field, it deletes nothing', async ({ v }) => {
  const key = v.key('schema', 'gateA-sample-compatible');
  await v.pin(key);
  await v.park();
  await v.field('description').click();
  await v.page.keyboard.press('End');
  await v.page.keyboard.press('Delete');
  await v.page.waitForTimeout(300);
  expect(await v.removed()).toEqual({ atoms: [], arrows: [] });
});

test("two made steps that are each other's next step: Delete takes one back with the drawn arrows touching it", async ({ v }) => {
  // a loop is allowed to draw; made atoms are not held by rule #1, a Delete takes them back
  const proc = v.key('proc', 'archive-expander');
  const a = await v.make('step', proc);
  await v.fill({ name: 'e2e-loop-a' });
  const b = await v.make('step', proc);
  await v.fill({ name: 'e2e-loop-b' });
  await v.draw('next', a, b);
  await v.draw('next', b, a);
  expect(await v.arrowOn('next', a, b)).toBe(true);
  expect(await v.arrowOn('next', b, a)).toBe(true);
  await v.pin(a);
  await v.canvasKey('Delete');
  expect(await v.lastLine()).toMatch(/^Took back the new step e2e-loop-a/);
  expect(await v.arrowOn('next', b, a)).toBe(false);
});
