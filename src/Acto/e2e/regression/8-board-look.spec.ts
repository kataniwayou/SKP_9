import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { captureDiagram, entryEdge, field, heart, openAt, save, selectWorkflowAlone, setCondition, stNode, wireEdge } from '../helpers';
import { seed } from '../seed';
import { getJson, type Row } from '../stack';

// Regression 8 (user, 2026-11-25): how the board looks after the 2026-11-25 changes. Processor health is a solid heart (beating
// when live, cracked when down, a question mark when nobody can say), in step cards and the toolbox. A wire wears its target's
// condition colour with no letter, and a wire into a Never step is faded with a hollow head. An entry arrow moves only when it
// fires: frozen (the step is Never) and unscheduled (no cron) arrows stay still and say why. The Kibana diagram a Save publishes
// draws the same way.
//
//            ┌─ S (cron, Completed) ─┬▶ C (Completed)
//    W ──────┤                       ├▶ X (Failed)
//            ├─ F (cron, Never)      └▶ N (Never)
//            └─ U (no cron)
//
// S, C, X, N run on archive-expander, F on file-fetcher, U on kafka-importer: three processors whose health the hearts test
// stubs as live, down and unreported.

const LIVE = 'archive-expander';
const DOWN = 'file-fetcher';
const UNREPORTED = 'kafka-importer';
const CRON = '0 * * * * *';
const COLOUR = { completed: 'rgb(15, 148, 136)', failed: 'rgb(224, 72, 47)', never: 'rgb(219, 39, 119)' } as const;
const HEALTH = { healthy: 'rgb(22, 163, 74)', unhealthy: 'rgb(220, 38, 38)', undetermined: 'rgb(148, 163, 184)' } as const;

const SEED = {
  steps: [
    { key: 'S', name: 'e2e-look-S', at: { x: 300, y: 40 }, processor: LIVE, next: ['C', 'X', 'N'] },
    { key: 'F', name: 'e2e-look-F', at: { x: 300, y: 220 }, processor: DOWN, condition: 5 },
    { key: 'U', name: 'e2e-look-U', at: { x: 300, y: 400 }, processor: UNREPORTED },
    { key: 'C', name: 'e2e-look-C', at: { x: 640, y: 0 }, processor: LIVE },
    { key: 'X', name: 'e2e-look-X', at: { x: 640, y: 140 }, processor: LIVE, condition: 2 },
    { key: 'N', name: 'e2e-look-N', at: { x: 640, y: 280 }, processor: LIVE, condition: 5 },
  ],
  workflows: [{ key: 'W', name: 'e2e-look-W', at: { x: 0, y: 200 }, entry: ['S', 'F', 'U'], entryCrons: { S: CRON, F: CRON } }],
} as const;

/** The app's own dark theme: its toggle sets html[data-theme] (it does not follow the system's colour scheme). */
async function darkTheme(page: Page) {
  await page.locator('button.theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

const style = (page: Page, selector: ReturnType<Page['locator']>, prop: 'stroke' | 'opacity' | 'fill' | 'color' | 'animationName' | 'fontStyle') =>
  selector.evaluate((e, p) => getComputedStyle(e)[p as 'stroke'], prop);

let id: Record<string, string>;
test.beforeEach(async () => { id = await seed(SEED); });

test('health hearts: a live heart beats, a down one is cracked, an unknown one asks', async ({ page }) => {
  const procs = await getJson<Row[]>('/processors');
  const pid = (name: string) => procs.find((p) => p.name === name)!.id;
  const row = (name: string, live: boolean) => ({
    processorId: pid(name), live, replicas: 1, healthy: live ? 1 : 0, absent: 0, unhealthy: live ? 0 : 1, stale: 0, malformed: 0,
  });
  // the hub refused, so the live store reads the processors' liveness by poll: answer it with one live, one down, one missing
  await page.routeWebSocket('**/api/hubs/liveness', (ws) => { ws.close(); });
  await page.route('**/api/v1/processors/liveness', (route) => (route.request().method() !== 'GET' ? route.fallback()
    : route.fulfill({ json: [row(LIVE, true), row(DOWN, false)] })));
  await openAt(page);

  const [live, down, unknown] = [heart(page, id.S!), heart(page, id.F!), heart(page, id.U!)];
  await expect(live).toHaveAttribute('data-health', 'healthy', { timeout: 20_000 });
  await expect(down).toHaveAttribute('data-health', 'unhealthy');
  await expect(unknown).toHaveAttribute('data-health', 'undetermined');
  expect(await style(page, live, 'color')).toBe(HEALTH.healthy);
  expect(await style(page, down, 'color')).toBe(HEALTH.unhealthy);
  expect(await style(page, unknown, 'color')).toBe(HEALTH.undetermined);
  // only the live heart beats
  expect(await style(page, live.locator('svg'), 'animationName')).toBe('heartbeat');
  expect(await style(page, down.locator('svg'), 'animationName')).toBe('none');
  expect(await style(page, unknown.locator('svg'), 'animationName')).toBe('none');
  // the crack and the question mark are cut out of the solid heart by a mask
  const cuts = (h: typeof live) => h.evaluate((e) => [...(e.querySelector('mask')?.children ?? [])].slice(1).map((c) => c.tagName));
  expect(await cuts(live)).toEqual([]);
  expect(await cuts(down)).toEqual(['path']);
  expect(await cuts(unknown)).toEqual(['path', 'circle']);
  await expect(live).toHaveAttribute('title', 'live · 1 of 1 replica healthy');
  // no beat for someone who asked for less motion
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await style(page, live.locator('svg'), 'animationName')).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // the toolbox's processor cards read the same
  const tool = (name: string) => page.getByTestId('toolbox-step').filter({ hasText: new RegExp(`^\\s*\\S?\\s*${name}`) }).first().getByTestId('health-dot');
  await expect(tool(LIVE)).toHaveAttribute('data-health', 'healthy');
  await expect(tool(DOWN)).toHaveAttribute('data-health', 'unhealthy');
  await expect(tool(UNREPORTED)).toHaveAttribute('data-health', 'undetermined');
  // the dark theme keeps the three hearts in their colours, and the live one still beats
  await darkTheme(page);
  expect(await style(page, live, 'color')).toBe(HEALTH.healthy);
  expect(await style(page, down, 'color')).toBe(HEALTH.unhealthy);
  expect(await style(page, unknown, 'color')).toBe(HEALTH.undetermined);
  expect(await style(page, live.locator('svg'), 'animationName')).toBe('heartbeat');
});

test('wires wear the target\'s condition colour with no letter; a wire into Never is faded with a hollow head', async ({ page }) => {
  await openAt(page);
  const w = (to: string) => wireEdge(page, id.S!, id[to]!);
  const checkColours = async () => {
    expect(await style(page, w('C').locator('path.wire'), 'stroke')).toBe(COLOUR.completed);
    expect(await style(page, w('X').locator('path.wire'), 'stroke')).toBe(COLOUR.failed);
    expect(await style(page, w('N').locator('path.wire'), 'stroke')).toBe(COLOUR.never);
  };
  await checkColours();
  await expect(page.locator('.link-wire .pill, .link-wire .pilltx')).toHaveCount(0);
  expect(await style(page, w('N').locator('path.wire'), 'opacity')).toBe('0.45');
  expect(await style(page, w('N').locator('.wire-head'), 'fill')).toBe('none');
  for (const to of ['C', 'X']) expect(await style(page, w(to).locator('path.wire'), 'opacity')).toBe('1');

  // the wire follows its target: C made Never turns pink and faded, Ctrl+Z puts it back
  await setCondition(page, id.C!, 'Never');
  await expect(w('C').locator('.link-wire')).toHaveAttribute('data-condition', 'Never');
  expect(await style(page, w('C').locator('path.wire'), 'stroke')).toBe(COLOUR.never);
  expect(await style(page, w('C').locator('path.wire'), 'opacity')).toBe('0.45');
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+z');
  await expect(w('C').locator('.link-wire')).toHaveAttribute('data-condition', 'Completed');
  expect(await style(page, w('C').locator('path.wire'), 'stroke')).toBe(COLOUR.completed);
  expect(await style(page, w('C').locator('path.wire'), 'opacity')).toBe('1');

  // the same colours in the dark theme, the wires still drawn
  await darkTheme(page);
  await checkColours();
  expect(await style(page, w('N').locator('path.wire'), 'opacity')).toBe('0.45');
});

test('idle entry arrows: frozen and unscheduled stay still while running and say why; the scheduled one moves', async ({ page }) => {
  // "running" faked by the live read (a read stub: nothing is started), as motion.spec does
  await page.routeWebSocket('**/api/hubs/liveness', (ws) => { ws.close(); });
  await page.route('**/api/v1/orchestration/live', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const answer = await route.fetch();
    const real = (await answer.json().catch(() => [])) as string[];
    return route.fulfill({ response: answer, json: [...real, id.W!] });
  });
  await openAt(page);
  const arrow = (to: string) => entryEdge(page, id.W!, id[to]!);
  await expect(arrow('S').locator('.entry-line')).toHaveClass(/\brunning\b/, { timeout: 20_000 });
  for (const [to, why] of [['F', 'frozen'], ['U', 'unscheduled']] as const) {
    await expect(arrow(to).locator('.entry-line'), to).not.toHaveClass(/\brunning\b/);
    await expect(arrow(to).locator('.entry-edge'), to).toHaveAttribute('data-idle', why);
    expect(await style(page, arrow(to).locator('.entry-line'), 'opacity'), to).toBe('0.45');
    expect(await style(page, arrow(to).locator('.entry-head'), 'fill'), to).toBe('none');
  }
  // frozen: the step card's pink N square, then "frozen"; unscheduled: a muted italic note
  const sq = arrow('F').locator('.entry-never-sq');
  await expect(sq.locator('text')).toHaveText('N');
  expect(await style(page, sq.locator('rect'), 'fill')).toBe(COLOUR.never);
  await expect(arrow('F').locator('.entry-cron')).toHaveText('frozen');
  await expect(arrow('U').locator('.entry-cron')).toHaveText('⏱ not scheduled');
  expect(await style(page, arrow('U').locator('.entry-cron'), 'fontStyle')).toBe('italic');
  // only what fires rings: S and the step it reaches; not the frozen, the unscheduled or the Never successor
  for (const s of ['S', 'C']) await expect(stNode(page, id[s]!).locator('.node'), s).toHaveClass(/\brunning\b/);
  for (const s of ['F', 'U', 'N']) await expect(stNode(page, id[s]!).locator('.node'), s).not.toHaveClass(/\brunning\b/);
});

test('the published diagram draws as the board', async ({ page }) => {
  await openAt(page);
  await selectWorkflowAlone(page, id.W!);
  await field(page, 'Name').fill('e2e-look-W-renamed');
  const svg = await captureDiagram(page, id.W!, () => save(page));
  const d = await page.evaluate((s) => {
    const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
    const all = (q: string) => [...doc.querySelectorAll(q)];
    return {
      circles: all('circle').length,
      wires: all('path[data-part="wire"]').map((p) => ({ stroke: p.getAttribute('stroke'), opacity: p.getAttribute('opacity'), marker: p.getAttribute('marker-end') })),
      entries: all('path[data-part="entry"]').map((p) => p.getAttribute('stroke')),
      idle: all('[data-part="idle"]').map((t) => t.textContent),
      boxes: all('g[data-part="step"]').map((g) => ({
        name: g.querySelector('text')?.textContent,
        pill: [...g.querySelectorAll('rect')].find((r) => r.getAttribute('width') === '18')?.getAttribute('fill') ?? null,
      })),
    };
  }, svg);
  expect(d.circles).toBe(0);
  expect(d.wires.map((w) => w.stroke).sort()).toEqual(['#0F9488', '#DB2777', '#E0482F']);
  const never = d.wires.find((w) => w.stroke === '#DB2777')!;
  expect(never.opacity).toBe('0.45');
  expect(never.marker).toContain('hollow');
  expect(d.entries.length).toBe(3);
  expect(new Set(d.entries)).toEqual(new Set(['#1A1D29']));
  expect(d.idle.sort()).toEqual(['frozen', '⏱ not scheduled'].sort());
  const pill = Object.fromEntries(d.boxes.map((b) => [b.name, b.pill]));
  expect(pill).toEqual({
    'e2e-look-S': '#0F9488', 'e2e-look-F': '#DB2777', 'e2e-look-U': '#0F9488',
    'e2e-look-C': '#0F9488', 'e2e-look-X': '#E0482F', 'e2e-look-N': '#DB2777',
  });
});
