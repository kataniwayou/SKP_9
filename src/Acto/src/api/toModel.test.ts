import { describe, expect, it } from 'vitest';
import { assignmentDto, cacheDto, processorDto, schemaDto, stepDto, workflowDto } from './fixtures';
import { assignmentRowFromDto, cacheRowFromDto, processorRowFromDto, schemaRowFromDto, stepFromDto, stepRowFromDto, workflowRowFromDto } from './toModel';

describe('stepFromDto', () => {
  it('rejects a DTO without an id, because nothing downstream can key it', () => {
    expect(() => stepFromDto(stepDto('', { id: undefined } as never))).toThrow(/id/);
  });
});

describe('workflowRowFromDto entry crons', () => {
  it('readsEntryCronsAndDefaultsToEmpty', () => {
    expect(workflowRowFromDto(workflowDto({ entryCrons: { s1: '*/10 * * * * *' } })).entryCrons).toEqual({ s1: '*/10 * * * * *' });
    expect(workflowRowFromDto(workflowDto({ entryCrons: null })).entryCrons).toEqual({});
    expect(workflowRowFromDto(workflowDto()).entryCrons).toEqual({});
  });
});

describe('the board rows keep the read-only audit fields', () => {
  it('createdAt, createdBy and updatedBy as sent; null when absent', () => {
    const row = stepRowFromDto(stepDto('s1', { createdBy: 'katan', updatedBy: 'acto' }));
    expect(row).toMatchObject({ createdAt: '2026-10-05T12:00:00Z', createdBy: 'katan', updatedBy: 'acto', updatedAt: '2026-10-05T12:00:00Z' });
    const bare = { ...cacheDto('c1') } as Record<string, unknown>;
    delete bare.createdAt; delete bare.createdBy; delete bare.updatedBy;
    expect(cacheRowFromDto(bare as never)).toMatchObject({ createdAt: null, createdBy: null, updatedBy: null });
    expect(workflowRowFromDto(workflowDto({ createdBy: 'w' }))).toMatchObject({ createdBy: 'w' });
    expect(assignmentRowFromDto(assignmentDto('a1', { updatedBy: 'u' }))).toMatchObject({ updatedBy: 'u', createdAt: '2026-10-05T12:00:00Z' });
  });
});

describe('a cache row carries the item count, not the items', () => {
  it('toCacheRow maps itemCount and empty itemEdits', () => {
    const row = cacheRowFromDto(cacheDto('c1', { itemCount: 42 }));
    expect(row.itemCount).toBe(42);
    expect(row.itemEdits).toEqual({ set: {}, removed: [] });
    expect(row).not.toHaveProperty('items');
  });

  it('a missing count is 0', () => {
    expect(cacheRowFromDto(cacheDto('c1', { itemCount: undefined })).itemCount).toBe(0);
  });
});

describe('schema and processor rows keep a board place', () => {
  it('a schema read with boardX/boardY has at; without them at is null', () => {
    expect(schemaRowFromDto(schemaDto('s1', { boardX: 3, boardY: 4 })).at).toEqual({ x: 3, y: 4 });
    expect(schemaRowFromDto(schemaDto('s1')).at).toBeNull();
  });
  it('a processor read with boardX/boardY has at; without them at is null', () => {
    expect(processorRowFromDto(processorDto('p1', { boardX: 3, boardY: 4 })).at).toEqual({ x: 3, y: 4 });
    expect(processorRowFromDto(processorDto('p1')).at).toBeNull();
  });
});
