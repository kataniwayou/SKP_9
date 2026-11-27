import { describe, it, expect } from 'vitest';
import { pageView, pageSummary, summaryText, cursors } from './itemsPage';

const st = (...ks: string[]) => ks.map((k, i) => ({ key: k, value: String(i + 1) }));
const none = { atStart: false, atEnd: false };

describe('pageView', () => {
  it('marksModifiedAddedDeleted', () => {
    const { rows, cut } = pageView(st('a', 'b', 'c'), { set: { b: '9', bb: 'x' }, removed: ['c'] }, none, 10);
    expect(rows.map((r) => [r.key, r.state])).toEqual([['a', undefined], ['b', 'modified'], ['bb', 'added'], ['c', 'deleted']]);
    expect(rows[1].stored).toBe('2');
    expect(rows[1].value).toBe('9');
    expect(rows[2].stored).toBeNull();
    expect(cut).toBe(false);
  });
  it('sameValueIsUnchanged and deleted wins', () => {
    const { rows } = pageView(st('a', 'b'), { set: { a: '1', b: '7' }, removed: ['b'] }, none, 10);
    expect(rows[0].state).toBeUndefined();
    expect(rows[1].state).toBe('deleted');
    expect(rows[1].value).toBe('2');
  });
  it('addedOutsideThePageIsNotShown', () => {
    const { rows } = pageView(st('m', 'n'), { set: { a: '1', z: '2' }, removed: [] }, none, 10);
    expect(rows.map((r) => r.key)).toEqual(['m', 'n']);
  });
  it('addedBeforeTheFirstPageIsShownAtStart', () => {
    const { rows } = pageView(st('m', 'n'), { set: { a: '1', z: '2' }, removed: [] }, { atStart: true, atEnd: false }, 10);
    expect(rows.map((r) => r.key)).toEqual(['a', 'm', 'n']);
  });
  it('addedAfterTheLastPageIsShownAtEnd', () => {
    const { rows } = pageView(st('m', 'n'), { set: { a: '1', z: '2' }, removed: [] }, { atStart: false, atEnd: true }, 10);
    expect(rows.map((r) => r.key)).toEqual(['m', 'n', 'z']);
  });
  it('cutsToSize', () => {
    const { rows, cut } = pageView(st('a', 'c', 'e'), { set: { b: '1', d: '2' }, removed: [] }, none, 4);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(cut).toBe(true);
  });
  it('cursorsWhenNoStoredRowIsVisible', () => {
    const { rows } = pageView([], { set: { a: '1', b: '2' }, removed: [] }, { atStart: true, atEnd: true }, 10);
    expect(rows.map((r) => [r.key, r.state])).toEqual([['a', 'added'], ['b', 'added']]);
    expect(cursors(rows)).toEqual({ after: 'b', before: 'a' });
    expect(cursors([])).toEqual({ after: null, before: null });
  });
});

describe('server order', () => {
  it('storedOrderIsKeptAsReceived', () => {
    const { rows } = pageView(st('ab', 'a-b'), { set: {}, removed: [] }, none, 10);
    expect(rows.map((r) => r.key)).toEqual(['ab', 'a-b']);
    expect(cursors(rows)).toEqual({ after: 'a-b', before: 'ab' });
  });
  it('cursorsUseStoredKeysWhenVisible', () => {
    const { rows } = pageView(st('m', 'n'), { set: { a: '1', z: '2' }, removed: [] }, { atStart: true, atEnd: true }, 10);
    expect(rows.map((r) => r.key)).toEqual(['a', 'm', 'n', 'z']);
    expect(cursors(rows)).toEqual({ after: 'n', before: 'm' });
  });
  it('aKeyEqualToAStoredKeyIsModifiedNotAdded', () => {
    const { rows } = pageView(st('a', 'b'), { set: { b: 'new' }, removed: [] }, none, 10);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ key: 'b', state: 'modified', stored: '2', value: 'new' });
  });
  it('cursorsAfterACut', () => {
    const { rows, cut } = pageView(st('b', 'd', 'f'), { set: { a: '1', c: '2' }, removed: [] }, { atStart: true, atEnd: false }, 3);
    expect(cut).toBe(true);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(cursors(rows)).toEqual({ after: 'b', before: 'b' });
  });
});

describe('summary', () => {
  it('summaryTextWording', () => {
    expect(summaryText({ modified: 0, added: 0, deleted: 0 })).toBe('no unsaved changes on this page');
    expect(summaryText({ modified: 1, added: 2, deleted: 0 })).toBe('on this page: 1 modified · 2 added');
    expect(summaryText({ modified: 1, added: 1, deleted: 3 })).toBe('on this page: 1 modified · 1 added · 3 deleted');
  });
  it('pageSummary counts', () => {
    const { rows } = pageView(st('a', 'b', 'c'), { set: { b: '9', bb: 'x' }, removed: ['c'] }, none, 10);
    expect(pageSummary(rows)).toEqual({ modified: 1, added: 1, deleted: 1 });
  });
});
