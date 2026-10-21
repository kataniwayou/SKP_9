import { LIVE } from './standin';
import { expect, test } from './valence';

// Processor health (spec 2026-10-18): BaseApi's liveness every 5 s; live → green glow inside the processor's outline,
// listed but not live → red, not listed or no answer → grey. Only processors glow. Health answers are the stand-in's.

const GREEN = '#4ade80', RED = '#ff5a5a', GREY = '#9aa3b2';

test.skip(LIVE, 'the health answers are the stand-in\'s');

test('each processor glows by BaseApi\'s answer; no other atom glows; a change shows within a poll, with its Output line', async ({ v }) => {
  const procs = v.api.project.processors.map((p) => `proc:${p.id}`);
  await expect.poll(async () => (await v.glow(procs[0]!))?.color, { timeout: 12_000 }).toBe(GREEN);
  for (const k of procs) expect((await v.glow(k))?.color).toBe(GREEN);
  const others = Object.keys(await v.atoms()).filter((k) => !k.startsWith('proc:'));
  for (const k of others.slice(0, 20)) expect((await v.glow(k))?.glow ?? 0).toBe(0);

  const fetcher = v.api.project.processors.find((p) => p.name === 'file-fetcher')!;
  v.api.liveness!.set(fetcher.id, { live: false, healthy: 0, replicas: 2 });
  await expect.poll(async () => (await v.glow(`proc:${fetcher.id}`))?.color, { timeout: 12_000 }).toBe(RED);
  expect(await v.said(/^Health: file-fetcher/)).toMatch(/unhealthy/);

  // hovered: the Inspector's Health line, red
  const p = await v.spot(`proc:${fetcher.id}`);
  await v.page.mouse.move(p.x, p.y, { steps: 4 });
  await expect(v.inspector().locator('.insp-health.unhealthy')).toContainText('Unhealthy · no healthy replica');
  await v.park();

  // not listed → grey
  v.api.liveness!.delete(fetcher.id);
  await expect.poll(async () => (await v.glow(`proc:${fetcher.id}`))?.color, { timeout: 12_000 }).toBe(GREY);
});

test('BaseApi not answering: every processor grey, said once; answering again: back to its colour', async ({ v }) => {
  const k = `proc:${v.api.project.processors[0]!.id}`;
  await expect.poll(async () => (await v.glow(k))?.color, { timeout: 12_000 }).toBe(GREEN);
  const saved = v.api.liveness;
  v.api.liveness = null;
  await expect.poll(async () => (await v.glow(k))?.color, { timeout: 12_000 }).toBe(GREY);
  await v.page.waitForTimeout(5500);
  expect((await v.output()).filter((l) => /^Health: not known/.test(l))).toHaveLength(1);
  v.api.liveness = saved;
  await expect.poll(async () => (await v.glow(k))?.color, { timeout: 12_000 }).toBe(GREEN);
  expect(await v.output()).toContain('Health: BaseApi answers again');
});
