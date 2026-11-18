import { test, expect } from './fixtures';
import {
  caNode, cacheTool, clearOutput, drawCacheLink, drawEntry, drawWire, dropTool, entryEdge, field, openAt, out, outLine, payloadOf, pickEdge, pickStep, pickWorkflow, pretty, regionPoint,
  renameTo, save, saveButton, stNode, toolboxStep, waitLoaded, wfNode, wireEdge, workflowTool, PROC_A, PROC_B,
} from './helpers';
import { seed } from './seed';
import { API, apply, bodyOf, getJson, type Row } from './stack';

// Spec §8: the one board-wide Save (BaseAPI's /model/apply, all or nothing), its dry run and the Kibana diagram, and the shared payload's
// copy-on-write. The throwaway rows are named e2e- (the guard refuses a create under any other name).
// The first Save of a run also writes Acto's placed locations of real rows that had none (ruling R5): location only, checked by the guard
// and again by global-teardown against the snapshot taken before the run.

const named = async <T extends Row>(table: string, name: string) => (await getJson<T[]>(`/${table}`)).find((r) => r.name === name);
const svg = async (id: string) => {
  const r = await fetch(`${API}/workflows/${id}.svg`);
  return { status: r.status, text: r.ok ? await r.text() : '' };
};

test('Save writes everything the board holds, and a reload shows it back where it was', async ({ page }) => {
  await openAt(page);
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 130 }));
  await renameTo(page, 'e2e-save-wf');
  await field(page, 'Description').fill('saved by the e2e suite');
  const s1 = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 400, y: 130 }));
  await renameTo(page, 'e2e-save-first');
  const s2 = await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 700, y: 130 }));
  await renameTo(page, 'e2e-save-second');
  const cache = await dropTool(page, cacheTool(page), 'cache', await regionPoint(page, { x: 200, y: 360 }));
  await renameTo(page, 'e2e-save-cache');
  await field(page, 'Items').fill('{"k": "v"}');
  await field(page, 'Root').fill('e2e-root');
  await drawWire(page, stNode(page, s1), stNode(page, s2));
  await drawEntry(page, wfNode(page, wf), stNode(page, s1));
  await drawCacheLink(page, wfNode(page, wf), caNode(page, cache));
  // a payload on the first step, typed with the triangle selected
  await pickWorkflow(page, wf);
  await pickStep(page, s1);
  await (await payloadOf(page, 'e2e-save-wf')).fill('{"saved": "yes"}');
  await expect(saveButton(page)).toHaveClass(/primary/);
  await expect(saveButton(page)).toContainText('Save ·');
  const before = {
    wf: (await wfNode(page, wf).boundingBox())!, s1: (await stNode(page, s1).boundingBox())!, cache: (await caNode(page, cache).boundingBox())!,
  };

  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(outLine(page, /^Saved \d+ changes?$/)).toHaveCount(1);
  await expect(outLine(page, 'e2e-save-wf: Kibana diagram published')).toHaveCount(1);
  await expect(saveButton(page)).toHaveText('Save');
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.locator('.unsaved-mark')).toHaveCount(0);

  // BaseAPI holds all of it
  const w = (await named('workflows', 'e2e-save-wf'))!;
  const a = (await named('steps', 'e2e-save-first'))!;
  const b = (await named('steps', 'e2e-save-second'))!;
  const c = (await named('caches', 'e2e-save-cache'))!;
  expect(w, 'workflow saved').toBeTruthy();
  expect(w.description).toBe('saved by the e2e suite');
  expect(w.entryStepIds).toEqual([a.id]);
  expect(w.cacheIds).toEqual([c.id]);
  expect(a.nextStepIds).toEqual([b.id]);
  expect(c.items).toBe('{"k": "v"}');
  const asg = (await getJson<Row[]>('/assignments')).filter((x) => (w.assignmentIds as string[]).includes(x.id));
  expect(asg.map((x) => [x.stepId, x.payload])).toEqual([[a.id, '{"saved": "yes"}']]);
  for (const r of [w, a, b, c]) expect(typeof r.boardX, `${r.name} was saved with a location`).toBe('number');
  expect((await svg(w.id as string)).status).toBe(200);

  // reload: the same items, the same places, nothing unsaved
  await page.reload();
  await waitLoaded(page);
  await expect(wfNode(page, w.id as string).locator('.tri-nm')).toHaveText('e2e-save-wf');
  await expect(stNode(page, a.id as string).locator('.sn')).toHaveText('e2e-save-first');
  await expect(stNode(page, b.id as string).locator('.sn')).toHaveText('e2e-save-second');
  await expect(caNode(page, c.id as string).locator('.cache-nm')).toHaveText('e2e-save-cache');
  await expect(entryEdge(page, w.id as string, a.id as string)).toHaveCount(1);
  await expect(wireEdge(page, a.id as string, b.id as string)).toHaveCount(1);
  await expect(page.locator(`.react-flow__edge[data-id="cache:${w.id}:${c.id}"]`)).toHaveCount(1);
  await expect(page.locator('.unsaved-mark')).toHaveCount(0);
  await expect(saveButton(page)).toBeDisabled();
  const near = (x: { x: number; y: number }, y: typeof x, what: string) => {
    expect(Math.abs(x.x - y.x), `${what} x`).toBeLessThanOrEqual(1);
    expect(Math.abs(x.y - y.y), `${what} y`).toBeLessThanOrEqual(1);
  };
  near((await wfNode(page, w.id as string).boundingBox())!, before.wf, 'triangle');
  near((await stNode(page, a.id as string).boundingBox())!, before.s1, 'step');
  near((await caNode(page, c.id as string).boundingBox())!, before.cache, 'cache');
  await pickWorkflow(page, w.id as string);
  await pickStep(page, a.id as string);
  await expect(await payloadOf(page, 'e2e-save-wf')).toHaveValue(pretty('{"saved": "yes"}'));
});

test('a Save BaseAPI refuses (a new triangle with no entry arrow) saves nothing, names the item, and keeps the board as it was', async ({ page }) => {
  await openAt(page);
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 130 }));
  await renameTo(page, 'e2e-refuse-wf');
  const step = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 450, y: 130 }));
  await renameTo(page, 'e2e-refuse-step');
  const label = await saveButton(page).innerText();

  const answer = await save(page);
  expect(answer.applied).toBe(false);
  // BaseAPI's own answer, on a line of its own, and the triangle carries the failure outline
  const err = out(page).locator('.k-err').first();
  await expect(err).toBeVisible();
  await expect(err).toContainText('workflow e2e-refuse-wf:');
  await expect(err).toContainText(/entry/i);
  test.info().annotations.push({ type: 'refusal', description: await err.innerText() });
  await expect(wfNode(page, wf).locator('.tri')).toHaveClass(/\bfailed\b/);
  // nothing was saved, nothing was lost: still unsaved, same count, and BaseAPI has none of it
  await expect(saveButton(page)).toHaveText(label);
  await expect(saveButton(page)).toBeEnabled();
  await expect(wfNode(page, wf).locator('.unsaved-mark')).toBeVisible();
  await expect(stNode(page, step).locator('.unsaved-mark')).toBeVisible();
  expect(await named('workflows', 'e2e-refuse-wf')).toBeUndefined();
  expect(await named('steps', 'e2e-refuse-step')).toBeUndefined();

  // draw the arrow the rule asks for: the next Save passes, as a whole
  await drawEntry(page, wfNode(page, wf), stNode(page, step));
  await expect(entryEdge(page, wf, step)).toHaveCount(1);
  const again = await save(page);
  expect(again.applied).toBe(true);
  await expect(saveButton(page)).toHaveText('Save');
  // the saved triangle has BaseAPI's id now, and no failure outline
  await expect(wfNode(page, again.made![wf]!).locator('.tri')).toBeVisible();
  await expect(wfNode(page, again.made![wf]!).locator('.tri')).not.toHaveClass(/failed/);
  expect(await named('workflows', 'e2e-refuse-wf')).toBeTruthy();
  expect(await named('steps', 'e2e-refuse-step')).toBeTruthy();
});

test('a shared payload is copied on write: editing A\'s payload where the row is shared leaves B\'s alone, after a Save and a reload', async ({ page }) => {
  // two workflows entering the same step, both given a payload through the board and saved
  const id = await seed({
    steps: [{ key: 's', name: 'e2e-share-step', at: { x: 300, y: 120 } }],
    workflows: [
      { key: 'a', name: 'e2e-share-a', at: { x: 0, y: 20 }, entry: ['s'] },
      { key: 'b', name: 'e2e-share-b', at: { x: 0, y: 220 }, entry: ['s'] },
    ],
  });
  await openAt(page);
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.s!);
  await (await payloadOf(page, 'e2e-share-a')).fill('{"owner": "a", "n": 1}');
  await pickWorkflow(page, id.b!);
  await pickStep(page, id.s!);
  await (await payloadOf(page, 'e2e-share-b')).fill('{"owner": "b"}');
  await save(page);
  await expect(saveButton(page)).toBeDisabled();
  const wa = (await getJson<Row>(`/workflows/${id.a}`));
  const wb = (await getJson<Row>(`/workflows/${id.b}`));
  expect((wa.assignmentIds as string[]).length).toBe(1);
  expect((wb.assignmentIds as string[]).length).toBe(1);
  expect(wa.assignmentIds).not.toEqual(wb.assignmentIds);

  // make the row shared through the API: B links A's assignment, and its own is deleted
  const sharedId = (wa.assignmentIds as string[])[0]!;
  const bOwn = (wb.assignmentIds as string[])[0]!;
  await apply([
    { op: 'update', table: 'workflows', id: id.b!, row: { ...bodyOf(wb), assignmentIds: [sharedId] }, updatedAt: wb.updatedAt as string },
    { op: 'delete', table: 'assignments', id: bOwn },
  ]);
  await page.reload();
  await waitLoaded(page);
  await pickWorkflow(page, id.b!);
  await pickStep(page, id.s!);
  await expect(await payloadOf(page, 'e2e-share-b')).toHaveValue(pretty('{"owner": "a", "n": 1}'));
  const sharedBefore = await getJson<Row>(`/assignments/${sharedId}`);

  // edit A's payload where the row is shared, then Save and reload
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.s!);
  await expect(await payloadOf(page, 'e2e-share-a')).toHaveValue(pretty('{"owner": "a", "n": 1}'));
  await field(page, 'Payload').fill('{"owner": "a", "n": 2, "edited": true}');
  await expect(wfNode(page, id.a!).locator('.unsaved-mark')).toBeVisible();
  await expect(wfNode(page, id.b!).locator('.unsaved-mark')).toHaveCount(0);
  await save(page);
  await expect(saveButton(page)).toBeDisabled();
  await page.reload();
  await waitLoaded(page);

  await pickWorkflow(page, id.b!);
  await pickStep(page, id.s!);
  await expect(await payloadOf(page, 'e2e-share-b'), 'B keeps the shared row as it was').toHaveValue(pretty('{"owner": "a", "n": 1}'));
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.s!);
  await expect(await payloadOf(page, 'e2e-share-a')).toHaveValue(pretty('{"owner": "a", "n": 2, "edited": true}'));
  // in BaseAPI: B still links the original row, untouched; A links a row of its own
  const wa2 = await getJson<Row>(`/workflows/${id.a}`);
  const wb2 = await getJson<Row>(`/workflows/${id.b}`);
  expect(wb2.assignmentIds).toEqual([sharedId]);
  expect(wa2.assignmentIds).toHaveLength(1);
  expect(wa2.assignmentIds).not.toEqual([sharedId]);
  const original = await getJson<Row>(`/assignments/${sharedId}`);
  expect(original.payload).toBe(sharedBefore.payload);
  expect(original.updatedAt).toBe(sharedBefore.updatedAt);
});

test('the dry run after a Save marks a triangle whose saved graph fails, and its next clean dry run clears the mark', async ({ page }) => {
  await openAt(page);
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 130 }));
  await renameTo(page, 'e2e-dry-wf');
  const s1 = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 400, y: 130 }));
  await renameTo(page, 'e2e-dry-first');
  const s2 = await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 700, y: 130 }));
  await renameTo(page, 'e2e-dry-second');
  // a cycle: it saves (BaseAPI's CRUD rules allow it), the start gates do not
  await drawWire(page, stNode(page, s1), stNode(page, s2));
  await drawWire(page, stNode(page, s2), stNode(page, s1));
  await drawEntry(page, wfNode(page, wf), stNode(page, s1));
  await expect(wireEdge(page, s2, s1)).toHaveCount(1);

  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(outLine(page, /^e2e-dry-wf: .*/).filter({ hasNotText: 'Kibana' }).first()).toBeVisible();
  const problems = wfNode(page, answer.made![wf]!).locator('.tri-problems');
  await expect(problems).toBeVisible();
  expect(Number(await problems.innerText())).toBeGreaterThan(0);
  await expect(out(page).locator('.k-warn').first()).toContainText('e2e-dry-wf:');
  test.info().annotations.push({ type: 'dry run', description: await out(page).locator('.k-warn').first().innerText() });
  // saved all the same
  expect(await named('workflows', 'e2e-dry-wf')).toBeTruthy();

  // break the cycle: remove the wire, Save: a clean dry run clears the badge
  // the rows have BaseAPI's ids now
  const [a, b] = [answer.made![s1]!, answer.made![s2]!];
  await pickEdge(page, wireEdge(page, b, a));
  await page.getByRole('toolbar', { name: 'wire actions' }).getByRole('button', { name: 'Delete' }).click();
  await expect(wireEdge(page, b, a)).toHaveCount(0);
  await save(page);
  await expect(problems).toHaveCount(0);
  await expect(outLine(page, 'e2e-dry-wf: Kibana diagram published')).toHaveCount(1);
});

test('a Save that changes a shared step republishes the Kibana diagram of both workflows that share it', async ({ page }) => {
  const id = await seed({
    steps: [
      { key: 's', name: 'e2e-kib-step', at: { x: 300, y: 120 } },
      { key: 'only', name: 'e2e-kib-only-b', at: { x: 600, y: 220 } },
    ],
    workflows: [
      { key: 'a', name: 'e2e-kib-a', at: { x: 0, y: 20 }, entry: ['s'] },
      { key: 'b', name: 'e2e-kib-b', at: { x: 0, y: 220 }, entry: ['s', 'only'] },
    ],
  });
  const was = { a: await svg(id.a!), b: await svg(id.b!) };
  for (const w of [was.a, was.b]) expect(w.text).not.toContain('e2e-kib-step-renamed');

  await openAt(page);
  await pickStep(page, id.s!);
  await field(page, 'Name').fill('e2e-kib-step-renamed');
  await save(page);
  await expect(outLine(page, 'e2e-kib-a: Kibana diagram published')).toHaveCount(1);
  await expect(outLine(page, 'e2e-kib-b: Kibana diagram published')).toHaveCount(1);

  const now = { a: await svg(id.a!), b: await svg(id.b!) };
  for (const k of ['a', 'b'] as const) {
    expect(now[k].status, `${k}.svg`).toBe(200);
    expect(now[k].text, `${k}.svg changed`).not.toBe(was[k].text);
    expect(now[k].text).toContain('<svg');
    expect(now[k].text, `${k}.svg shows the renamed step`).toContain('e2e-kib-step-renamed');
  }
  // each diagram is that workflow's own: the step only B reaches is in B's drawing, not in A's
  expect(now.b.text).toContain('e2e-kib-only-b');
  expect(now.a.text).not.toContain('e2e-kib-only-b');
  await clearOutput(page);
});
