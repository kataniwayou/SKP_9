import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { entryEdge, openAt, openFitted, stNode, wfNode, wireEdge } from './helpers';
import { seed } from './seed';

// Plan 6 (inspector-tabs spec §3): dashes move only where a running workflow reaches: its entry arrows, the wires it reaches through and the
// green ring of the steps it reaches. Nothing is ever started or stopped: the throwaway workflows are stopped, a real running workflow is only
// looked at, and "running" for a throwaway is faked by a stub of the live read (GET /orchestration/live) with the liveness hub closed.

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-mo-first', at: { x: 300, y: 80 }, next: ['s2'] },
    { key: 's2', name: 'e2e-mo-second', at: { x: 600, y: 80 } },
    { key: 's3', name: 'e2e-mo-other', at: { x: 300, y: 300 }, next: ['s4'] },
    { key: 's4', name: 'e2e-mo-other-next', at: { x: 600, y: 300 } },
  ],
  workflows: [
    { key: 'w', name: 'e2e-mo-wf', at: { x: 0, y: 40 }, entry: ['s1'], entryCrons: { s1: '0 * * * * *' } },
    { key: 'v', name: 'e2e-mo-still', at: { x: 0, y: 260 }, entry: ['s3'], entryCrons: { s3: '0 * * * * *' } },
  ],
} as const;

// [user, 2026-11-25] an entry arrow that never fires stays still while its workflow runs: one into a Never entry step (frozen, even with a
// cron) and one with no cron (unscheduled); neither the step nor anything only it leads to rings. The control arrow is scheduled.
const IDLE_SEED = {
  steps: [
    { key: 'f', name: 'e2e-mo-frozen', at: { x: 300, y: 60 }, next: ['f2'], condition: 5 },
    { key: 'f2', name: 'e2e-mo-after-frozen', at: { x: 600, y: 60 } },
    { key: 'u', name: 'e2e-mo-unscheduled', at: { x: 300, y: 240 }, next: ['u2'] },
    { key: 'u2', name: 'e2e-mo-after-unscheduled', at: { x: 600, y: 240 } },
    { key: 'k', name: 'e2e-mo-scheduled', at: { x: 300, y: 420 } },
  ],
  workflows: [
    { key: 'w', name: 'e2e-mo-idle', at: { x: 0, y: 220 }, entry: ['f', 'u', 'k'], entryCrons: { f: '0 * * * * *', k: '0 * * * * *' } },
  ],
} as const;

/** The live read answers with these ids added (a read stub: nothing is started), and the hub is refused so the store polls. */
async function fakeRunning(page: Page, ids: () => string[]) {
  await page.routeWebSocket('**/api/hubs/liveness', (ws) => { ws.close(); });
  await page.route('**/api/v1/orchestration/live', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const answer = await route.fetch();
    const real = (await answer.json().catch(() => [])) as string[];
    return route.fulfill({ response: answer, json: [...real, ...ids()] });
  });
}

const status = (page: Page, wf: string) => wfNode(page, wf).locator('.tri-st');

async function stillAll(page: Page, id: Record<string, string>, wf: string, entry: string, wire: [string, string], steps: string[]) {
  await expect(wfNode(page, wf).locator('.tri')).toHaveClass(/\bstopped\b/);
  await expect(wfNode(page, wf).locator('.tri-ring')).toHaveCount(0);
  await expect(status(page, wf)).toHaveText('■ stopped');
  await expect(entryEdge(page, wf, entry).locator('.entry-line')).not.toHaveClass(/\brunning\b/);
  await expect(wireEdge(page, wire[0], wire[1]).locator('.wire')).not.toHaveClass(/\brunning\b/);
  for (const s of steps) await expect(stNode(page, s).locator('.node')).not.toHaveClass(/\brunning\b/);
  void id;
}

test('stopped throwaway workflows: S1 triangles, and no running mark on their entry arrows, wires or step rings', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await expect(status(page, id.w!)).toHaveAttribute('data-status', 'stopped');
  await expect(status(page, id.v!)).toHaveAttribute('data-status', 'stopped');
  await stillAll(page, id, id.w!, id.s1!, [id.s1!, id.s2!], [id.s1!, id.s2!]);
  await stillAll(page, id, id.v!, id.s3!, [id.s3!, id.s4!], [id.s3!, id.s4!]);
  // the stopped look: slate fill and outline, the ■ inside
  const body = wfNode(page, id.w!).locator('.tri-body');
  expect(await body.evaluate((e) => getComputedStyle(e).fill)).toBe('rgb(241, 243, 247)');
  await expect(wfNode(page, id.w!).locator('.tri-stop')).toHaveCount(1);
  // no e2e edge is animated
  const e2eIds = [id.w!, id.v!, id.s1!, id.s2!, id.s3!, id.s4!];
  const moving = await page.locator('.react-flow__edge').evaluateAll((es, ids) => es.filter((e) => ids.some((i) => (e as HTMLElement).dataset.id!.includes(i))
    && (e.classList.contains('animated') || e.querySelector('.running') !== null)).length, e2eIds);
  expect(moving).toBe(0);
});

test('a real running workflow (looked at only): its triangle runs and its entry arrows and entry steps carry the running mark', async ({ page, request, stack }) => {
  const live = new Set(((await (await request.get('/api/v1/orchestration/live')).json()) as string[]).map((x) => x.toLowerCase()));
  // only an arrow that fires moves [user, 2026-11-25]: one into a Never step is frozen, one with no cron is unscheduled
  const never = new Set(stack.snapshot.steps.filter((s) => s.entryCondition === 5).map((s) => s.id as string));
  const real = stack.snapshot.workflows.map((w) => {
    const crons = (w.entryCrons ?? {}) as Record<string, string>;
    const idle = (s: string) => (never.has(s) ? 'frozen' : (crons[s] ?? '').trim() === '' ? 'unscheduled' : null);
    return { id: w.id, name: w.name, entry: ((w.entryStepIds as string[] | undefined) ?? []).map((s) => ({ s, idle: idle(s) })), running: live.has(w.id.toLowerCase()) };
  });
  const running = real.filter((w) => w.running);
  test.skip(running.length === 0, 'no real workflow runs on the stack');
  await openFitted(page);
  for (const w of running) {
    await expect(status(page, w.id), w.name).toHaveAttribute('data-status', 'running');
    await expect(status(page, w.id)).toHaveText('● running');
    await expect(wfNode(page, w.id).locator('.tri')).toHaveClass(/\brunning\b/);
    await expect(wfNode(page, w.id).locator('.tri-ring')).toHaveCount(1);
    for (const { s, idle } of w.entry) {
      if (idle) {
        // an arrow that never fires stays still and says why (its step may still ring if another firing path reaches it)
        await expect(entryEdge(page, w.id, s).locator('.entry-line'), `${w.name} ${idle} entry arrow`).not.toHaveClass(/\brunning\b/);
        await expect(entryEdge(page, w.id, s).locator('.entry-edge'), `${w.name} ${idle} entry arrow`).toHaveAttribute('data-idle', idle);
        continue;
      }
      await expect(entryEdge(page, w.id, s).locator('.entry-line'), `${w.name} entry arrow`).toHaveClass(/\brunning\b/);
      await expect(stNode(page, s).locator('.node'), `${w.name} entry step ring`).toHaveClass(/\brunning\b/);
    }
  }
  // a stopped real workflow's entry arrows stay still
  for (const w of real.filter((x) => !x.running)) {
    await expect(status(page, w.id), w.name).toHaveAttribute('data-status', 'stopped');
    for (const { s } of w.entry) await expect(entryEdge(page, w.id, s).locator('.entry-line'), `${w.name} entry arrow`).not.toHaveClass(/\brunning\b/);
  }
});

test('a throwaway faked running (stubbed live read): its entry arrow, the wire it reaches and its steps\' rings move; the other stays still', async ({ page }) => {
  const id = await seed(SEED);
  await fakeRunning(page, () => [id.w!]);
  await openAt(page);
  await expect(status(page, id.w!)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await expect(wfNode(page, id.w!).locator('.tri')).toHaveClass(/\brunning\b/);
  await expect(wfNode(page, id.w!).locator('.tri-ring')).toHaveCount(1);
  await expect(status(page, id.w!)).toHaveText('● running');
  await expect(entryEdge(page, id.w!, id.s1!).locator('.entry-line')).toHaveClass(/\brunning\b/);
  await expect(wireEdge(page, id.s1!, id.s2!).locator('.wire')).toHaveClass(/\brunning\b/);
  await expect(stNode(page, id.s1!).locator('.node')).toHaveClass(/\brunning\b/);
  await expect(stNode(page, id.s2!).locator('.node')).toHaveClass(/\brunning\b/);
  // the other throwaway is stopped: nothing of it moves
  await stillAll(page, id, id.v!, id.s3!, [id.s3!, id.s4!], [id.s3!, id.s4!]);
});

test('a running workflow\'s idle entry arrows stay still: frozen (Never step) and unscheduled (no cron), faded with a hollow head and the reason [user, 2026-11-25]', async ({ page }) => {
  const id = await seed(IDLE_SEED);
  await fakeRunning(page, () => [id.w!]);
  await openAt(page);
  await expect(status(page, id.w!)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });

  // the control: a scheduled arrow into a live step moves, and the step rings
  await expect(entryEdge(page, id.w!, id.k!).locator('.entry-line')).toHaveClass(/\brunning\b/);
  await expect(entryEdge(page, id.w!, id.k!).locator('.entry-edge')).not.toHaveAttribute('data-idle', /.*/);
  await expect(stNode(page, id.k!).locator('.node')).toHaveClass(/\brunning\b/);

  for (const [key, next, idle, label] of [['f', 'f2', 'frozen', 'frozen'], ['u', 'u2', 'unscheduled', '⏱ not scheduled']] as const) {
    const edge = entryEdge(page, id.w!, id[key]!);
    await expect(edge.locator('.entry-edge'), idle).toHaveAttribute('data-idle', idle);
    const line = edge.locator('.entry-line');
    await expect(line, idle).not.toHaveClass(/\brunning\b/);
    const look = await line.evaluate((e) => { const cs = getComputedStyle(e); return { dash: cs.strokeDasharray, anim: cs.animationName, opacity: cs.opacity }; });
    expect(look, idle).toEqual({ dash: 'none', anim: 'none', opacity: '0.45' });
    expect(await edge.locator('.entry-head').evaluate((e) => getComputedStyle(e).fill), idle).toBe('none');
    await expect(edge.locator('.entry-cron'), idle).toHaveText(label);
    // the step and what only it leads to do not ring, and the wire between them is still
    await expect(stNode(page, id[key]!).locator('.node'), idle).not.toHaveClass(/\brunning\b/);
    await expect(stNode(page, id[next]!).locator('.node'), idle).not.toHaveClass(/\brunning\b/);
    await expect(wireEdge(page, id[key]!, id[next]!).locator('.wire'), idle).not.toHaveClass(/\brunning\b/);
  }
  // frozen is said in Never's pink, the step's N pill colour; unscheduled in the muted label colour, italic
  expect(await entryEdge(page, id.w!, id.f!).locator('.entry-cron').evaluate((e) => getComputedStyle(e).fill)).toBe('rgb(219, 39, 119)');
  expect(await stNode(page, id.f!).locator('.cond-pill').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(219, 39, 119)');
  // ...and leads with the step card's N square: pink, the letter in the pill's ink; an unscheduled arrow has none
  const sq = entryEdge(page, id.w!, id.f!).locator('.entry-never-sq');
  await expect(sq.locator('text')).toHaveText('N');
  expect(await sq.locator('rect').evaluate((e) => getComputedStyle(e).fill)).toBe('rgb(219, 39, 119)');
  expect(await sq.locator('text').evaluate((e) => getComputedStyle(e).fill))
    .toBe(await stNode(page, id.f!).locator('.cond-pill').evaluate((e) => getComputedStyle(e).color));
  await expect(entryEdge(page, id.w!, id.u!).locator('.entry-never-sq')).toHaveCount(0);
  expect(await entryEdge(page, id.w!, id.u!).locator('.entry-cron').evaluate((e) => getComputedStyle(e).fontStyle)).toBe('italic');
  await page.screenshot({ path: test.info().outputPath('idle-entry-arrows.png') });
});
