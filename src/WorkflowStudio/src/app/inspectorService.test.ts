import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, processorDto, schemaDto, stepDto } from '../api/fixtures';
import { FIELDS } from '../store/entityForms';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { createInspectorService } from './inspectorService';

const ok = <T,>(value: T) => ({ ok: true, value }) as const;
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;
const spec = (kind: keyof typeof FIELDS, key: string) => FIELDS[kind].find((f) => f.key === key)!;

async function setup(getEntity = vi.fn().mockResolvedValue(ok(stepDto('s1', { name: 'fetch' })))) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto({
    steps: [stepDto('s1', { name: 'fetch', processorId: 'p1' })], processors: [processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })], schemas: [schemaDto('sc1')],
  })) });
  store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
  const writes = { putEntity: vi.fn(), createAssignment: vi.fn(), deleteAssignment: vi.fn(), saveDesign: vi.fn() };
  const api = { getEntity, ...writes } as unknown as StudioApi;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { store, api, writes, service: createInspectorService(api, store), flush, doc: () => store.getState().docs[0]! };
}

describe('InspectorService (plan 8 §3.3: reads, then design edits)', () => {
  it('reads the shown entity once, and not again while it is read', async () => {
    const { service, getEntity, flush, doc } = await setup().then((s) => ({ ...s, getEntity: s.api.getEntity as ReturnType<typeof vi.fn> }));
    service.read('wf1');
    service.read('wf1');
    await flush();
    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(doc().inspector.saved?.key).toBe('step:s1');
  });

  it('says when the shown entity no longer exists', async () => {
    const { service, flush, doc } = await setup(vi.fn().mockResolvedValue(notFound));
    service.read('wf1');
    await flush();
    expect(doc().inspector.readError).toBe('This step no longer exists.');
  });

  it('turns typed text into a design edit: an entry condition is a number, a blank nullable field is null; nothing is written', async () => {
    const { service, flush, doc, writes } = await setup();
    service.read('wf1');
    await flush();
    service.edit('wf1', spec('step', 'entryCondition'), '4');
    service.edit('wf1', spec('step', 'description'), '   ');
    expect(doc().edits.steps['s1']!.fields).toEqual({ entryCondition: 4 });
    service.edit('wf1', spec('step', 'description'), 'typed');
    expect(doc().edits.steps['s1']!.fields).toEqual({ entryCondition: 4, description: 'typed' });
    service.revert('wf1');
    expect(doc().edits.steps['s1']).toBeUndefined();
    for (const w of Object.values(writes)) expect(w).not.toHaveBeenCalled();
  });

  it('makes up the base of a created assignment and of an empty slot\'s schema, with no GET', async () => {
    const { service, store, flush, doc, api } = await setup();
    service.createAssignment('wf1', 's1', 'fetch');
    service.read('wf1');
    await flush();
    expect(doc().inspector.saved?.dto).toMatchObject({ stepId: 's1' });
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'schema', id: '', slot: 'output', processorId: 'p1' } });
    service.read('wf1');
    await flush();
    expect(doc().inspector.saved?.dto).toEqual({ id: '', name: 'fetcher-output', version: '1.0.0', description: null, definition: '{}' });
    expect(api.getEntity).toHaveBeenCalledTimes(0);
  });
});
