import { describe, expect, it } from 'vitest';
import { conditionInfo } from '../model/entryConditions';
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

  it('draws the triangle, the wire in the target condition colour and a dashed cache line', () => {
    expect(doc.querySelectorAll('polygon').length).toBe(1);
    const strokes = [...doc.querySelectorAll('path[stroke]')].map((p) => p.getAttribute('stroke'));
    expect(strokes.filter((s) => s === conditionInfo(1).colour).length).toBeGreaterThanOrEqual(2);
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
    expect(texts).toEqual(['fetch-orders', 'path', '/data/in', 'retry.count', '3', 'tags', '["a","b"]']);
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

  it('the triangle badge reads manual start when no entry has a cron', () => {
    expect(parse(diagramSvg(board(), 'daily')).querySelector('g[data-part="cron"]')!.textContent!.trim()).toBe('manual start');
  });

  it('the triangle badge shows the shared entry cron, or the count when they differ', () => {
    const b = board();
    const w = (entryCrons: Record<string, string>) => ({ ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: ['fetch', 'expand'], entryCrons } } });
    const badge = (x: typeof b) => parse(diagramSvg(x, 'daily')).querySelector('g[data-part="cron"]')!.textContent!;
    expect(badge(w({ fetch: '0 * * * * *', expand: '0  * * * * *' }))).toContain('0 * * * * *');
    expect(badge(w({ fetch: '0 * * * * *', expand: '*/10 * * * * *' }))).toContain('2 schedules');
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
});
