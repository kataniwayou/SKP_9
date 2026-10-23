import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_KEY, createChatStore, LOST_AT_REFRESH, type ChatEntry } from './chatStore';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); },
  };
}

const hello: ChatEntry = { kind: 'user', text: 'hello' };

describe('chat store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes entries and wire 300 ms after the last change, and a new store reads them back', () => {
    const tab = memoryStorage();
    const store = createChatStore(tab);
    store.dispatch({ type: 'entries', add: [hello] });
    store.dispatch({ type: 'wire', add: [{ role: 'user', content: 'hello' }] });
    vi.advanceTimersByTime(299);
    expect(tab.getItem(CHAT_KEY)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tab.getItem(CHAT_KEY)).not.toBeNull();
    const again = createChatStore(tab).getState();
    expect(again.entries).toEqual([hello]);
    expect(again.wire).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('mirrors to the second storage, and a new tab reads the mirror', () => {
    const tab = memoryStorage();
    const mirror = memoryStorage();
    const store = createChatStore(tab, mirror);
    store.dispatch({ type: 'entries', add: [hello] });
    store.flush();
    expect(createChatStore(memoryStorage(), mirror).getState().entries).toEqual([hello]);
  });

  it('never restores busy: a chat stored busy comes back idle with a note, written once', () => {
    const tab = memoryStorage();
    const store = createChatStore(tab);
    store.dispatch({ type: 'entries', add: [hello] });
    store.dispatch({ type: 'busy', on: true });
    store.flush();
    const back = createChatStore(tab);
    expect(back.getState().busy).toBe(false);
    expect(back.getState().entries).toEqual([hello, LOST_AT_REFRESH]);
    expect(LOST_AT_REFRESH).toEqual({ kind: 'note', text: 'The request in flight was lost at refresh', level: 'error' });
    // a further refresh does not add it again
    expect(createChatStore(tab).getState().entries).toEqual([hello, LOST_AT_REFRESH]);
  });

  it('restores the question', () => {
    const tab = memoryStorage();
    const store = createChatStore(tab);
    const question = { callId: 'c1', text: 'Delete it?', choices: ['Yes', 'No'], warnings: ['It is used'] };
    store.dispatch({ type: 'ask', question });
    store.flush();
    expect(createChatStore(tab).getState().question).toEqual(question);
  });

  it('newChat empties everything', () => {
    const store = createChatStore(memoryStorage());
    store.dispatch({ type: 'entries', add: [hello] });
    store.dispatch({ type: 'wire', add: [{ role: 'user', content: 'x' }] });
    store.dispatch({ type: 'ask', question: { callId: 'c', text: 't', choices: [] } });
    store.dispatch({ type: 'busy', on: true });
    store.dispatch({ type: 'newChat' });
    expect(store.getState()).toEqual({ entries: [], wire: [], question: null, busy: false });
  });

  it('tells its listeners of a change, and not of none', () => {
    const store = createChatStore(null);
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.dispatch({ type: 'busy', on: false });
    expect(seen).not.toHaveBeenCalled();
    store.dispatch({ type: 'busy', on: true });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    store.dispatch({ type: 'busy', on: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it.each(['not json', '[]', '{"entries":3,"wire":[]}', 'null'])('a malformed stored value (%s) gives an empty chat', (bad) => {
    expect(createChatStore(memoryStorage({ [CHAT_KEY]: bad })).getState()).toEqual({ entries: [], wire: [], question: null, busy: false });
  });

  it('skips a stored entry it cannot read, and keeps the rest', () => {
    const stored = JSON.stringify({ entries: [hello, { kind: 'nope' }, { kind: 'action', text: 'x' }], wire: [{ role: 'user', content: 'a' }, 5], question: null, busy: false });
    const state = createChatStore(memoryStorage({ [CHAT_KEY]: stored })).getState();
    expect(state.entries).toEqual([hello]);
    expect(state.wire).toEqual([{ role: 'user', content: 'a' }]);
  });

  it('works with no storage and with a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } } as unknown as Storage;
    for (const s of [null, broken]) {
      const store = createChatStore(s);
      store.dispatch({ type: 'entries', add: [hello] });
      expect(() => store.flush()).not.toThrow();
      expect(store.getState().entries).toEqual([hello]);
    }
  });
});
