import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { INITIAL_STATE, type StudioState } from '../store/studioState';
import { createSaver, readSession, restoredState, SESSION_KEY, sessionOf, writeSession, type Session } from './session';

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

  it('never throws when storage refuses', () => {
    const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(readSession(refusing)).toBeNull();
    expect(writeSession(refusing, good)).toBe(false);
    expect(readSession(null)).toBeNull();
    expect(writeSession(null, good)).toBe(false);
  });
});

describe('sessionOf / restoredState', () => {
  it('keeps each open document with its selection and view, and drops views of closed documents', () => {
    const state: StudioState = {
      ...INITIAL_STATE,
      docs: [{ workflowId: 'a', name: 'orders', version: '1.0.0', status: { kind: 'loading' }, selection: { kind: 'workflow' } }],
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
