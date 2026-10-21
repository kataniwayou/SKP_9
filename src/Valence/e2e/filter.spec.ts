import { expect, test, type Valence } from './valence';

// The Workflows filter on the menu strip (spec §3b): the picked workflows' reach stays bright, the rest fades (nothing is
// removed); hover and pin show their own neighbourhood on top, then the filter returns. Picks are kept in the session.

/** What a workflow reaches, as Valence's reachOf: entry steps and their next steps, their processors and those schemas, the workflow's assignments and caches. */
function reach(v: Valence, name: string): Set<string> {
  const p = v.api.project;
  const wf = p.workflows.find((w) => w.name === name)!;
  const out = new Set<string>([`wf:${wf.id}`]);
  const todo = [...(wf.entryStepIds as string[])];
  const steps = new Set<string>();
  for (let id = todo.shift(); id !== undefined; id = todo.shift()) {
    if (steps.has(id)) continue;
    steps.add(id);
    todo.push(...((p.steps.find((s) => s.id === id)?.nextStepIds as string[] | null) ?? []));
  }
  for (const id of steps) {
    out.add(`step:${id}`);
    const proc = p.processors.find((x) => x.id === p.steps.find((s) => s.id === id)!.processorId)!;
    out.add(`proc:${proc.id}`);
    for (const s of [proc.inputSchemaId, proc.outputSchemaId, proc.configSchemaId]) if (s) out.add(`schema:${s}`);
  }
  for (const a of (wf.assignmentIds as string[])) out.add(`asg:${a}`);
  for (const c of (wf.cacheIds as string[])) out.add(`cache:${c}`);
  return out;
}

/** The atoms drawn in full now (opacity 1), the rest faded. */
const bright = (v: Valence) => v.page.evaluate(() => {
  const el = [...document.querySelectorAll('.mol')].find((e) => (e as unknown as { __molecule?: unknown }).__molecule) as unknown as {
    __molecule: { atoms: Map<string, { mesh: { material: { opacity: number } } }> };
  };
  return [...el.__molecule.atoms].filter(([, a]) => a.mesh.material.opacity > 0.9).map(([k]) => k).sort();
});

const pick = async (v: Valence, name: string) => {
  if (!(await v.page.locator('.wfsel-list').count())) await v.page.locator('.menubar .wfsel-b').click();
  await v.page.locator('.wfsel-list [role=option]', { hasText: name }).first().click();
};

test('the list names every workflow; a pick keeps what it reaches bright and fades the rest', async ({ v }) => {
  const all = (await bright(v)).length;
  await v.page.locator('.menubar .wfsel-b').click();
  const names = await v.page.locator('.wfsel-list [role=option] b').allTextContents();
  expect(names.sort()).toEqual(v.api.project.workflows.map((w) => w.name).sort());

  await pick(v, 'filefetcher-archiveexpander-chain');
  await v.page.keyboard.press('Escape');
  await expect(v.page.locator('.wfsel-list')).toHaveCount(0);
  await v.park();
  await v.page.waitForTimeout(300);
  const lit = await bright(v);
  expect(lit).toEqual([...reach(v, 'filefetcher-archiveexpander-chain')].sort());
  expect(lit.length).toBeLessThan(all);
  await expect(v.page.locator('.menubar .wfsel-n')).toHaveText('1 highlighted');

  // a second pick joins its reach
  await pick(v, 'simple-abc');
  await v.page.mouse.click(10, 300); // a press outside closes the list
  await expect(v.page.locator('.wfsel-list')).toHaveCount(0);
  await v.park();
  await v.page.waitForTimeout(300);
  const both = new Set([...reach(v, 'filefetcher-archiveexpander-chain'), ...reach(v, 'simple-abc')]);
  expect(await bright(v)).toEqual([...both].sort());
});

test('hover shows the atom\'s neighbourhood over the filter, and the filter returns after', async ({ v }) => {
  await pick(v, 'simple-abc');
  await v.page.keyboard.press('Escape');
  await v.park();
  const filtered = await bright(v);
  const other = v.key('wf', 'sc-chain');
  const p = await v.spot(other);
  await v.page.mouse.move(p.x, p.y, { steps: 4 });
  await v.page.waitForTimeout(300);
  expect(await bright(v)).toContain(other);
  await v.park();
  await v.page.waitForTimeout(300);
  expect(await bright(v)).toEqual(filtered);
});

test('Clear brings everything back; the picks are kept on refresh until cleared', async ({ v }) => {
  const all = await bright(v);
  await pick(v, 'sc-chain');
  await v.page.keyboard.press('Escape');
  await v.refresh();
  await expect(v.page.locator('.menubar .wfsel-n')).toHaveText('1 highlighted');
  await v.page.locator('.menubar .wfsel-b').click();
  await v.page.locator('.wfsel-clear').click();
  await v.page.keyboard.press('Escape');
  await v.park();
  await v.page.waitForTimeout(300);
  await expect(v.page.locator('.menubar .wfsel-n')).toHaveText('none highlighted');
  expect(await bright(v)).toEqual(all);
});

test('the keyboard picks: Space or Enter on the focused workflow', async ({ v }) => {
  await v.page.locator('.menubar .wfsel-b').click();
  const first = v.page.locator('.wfsel-list [role=option]').first();
  await first.focus();
  await v.page.keyboard.press('Space');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await v.page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-selected', 'false');
});
