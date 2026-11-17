import { describe, expect, it } from 'vitest';
import { readDrafts, writeDrafts } from './drafts';
import { bwFull } from './fixtures';
import { historyOf } from './history';
import { stateOf } from './state';
import { memoryStorage } from './testStorage';

describe('drafts', () => {
  it('round-trips and removes the key when empty', () => {
    const s = memoryStorage();
    const d = { w1: { updatedAt: 'u', history: historyOf(stateOf(bwFull())) } };
    writeDrafts(s, d);
    expect(readDrafts(s)).toEqual(d);
    writeDrafts(s, {});
    expect(s.getItem('acto.drafts')).toBeNull();
  });
  it('ignores garbage and a missing storage', () => {
    const s = memoryStorage();
    s.setItem('acto.drafts', '{nope');
    expect(readDrafts(s)).toEqual({});
    s.setItem('acto.drafts', JSON.stringify({ w1: { updatedAt: 'u', history: { present: 1 } } }));
    expect(readDrafts(s)).toEqual({});
    expect(readDrafts(null)).toEqual({});
    expect(() => writeDrafts(null, {})).not.toThrow();
  });
});
