import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, processorDto, schemaDto, stepDto } from '../api/fixtures';
import { FIELDS } from '../store/entityForms';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { createInspectorService, NEW_SCHEMA_DEFINITION } from './inspectorService';

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

  it('reads a step and a cache the Toolbox made from the design graph, with no GET and no "no longer exists" (2026-10-20)', async () => {
    const getEntity = vi.fn().mockResolvedValue(notFound);
    const { service, store, flush, doc } = await setup(getEntity);
    store.dispatch({ type: 'toolDrop', workflowId: 'wf1', item: { kind: 'step' }, at: { x: 800, y: 400 }, newId: () => 'n1' });
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 'n1' } });
    service.read('wf1');
    await flush();
    expect(getEntity).not.toHaveBeenCalled();
    expect(doc().inspector.readError).toBeNull();
    expect(doc().inspector.saved).toMatchObject({ key: 'step:n1', dto: { id: 'n1', name: 'step', version: '1.0.0', entryCondition: 1 } });

    store.dispatch({ type: 'toolDrop', workflowId: 'wf1', item: { kind: 'newCache' }, at: { x: 800, y: 800 }, newId: () => 'c9' });
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'cache', cacheId: 'c9' } });
    service.read('wf1');
    await flush();
    expect(getEntity).not.toHaveBeenCalled();
    expect(doc().inspector.readError).toBeNull();
    expect(doc().inspector.saved).toMatchObject({ key: 'cache:c9', dto: { id: 'c9', root: '' } });
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

  it('makes up the base of a created assignment and of an empty slot\'s schema, with no GET of either', async () => {
    const { service, store, flush, doc, api } = await setup(vi.fn().mockResolvedValue(notFound));
    await service.createAssignment('wf1', 's1', 'fetch');
    // the config schema read for the payload's layout (2026-11-02), not a read of the assignment
    expect(api.getEntity).toHaveBeenCalledWith('schema', 'sc1');
    expect(doc().edits.assignments['s1']).toMatchObject({ op: 'create', fields: { payload: '{}' } });
    vi.mocked(api.getEntity).mockClear();
    service.read('wf1');
    await flush();
    expect(doc().inspector.saved?.dto).toMatchObject({ stepId: 's1' });
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'schema', id: '', slot: 'output', processorId: 'p1' } });
    service.read('wf1');
    await flush();
    expect(doc().inspector.saved?.dto).toEqual({ id: '', name: 'fetcher-output', version: '1.0.0', description: null, definition: NEW_SCHEMA_DEFINITION });
    expect(api.getEntity).toHaveBeenCalledTimes(0);
  });

  it('lays a created assignment\'s payload out from the processor\'s config schema, read once however often it is clicked (2026-11-02)', async () => {
    const definition = JSON.stringify({ required: ['bucket'], properties: { bucket: { type: 'string' }, overwrite: { type: 'boolean' } } });
    const { service, doc, api, writes } = await setup(vi.fn().mockResolvedValue(ok(schemaDto('sc1', { definition }))));
    await Promise.all([service.createAssignment('wf1', 's1', 'fetch'), service.createAssignment('wf1', 's1', 'fetch')]);
    expect(api.getEntity).toHaveBeenCalledTimes(1);
    expect(doc().edits.assignments['s1']).toMatchObject({ op: 'create', fields: { name: 'fetch-assignment', payload: '{\n  "bucket": "<string>",\n  "overwrite": false\n}' } });
    for (const w of Object.values(writes)) expect(w).not.toHaveBeenCalled();
  });

  it('takes the config schema from the design\'s copy of the slot when it has one, with no GET', async () => {
    const { service, store, flush, doc, api } = await setup(vi.fn().mockResolvedValue(ok(schemaDto('sc1'))));
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'schema', id: 'sc1', slot: 'config', processorId: 'p1' } });
    service.read('wf1');
    await flush();
    service.edit('wf1', spec('schema', 'definition'), '{"required":["queue"],"properties":{"queue":{"type":"string"}}}');
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    vi.mocked(api.getEntity).mockClear();
    await service.createAssignment('wf1', 's1', 'fetch');
    expect(api.getEntity).not.toHaveBeenCalled();
    expect(doc().edits.assignments['s1']).toMatchObject({ fields: { payload: '{\n  "queue": "<string>"\n}' } });
  });
});
