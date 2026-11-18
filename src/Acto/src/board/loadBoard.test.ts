import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import { assignmentDto, cacheDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadBoard } from './loadBoard';

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

function api(over: Partial<Record<'listWorkflows' | 'listSteps' | 'listCaches' | 'listAssignments' | 'listProcessors' | 'listSchemas', ApiResult<unknown[]>>> = {}): StudioApi {
  const lists = {
    listWorkflows: ok([workflowDto({ id: 'w1', entryStepIds: ['s1'], cacheIds: ['c1'], assignmentIds: ['a1'], boardX: 10, boardY: 20, updatedAt: '2026-11-01T10:00:00.1234567Z' } as never)]),
    listSteps: ok([stepDto('s1', { boardX: 5, boardY: null } as never), stepDto('orphan')]),
    listCaches: ok([cacheDto('c1', { boardX: 0, boardY: 0 } as never)]),
    listAssignments: ok([assignmentDto('a1', { stepId: 's1' }), assignmentDto('unlinked', { stepId: 's1' })]),
    listProcessors: ok([processorDto('p1')]),
    listSchemas: ok([schemaDto('sc1')]),
    ...over,
  };
  return Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, vi.fn().mockResolvedValue(v)])) as unknown as StudioApi;
}

describe('loadBoard', () => {
  it('maps the six lists to rows, boardX/boardY to at, keeping updatedAt exactly', async () => {
    const r = await loadBoard(api());
    if (!r.ok) throw new Error('failed');
    const b = r.value;
    expect(b.workflows.w1).toMatchObject({ entryStepIds: ['s1'], cacheIds: ['c1'], assignmentIds: ['a1'], at: { x: 10, y: 20 }, updatedAt: '2026-11-01T10:00:00.1234567Z' });
    expect(b.caches.c1!.at).toEqual({ x: 0, y: 0 });
    expect(Object.keys(b.processors)).toEqual(['p1']);
    expect(Object.keys(b.schemas)).toEqual(['sc1']);
  });

  it('keeps a null at when either coordinate is null', async () => {
    const r = await loadBoard(api());
    if (!r.ok) throw new Error('failed');
    expect(r.value.steps.s1!.at).toBeNull();
    expect(r.value.steps.orphan!.at).toBeNull();
  });

  it('keeps orphan steps and unlinked assignments', async () => {
    const r = await loadBoard(api());
    if (!r.ok) throw new Error('failed');
    expect(Object.keys(r.value.steps)).toEqual(['s1', 'orphan']);
    expect(Object.keys(r.value.assignments)).toEqual(['a1', 'unlinked']);
    expect(r.value.assignments.a1).toMatchObject({ stepId: 's1', payload: '{}' });
  });

  it('returns the error of a failed list', async () => {
    const error = { kind: 'http', status: 500, detail: 'boom' } as const;
    const r = await loadBoard(api({ listSteps: { ok: false, error } }));
    expect(r).toEqual({ ok: false, error });
  });
});
