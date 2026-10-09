import { describe, expect, it } from 'vitest';
import { designLogFromDto } from '../api/toModel';
import { EMPTY_DRAFT } from '../design/draft';
import { saveAnswerLines, saveStartText, settleReport, type SaveFacts } from './saveLog';

const wire = (x: number) => ({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x, y: 0 } }) as never;

describe('the Save log (2026-10-09)', () => {
  it('"Save started" names what goes to BaseApi', () => {
    const none = { workflow: { fields: {}, entryStepIds: null, cacheIds: null }, steps: [], processors: [], caches: [], schemas: [], assignments: [] };
    expect(saveStartText(none)).toBe('Save started: sending the layout only');
    expect(saveStartText({
      ...none, workflow: { fields: { name: 'x' }, entryStepIds: ['s1'], cacheIds: null },
      steps: [{ fields: {}, nextStepIds: ['s2'] }, { fields: { name: 'n' }, nextStepIds: null }], schemas: [{}], assignments: [{}, {}],
    })).toBe('Save started: sending the workflow\'s fields, the entry steps, 2 steps (1 with new next steps), 1 schema copy, 2 assignment changes and the layout');
  });

  it('BaseApi\'s lines first with their levels, then the verdict, the re-read and the alignment; a held short circuit is red', () => {
    const facts: SaveFacts = {
      applied: true, errors: [], shorts: 1, held: 2, stored: false,
      log: [{ stage: 'steps', level: 'info', kind: 'stage', id: null, message: 'steps: 1 updated' }, { stage: 'outcome', level: 'error', kind: 'outcome', id: null, message: 'x' }],
      reread: { ok: true, steps: 3, links: 4 }, settle: { changed: 2, added: 0, removed: 1 },
    };
    expect(saveAnswerLines(facts)).toEqual([
      { text: 'BaseApi · steps: 1 updated', level: 'info' },
      { text: 'BaseApi · x', level: 'error' },
      { text: 'Saved and applied; 1 short circuit not written; 2 links held back until fixed', level: 'info' },
      { text: 'graph re-read: 3 steps, 4 links', level: 'info' },
      { text: '1 short circuit held back: 2 links not written', level: 'error' },
      { text: 'drawing settled to BaseApi\'s links: 2 wires changed, 1 wire removed', level: 'info' },
      { text: 'nothing left stored: the entities hold the design, the layout is kept', level: 'info' },
    ]);
  });

  it('settleReport counts wires changed, added and removed; null when neither draft has a circuit', () => {
    expect(settleReport(EMPTY_DRAFT, EMPTY_DRAFT)).toBeNull();
    const before = { ...EMPTY_DRAFT, wires: { a: wire(1), b: wire(2), c: wire(3) } };
    const after = { ...EMPTY_DRAFT, wires: { a: wire(1), b: wire(9), d: wire(4) } };
    expect(settleReport(before, after)).toEqual({ changed: 1, added: 1, removed: 1 });
  });

  it('reads BaseApi\'s log defensively: an unknown level is info, no log is null', () => {
    expect(designLogFromDto({ applied: true, errors: [] })).toBeNull();
    expect(designLogFromDto({ applied: true, errors: [], log: [{ stage: 'steps', level: 'warn', kind: 'step', id: 's1', message: 'm' }, { level: 'error' }] })).toEqual([
      { stage: 'steps', level: 'info', kind: 'step', id: 's1', message: 'm' },
      { stage: '', level: 'error', kind: '', id: null, message: '' },
    ]);
  });
});
