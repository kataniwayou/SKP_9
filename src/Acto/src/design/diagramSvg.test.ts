import { describe, expect, it } from 'vitest';
import { diagramSvg } from './diagramSvg';
import { bw } from '../board/fixtures';

function parse(bwf: ReturnType<typeof bw>) {
  return new DOMParser().parseFromString(diagramSvg(bwf), 'image/svg+xml');
}

describe('diagramSvg', () => {
  const w = bw('w1', ['a', 'b', 'c'], [
    { id: 'a>b', from: 'a', to: 'b', condition: 1 },
    { id: 'a>c', from: 'a', to: 'c', condition: 2 },
  ]);
  w.graph.steps.set('b', { ...w.graph.steps.get('b')!, entryCondition: 1 });
  w.graph.steps.set('c', { ...w.graph.steps.get('c')!, entryCondition: 2 });

  it('is a standalone svg with a viewBox and the title', () => {
    const doc = parse(w);
    expect(doc.querySelector('parsererror')).toBeNull();
    const svg = doc.documentElement;
    expect(svg.tagName).toBe('svg');
    expect(svg.getAttribute('viewBox')).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    expect(doc.documentElement.textContent).toContain('w1-name');
  });

  it('draws a wire per link in the target condition colour, with step names and the legend', () => {
    const doc = parse(w);
    const strokes = [...doc.querySelectorAll('path[stroke]')].map((p) => p.getAttribute('stroke'));
    expect(strokes).toEqual(['#0F9488', '#E0482F']);
    const text = doc.documentElement.textContent ?? '';
    for (const t of ['a-name', 'b-name', 'c-name', 'a-proc', 'FIRST', 'Completed', 'Failed', 'Cancelled', 'Always', 'Never']) {
      expect(text).toContain(t);
    }
  });

  it('has no external references', () => {
    const s = diagramSvg(w);
    expect(s).not.toMatch(/href/);
    expect(s).not.toMatch(/url\(http/);
    expect(s).not.toMatch(/<style/);
  });

  it('escapes names', () => {
    const x = bw('w2', ['a']);
    x.graph.workflow = { ...x.graph.workflow, name: 'a<b & "c"' };
    const doc = parse(x);
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.textContent).toContain('a<b & "c"');
  });
});
