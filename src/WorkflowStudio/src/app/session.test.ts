import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { EMPTY_INSPECTOR } from '../store/inspector';
import { EMPTY_DRAFT } from '../design/draft';
import { EMPTY_EDITS } from '../design/design';
import { historyOf } from '../design/history';
import { INITIAL_STATE, reduce, type StudioState } from '../store/studioState';
import { loadedDocument } from './fixtures';
import { createSaver, keepSession, readSession, readTabSession, restoredState, SESSION_KEY, sessionOf, writeSession, writeTabSession, type Session } from './session';

const dock = { version: 1, dock: { grid: { root: { type: 'branch', data: [] }, width: 1200, height: 700, orientation: 'HORIZONTAL' }, panels: {} }, documentGroupId: null, hidden: [], sides: {}, homes: {}, popped: [] };

const good: Session = {
  version: 1,
  docs: [
    { workflowId: 'a', name: 'orders', version: '1.0.0', selection: { kind: 'step', stepId: 's1' }, view: { x: -40, y: 12, zoom: 0.8, followFit: false } },
    { workflowId: 'b', name: 'billing', version: '2.0.0', selection: null, view: null },
  ],
  activeId: 'b',
  showDetails: true,
  dock: dock as Session['dock'],
};

afterEach(() => { vi.useRealTimers(); });

describe('readSession / writeSession', () => {
  it('round-trips a session', () => {
    const storage = memoryStorage();
    expect(writeSession(storage, good)).toBe(true);
    expect(readSession(storage)).toEqual(good);
  });

  // Review focus 1: a broken or foreign session never breaks the page.
  it.each([
    ['nothing stored', undefined],
    ['not JSON', '{oops'],
    ['another version', JSON.stringify({ ...good, version: 2 })],
    ['not an object', '[]'],
  ])('reads %s as no session', (_label, text) => {
    expect(readSession(memoryStorage(text === undefined ? {} : { [SESSION_KEY]: text }))).toBeNull();
  });

  it('keeps the valid parts: a bad document entry, a bad selection, a bad view and a bad dock are dropped, not the session', () => {
    const text = JSON.stringify({
      ...good,
      docs: [good.docs[0], { workflowId: 7 }, { ...good.docs[1], selection: { kind: 'wire' }, view: { x: 'far' } }],
      activeId: 'gone',
      dock: { version: 1, dock: { nonsense: true } },
    });
    const read = readSession(memoryStorage({ [SESSION_KEY]: text }))!;
    expect(read.docs.map((d) => d.workflowId)).toEqual(['a', 'b']);
    expect(read.docs[1]).toEqual({ ...good.docs[1], selection: null, view: null });
    expect(read.activeId).toBe('a');            // an active id that is not open falls back to the first document
    expect(read.dock).toBeNull();
  });

  it('keeps the canvas size a view was taken at, and drops a view whose size is not a positive number', () => {
    const sized = { ...good.docs[0]!, view: { x: -40, y: 12, zoom: 0.8, followFit: false, width: 1200, height: 806 } };
    const bad = { ...good.docs[1]!, view: { x: 1, y: 2, zoom: 1, followFit: false, width: 0, height: 806 } };
    const read = readSession(memoryStorage({ [SESSION_KEY]: JSON.stringify({ ...good, docs: [sized, bad] }) }))!;
    expect(read.docs[0]!.view).toEqual(sized.view);
    expect(read.docs[1]!.view).toBeNull();
  });

  it('never throws when storage refuses', () => {
    const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(readSession(refusing)).toBeNull();
    expect(writeSession(refusing, good)).toBe(false);
    expect(readSession(null)).toBeNull();
    expect(writeSession(null, good)).toBe(false);
  });
});

describe('the session per tab (sessionStorage), mirrored to localStorage (controller ruling)', () => {
  const other: Session = { ...good, docs: [good.docs[1]!], activeId: 'b' };
  const holding = (session: Session) => memoryStorage({ [SESSION_KEY]: JSON.stringify(session) });

  it('reads the session of the tab itself over the mirror another tab may have written', () => {
    expect(readTabSession(holding(good), holding(other))).toEqual(good);
  });

  it('seeds an empty tab (a new tab, a browser restart) from the mirror', () => {
    expect(readTabSession(memoryStorage(), holding(other))).toEqual(other);
    expect(readTabSession(null, holding(other))).toEqual(other);
  });

  it('does not fall back to the mirror when the tab holds a session that cannot be used', () => {
    expect(readTabSession(memoryStorage({ [SESSION_KEY]: '{oops' }), holding(other))).toBeNull();
  });

  it('writes the tab and the mirror', () => {
    const tab = memoryStorage(), mirror = memoryStorage();
    expect(writeTabSession(tab, mirror, good)).toBe(true);
    expect(readSession(tab)).toEqual(good);
    expect(readSession(mirror)).toEqual(good);
  });

  it('never throws, and reports whether the next refresh will find the session', () => {
    const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(readTabSession(refusing, holding(other))).toEqual(other);
    expect(readTabSession(refusing, refusing)).toBeNull();
    const mirror = memoryStorage();
    expect(writeTabSession(refusing, mirror, good)).toBe(true);    // an unreadable tab holds no entry: the refresh reads the mirror
    expect(readSession(mirror)).toEqual(good);
    expect(writeTabSession(null, mirror, good)).toBe(true);        // no tab storage: the refresh seeds from the mirror
    expect(writeTabSession(memoryStorage(), refusing, good)).toBe(true);
    expect(writeTabSession(null, null, good)).toBe(false);
  });
});

describe('sessionOf / restoredState', () => {
  it('keeps each open document with its selection and view, and drops views of closed documents', () => {
    const state: StudioState = {
      ...INITIAL_STATE,
      docs: [{ workflowId: 'a', name: 'orders', version: '1.0.0', status: { kind: 'loading' }, selection: { kind: 'workflow' }, inspector: EMPTY_INSPECTOR, picks: [], design: historyOf(), edits: EMPTY_EDITS, stored: null, restored: false, saving: false, errors: null, run: null, generation: 0 }],
      activeId: 'a',
      showDetails: true,
    };
    const views = new Map([['a', { x: 1, y: 2, zoom: 1.5, followFit: false }], ['closed', { x: 9, y: 9, zoom: 9, followFit: false }]]);
    expect(sessionOf(state, views, null)).toEqual({
      version: 1, activeId: 'a', showDetails: true, dock: null,
      docs: [{ workflowId: 'a', name: 'orders', version: '1.0.0', selection: { kind: 'workflow' }, view: { x: 1, y: 2, zoom: 1.5, followFit: false } }],
    });
  });

  it('starts the store from a session: every document loading, with its selection, and the active one', () => {
    const state = restoredState(good);
    expect(state.docs.map((d) => [d.workflowId, d.name, d.status.kind, d.selection])).toEqual([
      ['a', 'orders', 'loading', { kind: 'step', stepId: 's1' }],
      ['b', 'billing', 'loading', null],
    ]);
    expect([state.activeId, state.showDetails]).toEqual(['b', true]);
    expect(restoredState(null)).toBe(INITIAL_STATE);
  });
});

describe('createSaver', () => {
  it('writes once, 300 ms after the last change', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const saver = createSaver(write);
    saver.schedule(); vi.advanceTimersByTime(200); saver.schedule(); vi.advanceTimersByTime(200);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('writes a pending change at once on flush, and nothing when none is pending (review focus 4)', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const saver = createSaver(write);
    saver.flush();
    expect(write).not.toHaveBeenCalled();
    saver.schedule();
    saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('the draft (slice 3b, spec §6.1)', () => {
  it("keeps the Inspector's trail across a refresh, and drops a broken one", () => {
    const storage = memoryStorage();
    const trail = [{ kind: 'processor', id: 'p1' }];
    writeSession(storage, { version: 1, activeId: 'wf1', showDetails: false, dock: null,
      docs: [{ workflowId: 'wf1', name: 'a', version: '1', selection: { kind: 'step', stepId: 's1' }, view: null, draft: { trail } as never }] });
    expect(restoredState(readSession(storage)).docs[0]!.inspector.trail).toEqual(trail);
    storage.setItem(SESSION_KEY, JSON.stringify({ version: 1, docs: [{ workflowId: 'wf1', name: 'a', version: '1', draft: { trail: [{ kind: 'nope' }] } }] }));
    expect(restoredState(readSession(storage)).docs[0]!.inspector.trail).toEqual([]);
  });

  it('a session write counts as kept when the next refresh will read it', () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(writeTabSession(refusing, memoryStorage(), good)).toBe(true);             // the tab holds no entry: the mirror is read
    const stale = memoryStorage({ [SESSION_KEY]: JSON.stringify(good) });
    const staleRefusing = { getItem: (k: string) => stale.getItem(k), setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(writeTabSession(staleRefusing, memoryStorage(), good)).toBe(false);       // a refresh would read the tab's old entry
  });
});

describe('the design draft (plan 4)', () => {
  const storageWith = (session: unknown) => { const st = memoryStorage(); st.setItem(SESSION_KEY, JSON.stringify(session)); return st; };
  const draft = { ...EMPTY_DRAFT, steps: { s1: { x: 8, y: 16 } } };

  it('keeps a document draft across a write and a read, with an empty history', async () => {
    let state = reduce(reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }),
      { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument() });
    state = reduce(state, { type: 'design', workflowId: 'wf1', draft });
    const storage = memoryStorage();
    writeSession(storage, sessionOf(state, new Map(), null));
    const back = restoredState(readSession(storage));
    expect(back.docs[0]!.design.draft).toEqual(draft);
    expect(back.docs[0]!.design.past).toEqual([]);
  });

  it('drops a malformed design draft (review focus 2)', () => {
    const storage = memoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ version: 1, docs: [{ workflowId: 'wf1', name: 'a', version: '1', selection: null, view: null, design: 'junk' }], activeId: 'wf1', showDetails: false, dock: null }));
    const back = restoredState(readSession(storage));
    expect(back.docs[0]!.design.draft).toEqual(EMPTY_DRAFT);
  });

  it('writes the design and the edits only while they differ from the stored design, and restores both (plan 8 §3.2)', async () => {
    let s = reduce(reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }),
      { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument() });
    expect(sessionOf(s, new Map(), null).docs[0]!.design).toBeUndefined();
    expect(sessionOf(s, new Map(), null).docs[0]!.edits).toBeUndefined();
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, wires: { 'w:l1': { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 8, y: 8 } } } } });
    const written = JSON.parse(JSON.stringify(sessionOf(s, new Map(), null)));
    const back = restoredState(readSession(storageWith(written))).docs[0]!;
    expect(back.design.draft.wires!['w:l1']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 8, y: 8 } });
    expect(back.edits).toEqual(EMPTY_EDITS);
    expect(back.restored).toBe(true);
  });
});

describe('Output in the session (2026-10-09: a refresh keeps the log)', () => {
  const lines = [
    { at: '2026-10-09T09:00:00Z', workflowId: 'a', name: 'orders', text: 'Save started: sending the layout only', level: 'info' as const },
    { at: '2026-10-09T09:00:01Z', workflowId: 'a', name: 'orders', text: 'Saved; not applied: 1 error', level: 'error' as const },
  ];

  it('writes the log with the session, reads it back with its levels, and starts the store from it', () => {
    const state: StudioState = { ...restoredState(good), output: lines };
    const storage = memoryStorage();
    expect(writeSession(storage, sessionOf(state, new Map(), null))).toBe(true);
    const read = readSession(storage)!;
    expect(read.output).toEqual(lines);
    expect(restoredState(read).output).toEqual(lines);
  });

  it('leaves the log out while it is empty, and reads a session without one (written before) as no lines', () => {
    expect(sessionOf(restoredState(good), new Map(), null)).not.toHaveProperty('output');
    expect(restoredState(readSession(memoryStorage({ [SESSION_KEY]: JSON.stringify(good) }))).output).toEqual([]);
  });

  it('a browser that refuses the session for its size keeps it with the log trimmed, then without it, never dropping the documents', () => {
    const big = Array.from({ length: 300 }, (_, i) => ({ ...lines[0]!, text: `line ${i}` }));
    const session = sessionOf({ ...restoredState(good), output: big }, new Map(), null);
    // a tab storage that takes a session only while its log is at most `fits` lines
    const limited = (fits: number) => {
      const inner = memoryStorage();
      return { ...inner, getItem: (k: string) => inner.getItem(k), setItem: (k: string, v: string) => {
        if ((JSON.parse(v).output?.length ?? 0) > fits) throw new Error('QuotaExceededError');
        inner.setItem(k, v);
      } } as unknown as Storage;
    };
    const roomy = limited(1000), tight = limited(100), tiny = limited(0);
    expect(keepSession(roomy, null, session)).toBe(true);
    expect(readSession(roomy)!.output).toHaveLength(300);
    expect(keepSession(tight, null, session)).toBe(true);
    expect(readSession(tight)!.output!.map((l) => l.text)).toEqual(big.slice(-100).map((l) => l.text));
    expect(keepSession(tiny, null, session)).toBe(true);
    expect(readSession(tiny)!.docs.map((d) => d.workflowId)).toEqual(['a', 'b']);
    expect(readSession(tiny)).not.toHaveProperty('output');
  });

  it('drops what is not a line, reads an unknown level as info, and keeps at most the last 500', () => {
    const many = Array.from({ length: 520 }, (_, i) => ({ ...lines[0]!, text: `line ${i}` }));
    const text = JSON.stringify({ ...good, output: [7, { text: 'no time' }, { ...lines[1], level: 'loud' }, ...many] });
    const read = readSession(memoryStorage({ [SESSION_KEY]: text }))!;
    expect(read.output).toHaveLength(500);
    expect(read.output![0]!.text).toBe('line 20');
    expect(readSession(memoryStorage({ [SESSION_KEY]: JSON.stringify({ ...good, output: [{ ...lines[1], level: 'loud' }] }) }))!.output).toEqual([{ ...lines[1], level: 'info' }]);
    expect(readSession(memoryStorage({ [SESSION_KEY]: JSON.stringify({ ...good, output: 'x' }) }))).not.toHaveProperty('output');
  });
});
