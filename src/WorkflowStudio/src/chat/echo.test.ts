import { describe, expect, it } from 'vitest';
import { graphDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createStudioStore } from '../store/studioStore';
import { echoText, withEcho } from './echo';

async function setup() {
  const store = createStudioStore();
  for (const [id, name] of [['wf1', 'orders'], ['wf2', 'other']] as const) {
    store.dispatch({ type: 'open', workflowId: id, name, version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: id, doc: await loadedDocument(graphDto()) });
  }
  return store;
}
const log = (store: Awaited<ReturnType<typeof setup>>, workflowId: string, text: string, level?: 'error') =>
  store.dispatch({ type: 'log', workflowId, lines: [{ at: '2026-10-23T10:00:00Z', text, ...(level ? { level } : {}) }] });

describe('withEcho', () => {
  it('collects the lines the action wrote for the touched workflow only, not earlier ones', async () => {
    const store = await setup();
    log(store, 'wf1', 'before');
    const { value, entries } = await withEcho(store, () => ['wf1'], async () => {
      log(store, 'wf1', 'one'); log(store, 'wf2', 'elsewhere'); log(store, 'wf1', 'bad', 'error');
      return 7;
    });
    expect(value).toBe(7);
    expect(entries).toEqual([
      { kind: 'output', text: 'one', level: 'info', name: 'orders' },
      { kind: 'output', text: 'bad', level: 'error', name: 'orders' },
    ]);
    expect(echoText(entries)).toBe('one\n[error] bad');
  });

  it('waits until the condition holds, with lines that arrive later, or until the timeout', async () => {
    const store = await setup();
    let over = false;
    setTimeout(() => { log(store, 'wf1', 'running'); over = true; }, 10);
    const a = await withEcho(store, () => ['wf1'], async () => undefined, () => over, 1000);
    expect(a.entries.map((e) => e.kind === 'output' && e.text)).toEqual(['running']);
    const b = await withEcho(store, () => ['wf1'], async () => undefined, () => false, 20);
    expect(b.entries).toEqual([]);
  });

  it('adds a problems entry only when the pinned problems changed', async () => {
    const store = await setup();
    const err = { kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' };
    const set = (errors: typeof err[]) => store.dispatch({ type: 'saveAnswered', workflowId: 'wf1', at: 'x', applied: false, errors, doc: null });
    const same = await withEcho(store, () => ['wf1'], async () => undefined);
    expect(same.entries).toEqual([]);
    const changed = await withEcho(store, () => ['wf1'], async () => set([err]));
    expect(changed.entries.at(-1)).toMatchObject({ kind: 'problems' });
    expect(echoText(changed.entries)).toMatch(/Problems now:\n- .*version: bad/);
    const again = await withEcho(store, () => ['wf1'], async () => set([err]));
    expect(again.entries.some((e) => e.kind === 'problems')).toBe(false);
    const cleared = await withEcho(store, () => ['wf1'], async () => set([]));
    expect(echoText(cleared.entries)).toContain('Problems now: none');
  });
});
