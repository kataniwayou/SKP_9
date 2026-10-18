import { describe, expect, it } from 'vitest';
import type { ProjectData } from './project';
import { healthLine, healthOf, livenessOf, readLiveness, type Liveness } from './liveness';
import { createWorkspace } from '../app/workspace';
import { buildMolecule } from '../molecule/model';

const entry = (id: string, live: boolean, healthy = live ? 1 : 0, replicas = 1, more: Record<string, number> = {}) =>
  ({ processorId: id, live, replicas, healthy, absent: 0, unhealthy: 0, stale: 0, malformed: 0, ...more });
const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('processor health (the user, 2026-10-18)', () => {
  it("reads BaseApi's answer as SKP Studio does: ids without case, malformed entries skipped, the reason for a dead one", () => {
    const m = livenessOf([entry('AB-1', true, 2, 2), entry('cd-2', false, 0, 1, { absent: 1 }), { processorId: 7, live: true }, { processorId: 'x' }, 'no'])!;
    expect([...m.keys()]).toEqual(['ab-1', 'cd-2']);
    expect(m.get('ab-1')).toEqual({ live: true, healthy: 2, replicas: 2, reason: null });
    expect(m.get('cd-2')!.reason).toBe('no healthy replica (1 checked: 1 absent, 0 unhealthy, 0 stale, 0 malformed)');
    expect(livenessOf({ not: 'a list' })).toBeNull();
  });

  it('is known from a list, and not known from an error, a refusal or an answer that is not a list', async () => {
    expect(await readLiveness(respond(200, [entry('p1', true)]))).toMatchObject({ kind: 'known' });
    expect(await readLiveness(respond(503, {}))).toEqual({ kind: 'unknown', reason: 'BaseApi answered HTTP 503' });
    expect(await readLiveness(respond(200, {}))).toEqual({ kind: 'unknown', reason: "BaseApi's answer is not a list" });
    expect(await readLiveness((async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toEqual({ kind: 'unknown', reason: 'BaseApi could not be read' });
  });

  it('judges each processor: healthy, unhealthy, or undetermined while not known or not listed', () => {
    const known: Liveness = { kind: 'known', processors: livenessOf([entry('p1', true, 2, 2), entry('p2', false)])! };
    expect(['p1', 'P2', 'p3'].map((id) => healthOf(known, id))).toEqual(['healthy', 'unhealthy', 'undetermined']);
    expect(healthOf({ kind: 'checking' }, 'p1')).toBe('undetermined');
    expect(healthOf({ kind: 'unknown', reason: 'x' }, 'p1')).toBe('undetermined');
    expect(healthLine(known, 'p1', false)).toBe('Healthy · 2 of 2 replicas healthy');
    expect(healthLine(known, 'p2', false)).toMatch(/^Unhealthy · no healthy replica \(1 checked/);
    expect(healthLine(known, 'p3', false)).toBe('Not known: BaseApi does not list this processor');
    expect(healthLine(known, 'p1', true)).toMatch(/^Not known: made in Valence/);
    expect(healthLine({ kind: 'unknown', reason: 'BaseApi answered HTTP 503' }, 'p1', false)).toBe('Not known: BaseApi answered HTTP 503');
  });

  it('logs a change in the Output pane, not the first report; BaseApi not answering is said once', () => {
    const data = {
      workflows: [], steps: [], schemas: [], assignments: [], caches: [],
      processors: [{ id: 'p1', name: 'fetcher', version: '1.0.0', description: null, sourceHash: 'a'.repeat(64), instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null }],
    } as unknown as ProjectData;
    const ws = createWorkspace();
    ws.loaded(data, buildMolecule(data));
    const lines = () => ws.get().messages.map((m) => m.text);
    const known = (live: boolean): Liveness => ({ kind: 'known', processors: livenessOf([entry('p1', live)])! });
    ws.livenessRead(known(true));
    expect(lines()).toEqual([]);
    ws.livenessRead(known(true));
    expect(lines()).toEqual([]);
    ws.livenessRead(known(false));
    expect(lines().at(-1)).toBe('Health: fetcher is unhealthy — no healthy replica (1 checked: 0 absent, 0 unhealthy, 0 stale, 0 malformed)');
    ws.livenessRead(known(true));
    expect(lines().at(-1)).toBe('Health: fetcher is healthy (1 of 1 replica)');
    ws.livenessRead({ kind: 'unknown', reason: 'BaseApi could not be read' });
    ws.livenessRead({ kind: 'unknown', reason: 'BaseApi could not be read' });
    expect(lines().filter((l) => l.startsWith('Health: not known'))).toHaveLength(1);
    ws.livenessRead(known(true));
    expect(lines().at(-1)).toBe('Health: BaseApi answers again');
    expect(ws.get().liveness.kind).toBe('known');
  });
});
