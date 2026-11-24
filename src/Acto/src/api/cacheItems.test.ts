import { describe, expect, it } from 'vitest';
import { itemsFromText, itemsToText } from './cacheItems';

// BaseApi stores a cache's items as rows (2026-11-24) and sends them as [{ key, value }]; the board keeps its
// dictionary text, so the API boundary converts both ways.
describe('itemsToText', () => {
  it('writes the pairs as a compact object in their order', () => {
    expect(itemsToText([{ key: 'b', value: '2' }, { key: 'a', value: '1' }])).toBe('{"b":"2","a":"1"}');
  });

  it('writes nothing as the empty dictionary', () => {
    expect(itemsToText([])).toBe('{}');
    expect(itemsToText(null)).toBe('{}');
    expect(itemsToText(undefined)).toBe('{}');
  });
});

describe('itemsFromText', () => {
  it('reads the dictionary text back as pairs in its order', () => {
    expect(itemsFromText('{"b":"2","a":"1","10":"x"}')).toEqual([
      { key: 'b', value: '2' }, { key: 'a', value: '1' }, { key: '10', value: 'x' }]);
  });

  it('reads blank text and {} as no pairs', () => {
    expect(itemsFromText('')).toEqual([]);
    expect(itemsFromText('{}')).toEqual([]);
  });

  it('round-trips with itemsToText', () => {
    const pairs = [{ key: 'é', value: 'line\nbreak' }, { key: 'empty', value: '' }];
    expect(itemsFromText(itemsToText(pairs))).toEqual(pairs);
  });

  it('refuses text the board would not have kept, naming why', () => {
    expect(() => itemsFromText('{"a":"1","a":"2"}')).toThrow(/appears twice/);
    expect(() => itemsFromText('not json')).toThrow(/valid JSON/);
  });
});
