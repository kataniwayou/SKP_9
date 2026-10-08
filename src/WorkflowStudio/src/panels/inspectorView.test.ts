import { describe, expect, it } from 'vitest';
import { stepDto } from '../api/fixtures';
import { detailRows, formatInstant, kindLabel, uniqueNameOf } from './inspectorView';

describe('inspectorView', () => {
  it('formats instants and leaves anything else as it came', () => {
    expect(formatInstant('2026-10-05T12:00:00.123456Z')).toBe('2026-10-05 12:00:00.123 UTC');
    expect(formatInstant('yesterday')).toBe('yesterday');
  });

  it("reads the base-entity details from the entity's last GET", () => {
    expect(detailRows(stepDto('s1', { createdBy: 'ana' })).map((r) => [r.label, r.value])).toEqual([
      ['Id', 's1'], ['Created at', '2026-10-05 12:00:00 UTC'], ['Created by', 'ana'], ['Updated at', '2026-10-05 12:00:00 UTC'], ['Updated by', '—'],
    ]);
  });

  it('names the entity by its saved name; the kind pill is the kind (an unwired step is an ordinary step, plan 8)', () => {
    expect(uniqueNameOf(stepDto('s1', { name: 'fetch' }))).toBe('fetch_1.0.0-s1');
    expect(kindLabel({ kind: 'step', id: 's1' })).toBe('STEP');
    expect(kindLabel({ kind: 'schema', id: 'sc1', slot: 'config', processorId: 'p1' })).toBe('SCHEMA');
  });
});
