import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { applyDraft } from '../design/apply';
import { EMPTY_DRAFT } from '../design/draft';
import { diagramSvg } from './diagramSvg';

// s1 -> s2 (Completed), s1 -> f (Failed); a cache on the workflow
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ name: 'chain <&> "x"', version: '2.1.0', entryStepIds: ['s1'], cacheIds: ['c1'] }),
  steps: [stepDto('s1', { name: 'importer', nextStepIds: ['s2', 'f'], processorId: 'p1' }), stepDto('s2', { name: 'exporter' }), stepDto('f', { name: 'record', entryCondition: 2 })],
  processors: [processorDto('p1', { name: 'kafka-importer', version: '1.0.0' })],
  caches: [cacheDto('c1', { name: 'chain-artists', root: 'chain-artists' })],
}));

describe('the published drawing (2026-10-11)', () => {
  it('is one well-formed SVG: every block, every wire as drawn, arrow heads, names escaped, a legend of the families used', async () => {
    const shown = applyDraft(await doc(), EMPTY_DRAFT);
    const svg = diagramSvg(shown);
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
    const root = parsed.documentElement;
    expect(root.getAttribute('viewBox')).toMatch(/^-?\d+ -?\d+ \d+ \d+$/);
    // the canvas's own routes: one polyline per wire, through the same points
    for (const w of shown.wires) expect(svg).toContain(`points="${w.points.map(([x, y]) => `${x},${y}`).join(' ')}"`);
    // three steps, the hub, the cache
    expect(svg).toContain('>importer<');
    expect(svg).toContain('>kafka-importer<');
    expect(svg).toContain('chain-artists');
    expect(svg).toContain('WORKFLOW');
    // escaped, never raw
    expect(svg).toContain('chain &lt;&amp;&gt; &quot;x&quot;');
    expect(svg).not.toContain('chain <&>');
    // a head on a step has an arrow; the legend lists the families drawn
    expect(parsed.querySelectorAll('polygon').length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain('>Completed<');
    expect(svg).toContain('>Failed<');
    expect(svg).not.toContain('>Never<');
  });

  it('draws a step without a processor and a cache without a root as the canvas does: dashed amber, with a ⚠', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'], cacheIds: ['c1'] }),
      steps: [stepDto('s1')],
      caches: [cacheDto('c1', { root: '' })],
    }));
    // the processor removed in the design (2026-10-10): the step's processorId is null
    const shown = applyDraft(d, EMPTY_DRAFT);
    const steps = new Map(shown.graph.steps);
    steps.set('s1', { ...steps.get('s1')!, processorId: null });
    const svg = diagramSvg({ ...shown, graph: { ...shown.graph, steps } });
    expect(svg).toContain('⚠ no processor');
    expect(svg).toContain('⚠ no root');
  });
});
