import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { readSession, readTabSession, SESSION_KEY, SESSION_VERSION, writeTabSession } from './session';

const entry = (value: unknown) => memoryStorage({ [SESSION_KEY]: JSON.stringify(value) });

describe('session', () => {
  it("uses Valence's own key, never SKP Studio's", () => {
    expect(SESSION_KEY).toBe('skp.valence.session');
  });

  it('reads back what it wrote', () => {
    const tab = memoryStorage();
    const mirror = memoryStorage();
    expect(writeTabSession(tab, mirror, { version: SESSION_VERSION, dock: null, highlighted: ['a', 'b'] })).toBe(true);
    expect(readTabSession(tab, null)).toEqual({ version: SESSION_VERSION, dock: null, highlighted: ['a', 'b'] });
    expect(readTabSession(null, mirror)?.highlighted).toEqual(['a', 'b']);
  });

  it('keeps the pinned atom and the unapplied edits, dropping what is not text', () => {
    const r = readSession(entry({ version: 1, dock: null, highlighted: [], pinned: 'proc:p1', edits: { 'proc:p1': { name: 'x', bad: 1 }, 'step:s': 'no' } }));
    expect(r?.pinned).toBe('proc:p1');
    expect(r?.edits).toEqual({ 'proc:p1': { name: 'x' } });
  });

  it('keeps only distinct, non-empty ids', () => {
    expect(readSession(entry({ version: 1, dock: null, highlighted: ['a', '', 7, 'a', 'b'] }))?.highlighted).toEqual(['a', 'b']);
  });

  it('is no session when the entry is broken or of another version', () => {
    expect(readSession(memoryStorage({ [SESSION_KEY]: '{' }))).toBeNull();
    expect(readSession(entry({ version: 2, highlighted: [] }))).toBeNull();
  });

  it('keeps the view (camera and atom places) across a browser restart, dropping an atom whose place is broken', () => {
    const view = { camera: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], shift: { x: 90, y: -40 }, atoms: { 'step:s1': [1, 1, 1], 'proc:p1': [1, 'x', 1] } };
    const mirror = memoryStorage();
    writeTabSession(memoryStorage(), mirror, { version: SESSION_VERSION, dock: null, highlighted: [], view: view as never });
    // a restart: the tab's storage is gone, the mirror seeds the new tab
    expect(readTabSession(memoryStorage(), mirror)?.view).toEqual({ ...view, atoms: { 'step:s1': [1, 1, 1] } });
    expect(readSession(entry({ version: 1, dock: null, highlighted: [], view: { ...view, camera: [1, 2] } }))?.view).toBeUndefined();
  });

  it("prefers the tab's own entry; the mirror only seeds a tab with none", () => {
    const tab = entry({ version: 1, dock: null, highlighted: ['tab'] });
    const mirror = entry({ version: 1, dock: null, highlighted: ['mirror'] });
    expect(readTabSession(tab, mirror)?.highlighted).toEqual(['tab']);
    expect(readTabSession(memoryStorage(), mirror)?.highlighted).toEqual(['mirror']);
  });
});
