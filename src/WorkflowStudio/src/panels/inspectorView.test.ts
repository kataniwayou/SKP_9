import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { formatInstant, inspectorView } from './inspectorView';

const W = '11111111-2222-3333-4444-555566667777';
const S = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
const P = '99999999-8888-7777-6666-555544443333';
const IN = '12345678-1234-1234-abcd-0000000000aa';

const graph = graphDto({
  workflow: workflowDto({ id: W, name: 'orders', version: '1.2.0', description: 'nightly', cronExpression: '0 * * * * *', entryStepIds: [S], assignmentIds: ['never-shown'] }),
  steps: [stepDto(S, { name: 'fetch', version: '2.0.0', processorId: P, entryCondition: 2, description: null })],
  processors: [processorDto(P, { name: 'file-fetcher', version: '1.0.0', sourceHash: 'f'.repeat(64), instanceId: null, inputSchemaId: IN, outputSchemaId: 'unloaded-id' })],
  schemas: [schemaDto(IN, { name: 'file-locator', version: '1.0.0' })],
  caches: [cacheDto('c1', { name: 'lookups', version: '3.0.0', root: 'lk', items: '{"a":"b"}' })],
} as never);

describe('inspectorView', () => {
  it('shows a workflow: unique name, name, version, details, description and cron, never its assignments', async () => {
    const view = inspectorView(await loadedDocument(graph), { kind: 'workflow' })!;
    expect(view.kind).toBe('WORKFLOW');
    expect(view.uniqueName).toBe('orders_1.2.0-4444-555566667777');
    expect(view.head.map((r) => [r.label, r.value])).toEqual([['Name', 'orders'], ['Version', '1.2.0']]);
    expect(view.fields.map((r) => [r.label, r.value])).toEqual([['Description', 'nightly'], ['Cron', '0 * * * * *']]);
    expect(view.details.map((r) => r.label)).toEqual(['Id', 'Created at', 'Created by', 'Updated at', 'Updated by']);
    expect(view.details[0]!.value).toBe(W);
    expect(JSON.stringify(view)).not.toContain('never-shown');
  });

  it('shows a step with its entry condition and its processor by unique name', async () => {
    const view = inspectorView(await loadedDocument(graph), { kind: 'step', stepId: S })!;
    expect(view.kind).toBe('STEP');
    expect(view.uniqueName).toBe('fetch_2.0.0-dddd-eeeeffff0000');
    expect(view.fields).toEqual([
      { label: 'Description', value: '—' },
      { label: 'Entry condition', value: 'F · Failed', dot: '#FF7A66' },
      { label: 'Processor', value: 'file-fetcher_1.0.0-6666-555544443333' },
    ]);
    expect(view.note).toBeUndefined();
  });

  it('marks a parked step', async () => {
    const parked = graphDto({ ...graph, layout: { parked: ['pk'] } } as never);
    const doc = await loadedDocument(parked, [], [stepDto('pk', { name: 'spare', processorId: P })]);
    const view = inspectorView(doc, { kind: 'step', stepId: 'pk' })!;
    expect(view.kind).toBe('STEP · PARKED');
    expect(view.note).toMatch(/Parked/);
  });

  it('shows a processor with source hash, instance id and the three schema slots', async () => {
    const view = inspectorView(await loadedDocument(graph), { kind: 'processor', processorId: P, stepId: S })!;
    expect(view.fields.map((r) => [r.label, r.value])).toEqual([['Description', '—'], ['Source hash', 'f'.repeat(64)], ['Instance id', '—']]);
    expect(view.slots).toEqual([
      { label: 'In', value: 'file-locator_1.0.0-abcd-0000000000aa' },
      { label: 'Out', value: 'unloaded-id' },
      { label: 'Config', value: '∅', empty: true },
    ]);
  });

  it('shows a cache with root and items', async () => {
    const view = inspectorView(await loadedDocument(graph), { kind: 'cache', cacheId: 'c1' })!;
    expect(view.fields.map((r) => [r.label, r.value])).toEqual([['Description', '—'], ['Root', 'lk'], ['Items', '{"a":"b"}']]);
  });

  it('shows nothing for no selection, or one this document does not hold', async () => {
    const doc = await loadedDocument(graph);
    expect(inspectorView(doc, null)).toBeNull();
    expect(inspectorView(doc, { kind: 'step', stepId: 'gone' })).toBeNull();
    expect(inspectorView(doc, { kind: 'cache', cacheId: 'gone' })).toBeNull();
  });
});

describe('formatInstant', () => {
  it('reads a UTC instant, milliseconds kept, and leaves anything else alone', () => {
    expect(formatInstant('2026-10-05T12:00:00.123456Z')).toBe('2026-10-05 12:00:00.123 UTC');
    expect(formatInstant('2026-10-05T12:00:00Z')).toBe('2026-10-05 12:00:00 UTC');
    expect(formatInstant('yesterday')).toBe('yesterday');
    expect(formatInstant('')).toBe('—');
  });
});
