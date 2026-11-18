import { describe, expect, it } from 'vitest';
import { conditionInfo } from '../model/entryConditions';
import { board } from './boardFixtures';
import { diagramSvg } from './diagramSvg';

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
    expect(doc.querySelectorAll('[stroke-dasharray]').length).toBe(1);
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
});
