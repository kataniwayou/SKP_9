import { describe, expect, it } from 'vitest';
import { assignmentDto, cacheDto, stepDto, workflowDto } from './fixtures';
import { assignmentRowFromDto, cacheRowFromDto, stepFromDto, stepRowFromDto, workflowRowFromDto } from './toModel';

describe('stepFromDto', () => {
  it('rejects a DTO without an id, because nothing downstream can key it', () => {
    expect(() => stepFromDto(stepDto('', { id: undefined } as never))).toThrow(/id/);
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
