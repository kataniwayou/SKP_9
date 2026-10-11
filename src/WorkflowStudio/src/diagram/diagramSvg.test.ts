import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createTextFitter } from '../canvas/fitText';
import { applyDraft } from '../design/apply';
import { EMPTY_DRAFT } from '../design/draft';
import { diagramSvg } from './diagramSvg';

const fitter = createTextFitter((text) => text.length * 6);

// s1 -> s2 (Completed), s1 -> f (Failed); a cache on the workflow
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ name: 'chain <&> "x"', version: '2.1.0', entryStepIds: ['s1'], cacheIds: ['c1'] }),
  steps: [stepDto('s1', { name: 'importer', nextStepIds: ['s2', 'f'], processorId: 'p1' }), stepDto('s2', { name: 'exporter' }), stepDto('f', { name: 'record', entryCondition: 2 })],
  processors: [processorDto('p1', { name: 'kafka-importer', version: '1.0.0' })],
  caches: [cacheDto('c1', { name: 'chain-artists', root: 'chain-artists' })],
}));

describe('the published drawing: the canvas art (2026-10-11)', () => {
  it('is one well-formed, self-contained SVG of the canvas components: every wire as drawn, the blocks, the legend', async () => {
    const shown = applyDraft(await doc(), EMPTY_DRAFT);
    const svg = diagramSvg(shown, fitter);
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.documentElement.getAttribute('viewBox')).toMatch(/^-?\d+ -?\d+ \d+ \d+$/);
    // the canvas's own art: its classes, its styles and its gradient, nothing fetched
    expect(parsed.querySelectorAll('g.blk.nx')).toHaveLength(3);
    expect(parsed.querySelectorAll('g.wf.nx')).toHaveLength(1);
    expect(parsed.querySelectorAll('g.cachetag')).toHaveLength(1);
    expect(parsed.querySelectorAll('g.wire')).toHaveLength(shown.wires.length);
    expect(parsed.querySelector('linearGradient#nxCap')).not.toBeNull();
    // (the canvas styles themselves are checked in e2e/diagram.spec.ts: the test runner empties every .css import)
    expect(svg).toMatch(/@font-face\{font-family:"IBM Plex Sans Condensed";font-weight:400;src:url\(data:font\/woff2;base64,/);
    expect(svg).not.toMatch(/(href|src)="https?:/);
    // a snapshot: no run state in the dial, nothing moves
    expect(parsed.querySelector('.nx-state')).toBeNull();
    expect(svg).toContain('animation:none!important');
    // the title, escaped; the legend: every family, undecided, short circuit
    expect(parsed.querySelector('.dg-title')!.textContent).toBe('chain <&> "x"2.1.0');
    expect(svg).not.toContain('chain <&>');
    const legend = [...parsed.querySelectorAll('.dg-lg')].map((t) => t.textContent);
    expect(legend).toEqual(['Completed', 'Failed', 'Cancelled', 'Always', 'Never', 'undecided', 'short circuit']);
  });
});
