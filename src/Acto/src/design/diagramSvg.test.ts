import { describe, expect, it } from 'vitest';
import { conditionStyle as conditionInfo } from '../board/wires';
import { board } from './boardFixtures';
import { cronText, diagramSvg, settingRows } from './diagramSvg';

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');

describe('diagramSvg', () => {
  const doc = parse(diagramSvg(board(), 'daily'));
  const text = doc.documentElement.textContent ?? '';

  it('is a standalone svg on white with a viewBox from 0', () => {
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.getAttribute('viewBox')).toMatch(/^0 0 [\d.]+ [\d.]+$/);
    expect(doc.querySelector('rect')!.getAttribute('fill')).toBe('#FFFFFF');
  });

  it('shows the workflow, its reach and its cache, and leaves out what is not its own', () => {
    expect(text).toContain('daily');
    expect(text).toContain('fetch-orders');
    expect(text).toContain('expand');
    expect(text).toContain('c1');
    expect(text).not.toContain('lonely');
    expect(text).not.toContain('hourly');
  });

  it('draws the triangle, the wire in the target condition colour, the entry arrow in ink, and a dashed cache line', () => {
    expect(doc.querySelectorAll('polygon').length).toBe(1);
    // as the board draws them [user, 2026-11-25]: the wire wears its target's condition colour, the entry arrow is ink
    expect(doc.querySelector('path[data-part="wire"]')!.getAttribute('stroke')).toBe(conditionInfo(1).colour);
    expect(doc.querySelector('path[data-part="entry"]')!.getAttribute('stroke')).toBe('#1A1D29');
    // no letter circles on the lines any more
    expect(doc.querySelectorAll('circle').length).toBe(0);
    // the cache line, and its key in the legend
    expect(doc.querySelectorAll('path[stroke-dasharray]').length).toBe(1);
    expect(doc.querySelectorAll('line[stroke-dasharray]').length).toBe(1);
  });

  it('has the legend below and escapes names', () => {
    expect(text).toContain('Completed');
    const b = board();
    b.workflows.daily!.name = 'a<b>&"c';
    const svg = diagramSvg(b, 'daily');
    expect(parse(svg).querySelector('parsererror')).toBeNull();
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c');
  });

  it('keeps every rect inside the viewBox', () => {
    const [, , w, h] = doc.documentElement.getAttribute('viewBox')!.split(' ').map(Number);
    for (const r of doc.querySelectorAll('rect[x]')) {
      expect(Number(r.getAttribute('x'))).toBeGreaterThanOrEqual(0);
      expect(Number(r.getAttribute('x')) + Number(r.getAttribute('width'))).toBeLessThanOrEqual(w! + 0.5);
      expect(Number(r.getAttribute('y')) + Number(r.getAttribute('height'))).toBeLessThanOrEqual(h! + 0.5);
    }
  });

  it('shows the version, the save time and the counts beside the name', () => {
    expect(text).toMatch(/v1\.0\.0 · saved \d{4}-\d\d-\d\d \d\d:\d\d · 2 steps · 1 cache/);
  });

  it('shows each step with this workflow\'s settings as key and value rows, never another workflow\'s', () => {
    const b = board();
    b.assignments['a-daily-fetch']!.payload = '{"path":"/data/in","retry":{"count":3},"tags":["a","b"]}';
    b.assignments['a-hourly-fetch']!.payload = '{"path":"/hourly-only"}';
    const d = parse(diagramSvg(b, 'daily'));
    const step = [...d.querySelectorAll('g[data-part="step"]')].find((g) => g.textContent!.includes('fetch-orders'))!;
    const texts = [...step.querySelectorAll('text')].map((t) => t.textContent);
    // the name, its condition pill's letter (as on the board's card), then the rows
    expect(texts).toEqual(['fetch-orders', 'C', 'path', '/data/in', 'retry.count', '3', 'tags', '["a","b"]']);
    expect(d.documentElement.textContent).not.toContain('/hourly-only');
    // a step with no settings says so
    const other = [...d.querySelectorAll('g[data-part="step"]')].find((g) => g.textContent!.includes('expand'))!;
    expect(other.textContent).toContain('no settings');
  });

  it('masks a setting whose key names a secret', () => {
    const b = board();
    b.assignments['a-daily-fetch']!.payload = '{"user":"bob","saslPassword":"hunter2","auth":{"apiKey":"k-1"},"token":"t"}';
    const svg = diagramSvg(b, 'daily');
    expect(svg).toContain('bob');
    for (const s of ['hunter2', 'k-1', '>t<']) expect(svg).not.toContain(s);
    expect(svg.match(/••••••/g)!.length).toBe(3);
  });

  it('shows at most 12 rows and says how many more', () => {
    const b = board();
    b.assignments['a-daily-fetch']!.payload = JSON.stringify(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i])));
    const svg = diagramSvg(b, 'daily');
    expect(svg).toContain('>k11<');
    expect(svg).not.toContain('>k12<');
    expect(svg).toContain('+3 more');
  });

  it('the triangle badge is the schedule summary: the shared cron, a count, or not scheduled', () => {
    const b = board();
    const w = (entryCrons: Record<string, string>) => ({ ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: ['fetch', 'expand'], entryCrons } } });
    const badge = (x: typeof b) => parse(diagramSvg(x, 'daily')).querySelector('g[data-part="cron"]')!.textContent!;
    expect(badge(w({}))).toContain('⏱ not scheduled');
    expect(badge(w({ fetch: '0 * * * * *', expand: '0  * * * * *' }))).toContain('⏱ 0 * * * * *');
    expect(badge(w({ fetch: '0 * * * * *', expand: '*/10 * * * * *' }))).toContain('⏱ 2 schedules');
  });

  it('the badge fits the longest preset whole, and the badge is wide enough for it', () => {
    const b = board();
    const x = { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: ['fetch'], entryCrons: { fetch: '0 0 8 * * MON-FRI' } } } };
    const g = parse(diagramSvg(x, 'daily')).querySelector('g[data-part="cron"]')!;
    const line = g.querySelector('text')!.textContent!;
    expect(line).toBe('⏱ 0 0 8 * * MON-FRI');
    // 13px monospace is about 7.2px a character; the text must sit inside the badge with some padding
    expect(Number(g.querySelector('rect')!.getAttribute('width'))).toBeGreaterThanOrEqual(Math.ceil(line.length * 7.2) + 16);
  });

  it('shows a cache\'s root and item count', () => {
    const b = board();
    b.caches.c1!.items = '{"a":"1","b":"2","c":"3"}';
    const cache = parse(diagramSvg(b, 'daily')).querySelector('g[data-part="cache"]')!;
    expect([...cache.querySelectorAll('text')].map((t) => t.textContent)).toEqual(['c1', 'root', 'r', 'items', '3']);
  });

  it('pushes a box down when a taller box above would overlap it', () => {
    const b = board();
    // expand sits right under fetch on the board; fetch grows with 10 rows
    b.steps.expand!.at = { x: 200, y: 300 };
    b.assignments['a-daily-fetch']!.payload = JSON.stringify(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])));
    const d = parse(diagramSvg(b, 'daily'));
    const rect = (name: string) => [...d.querySelectorAll('g[data-part="step"]')].find((g) => g.querySelector('text')!.textContent === name)!.querySelector('rect')!;
    const [f, e] = [rect('fetch-orders'), rect('expand')];
    expect(Number(e.getAttribute('y'))).toBeGreaterThanOrEqual(Number(f.getAttribute('y')) + Number(f.getAttribute('height')));
  });
});

describe('settingRows', () => {
  it('flattens objects with dots, keeps arrays as JSON and survives text that is not JSON', () => {
    expect(settingRows('{"a":1,"b":{"c":true,"d":null},"e":[1]}')).toEqual([
      { key: 'a', value: '1' }, { key: 'b.c', value: 'true' }, { key: 'b.d', value: 'null' }, { key: 'e', value: '[1]' },
    ]);
    expect(settingRows('{}')).toEqual([]);
    expect(settingRows('not json')).toEqual([{ key: 'payload', value: 'not json' }]);
    expect(settingRows('"x"')).toEqual([{ key: 'value', value: 'x' }]);
  });
});

describe('cronText', () => {
  it('reads the common shapes, with or without seconds', () => {
    expect(cronText('0 0 2 * * *')).toBe('daily at 02:00:00');
    expect(cronText('30 2 * * *')).toBe('daily at 02:30:00');
    expect(cronText('0 0 * * * *')).toBe('hourly at :00:00');
    expect(cronText('0 */5 * * * *')).toBe('every 5 minutes');
    expect(cronText('*/10 * * * * *')).toBe('every 10 seconds');
    expect(cronText('0 15 */6 * * *')).toBe('every 6 hours at :15');
    expect(cronText('0 0 8 * * 1,3')).toBe('weekly on Mon, Wed at 08:00:00');
  });
  it('gives nothing for a shape it does not read', () => {
    expect(cronText('0 0 2 1 * *')).toBeNull();
    expect(cronText('0 0 9-17 * * *')).toBeNull();
    expect(cronText('nonsense')).toBeNull();
  });

  describe('lines that never fire, as the board draws them [user, 2026-11-25]', () => {
    const lines = (b: ReturnType<typeof board>) => parse(diagramSvg(b, 'daily'));
    const scheduled = () => {
      const b = board();
      b.workflows.daily!.entryCrons = { fetch: '0 * * * * *' };
      return b;
    };

    it('a scheduled entry arrow into a live step is plain: no fade, a filled head, no reason', () => {
      const d = lines(scheduled());
      const entry = d.querySelector('path[data-part="entry"]')!;
      expect(entry.hasAttribute('opacity')).toBe(false);
      expect(entry.getAttribute('marker-end')).not.toContain('hollow');
      expect(d.querySelectorAll('[data-part="idle"]').length).toBe(0);
    });

    it('an entry arrow with no cron is faded with a hollow head and says it is not scheduled', () => {
      const d = lines(board());
      const entry = d.querySelector('path[data-part="entry"]')!;
      expect(entry.getAttribute('opacity')).toBe('0.45');
      expect(entry.getAttribute('marker-end')).toContain('hollow');
      expect(d.querySelector('[data-part="idle"]')!.textContent).toBe('⏱ not scheduled');
    });

    it('an entry arrow into a Never step is frozen: faded, hollow, the pink N square and "frozen"', () => {
      const b = scheduled();
      b.steps.fetch!.entryCondition = 5;
      const d = lines(b);
      const entry = d.querySelector('path[data-part="entry"]')!;
      expect(entry.getAttribute('opacity')).toBe('0.45');
      expect(entry.getAttribute('marker-end')).toContain('hollow');
      const idle = d.querySelector('[data-part="idle"]')!;
      expect(idle.textContent).toBe('frozen');
      expect(idle.getAttribute('fill')).toBe(conditionInfo(5).colour);
    });

    it('a wire into a Never step is pink, faded, with a hollow head; others are full', () => {
      const b = scheduled();
      expect(lines(b).querySelector('path[data-part="wire"]')!.hasAttribute('opacity')).toBe(false);
      b.steps.expand!.entryCondition = 5;
      const wire = lines(b).querySelector('path[data-part="wire"]')!;
      expect(wire.getAttribute('stroke')).toBe(conditionInfo(5).colour);
      expect(wire.getAttribute('opacity')).toBe('0.45');
      expect(wire.getAttribute('marker-end')).toContain('hollow');
    });

    it('the legend keys each condition with the board\'s square pill', () => {
      const d = lines(board());
      for (const c of [1, 2, 3, 4, 5]) {
        expect([...d.querySelectorAll('rect')].some((r) => r.getAttribute('fill') === conditionInfo(c).colour && r.getAttribute('width') === '18')).toBe(true);
      }
    });
  });
});
