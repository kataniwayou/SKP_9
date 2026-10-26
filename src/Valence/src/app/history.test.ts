import { afterEach, describe, expect, it } from 'vitest';
import { canvasBridge } from '../molecule/bridge';
import type { ProjectData } from '../api/project';
import { arrowKey, atomKey, buildMolecule } from '../molecule/model';
import { readSession, SESSION_KEY, SESSION_VERSION, writeSession } from './session';
import { createWorkspace } from './workspace';
import { memoryStorage } from '../test/memoryStorage';

// one workflow entering at s1, which runs on p1 and points on to s2 (also on p1); p1 reads c1
const row = (id: string, name: string) => ({ id, name, version: '1.0.0', description: null });
const data = {
  workflows: [{ ...row('w1', 'W1'), cronExpression: null, entryStepIds: ['s1'], assignmentIds: [], cacheIds: [] }],
  steps: [
    { ...row('s1', 's1'), processorId: 'p1', nextStepIds: ['s2'], entryCondition: 1 },
    { ...row('s2', 's2'), processorId: 'p1', nextStepIds: [], entryCondition: 1 },
  ],
  processors: [{ ...row('p1', 'p1'), sourceHash: 'a'.repeat(64), instanceId: null, inputSchemaId: 'c1', outputSchemaId: null, configSchemaId: null }],
  schemas: [{ ...row('c1', 'c1'), definition: '{}' }],
  assignments: [], caches: [],
} as unknown as ProjectData;
const S2 = atomKey('step', 's2'), P1 = atomKey('proc', 'p1'), C1 = atomKey('schema', 'c1');
const NEXT = arrowKey({ kind: 'next', from: atomKey('step', 's1'), to: S2 });
const loaded = () => { const ws = createWorkspace(); ws.loaded(data, buildMolecule(data)); return ws; };

afterEach(() => canvasBridge.set(null));

describe('the shared history of edits and deletions (the user, 2026-10-16)', () => {
  it('makes typing in one field one step, undone and redone as one', () => {
    const ws = loaded();
    ws.edit(C1, 'name', 'c', 'c1'); ws.edit(C1, 'name', 'c-', 'c1'); ws.edit(C1, 'name', 'c-x', 'c1');
    expect(ws.get().history.past).toHaveLength(1);
    ws.undo();
    expect(ws.get().edits).toEqual({});
    ws.redo();
    expect(ws.get().edits).toEqual({ [C1]: { name: 'c-x' } });
    // another field is another step
    ws.edit(C1, 'version', '2.0.0', '1.0.0');
    expect(ws.get().history.past).toHaveLength(2);
  });

  it('deletes under the rules, ghosting what goes, and steps back through edits and deletions in order', () => {
    const ws = loaded();
    ws.edit(S2, 'name', 'second', 's2');
    expect(ws.remove(S2)).toBe(true);
    expect(ws.remove(NEXT)).toBe(false); // gone with s2 already
    expect(ws.get().removed).toEqual({ atoms: [S2], arrows: [] });
    expect(ws.get().messages.at(-2)!.text).toMatch(/Deleted step second|Deleted step s2/);
    ws.undo();
    expect(ws.get().removed.atoms).toEqual([]);
    expect(ws.get().edits).toEqual({ [S2]: { name: 'second' } });
    ws.undo();
    expect(ws.get().edits).toEqual({});
    expect(ws.get().messages.at(-1)!.text).toBe('Undid: edit name of s2.');
    ws.redo(); ws.redo();
    expect(ws.get().removed.atoms).toEqual([S2]);
  });

  it('refuses with the reason in the Output pane and records nothing', () => {
    const ws = loaded();
    expect(ws.remove(P1)).toBe(false);
    expect(ws.get().history.past).toHaveLength(0);
    expect(ws.get().messages.at(-1)).toMatchObject({ tone: 'refused', text: expect.stringMatching(/p1 cannot be deleted/) });
    expect(ws.remove(null)).toBe(false);
    expect(ws.get().messages.at(-1)!.text).toMatch(/click an atom or arrow to pin it/);
  });

  it('deletes an arrow on its own, and a new change drops what could be redone', () => {
    const ws = loaded();
    expect(ws.remove(NEXT)).toBe(true);
    expect(ws.get().removed.arrows).toEqual([NEXT]);
    ws.undo();
    expect(ws.get().history.future).toHaveLength(1);
    ws.edit(C1, 'name', 'x', 'c1');
    expect(ws.get().history.future).toHaveLength(0);
    ws.redo();
    expect(ws.get().messages.at(-1)!.text).toBe('Nothing to redo.');
  });

  it('records a Revert as a step', () => {
    const ws = loaded();
    ws.edit(C1, 'name', 'x', 'c1');
    ws.revert(C1);
    expect(ws.get().edits).toEqual({});
    ws.undo();
    expect(ws.get().edits).toEqual({ [C1]: { name: 'x' } });
  });

  it('keeps the deletions and the history in the session across a refresh, dropping malformed steps', () => {
    const ws = loaded();
    ws.edit(C1, 'name', 'x', 'c1');
    ws.remove(S2);
    ws.undo();
    const { removed, history, edits } = ws.get();
    const storage = memoryStorage();
    writeSession(storage, { version: SESSION_VERSION, dock: null, highlighted: [], edits: { ...edits }, removed, history });
    const back = readSession(storage)!;
    expect(back.history).toEqual(history);
    const again = createWorkspace({ edits: back.edits, removed: back.removed, history: back.history });
    again.loaded(data, buildMolecule(data));
    again.redo();
    expect(again.get().removed.atoms).toEqual([S2]);

    storage.setItem(SESSION_KEY, JSON.stringify({ version: 1, dock: null, highlighted: [], removed: { atoms: [S2, 7], arrows: 'no' },
      history: { past: [{ label: 'ok', atoms: [S2] }, { nolabel: true }, 'x'], future: [] } }));
    expect(readSession(storage)).toMatchObject({ removed: { atoms: [S2], arrows: [] }, history: { past: [{ label: 'ok', atoms: [S2] }], future: [] } });
  });

  it('drops a restored deletion of a row the project no longer has', () => {
    const ws = createWorkspace({ removed: { atoms: [S2, 'step:gone'], arrows: [NEXT, 'next|step:x|step:y'] } });
    ws.loaded(data, buildMolecule(data));
    expect(ws.get().removed).toEqual({ atoms: [S2], arrows: [NEXT] });
  });
});
