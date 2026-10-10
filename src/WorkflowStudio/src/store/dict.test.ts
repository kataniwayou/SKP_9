import { describe, expect, it } from 'vitest';
import { dictPretty, dictText, keyProblem, MAX_DICT_CHARS, parseDict } from './dict';

describe('a string dictionary field (2026-10-10, a cache\'s items)', () => {
  it('reads the entries in their stored order, integer-like keys included (JSON.parse would put them first)', () => {
    expect(parseDict('{"usd":"3.7","10":"ten","eur":"4.0"}')).toEqual({ ok: true, entries: [['usd', '3.7'], ['10', 'ten'], ['eur', '4.0']] });
    expect(parseDict(' {\n  "a" : "x\\"y" ,\n "b":"\\u00e9" }\n')).toEqual({ ok: true, entries: [['a', 'x"y'], ['b', 'é']] });
    expect(parseDict('{}')).toEqual({ ok: true, entries: [] });
    expect(parseDict('')).toEqual({ ok: true, entries: [] });
  });

  it('refuses what BaseApi refuses: not JSON, not an object, a value not a string, an empty key, a key with a colon; and a key written twice', () => {
    expect(parseDict('{"a":')).toEqual({ ok: false, reason: 'Not valid JSON' });
    expect(parseDict('[1]')).toEqual({ ok: false, reason: 'Items must be a JSON object' });
    expect(parseDict('null')).toEqual({ ok: false, reason: 'Items must be a JSON object' });
    expect(parseDict('{"n":1}')).toEqual({ ok: false, reason: "The value of 'n' must be a string" });
    expect(parseDict('{"":"x"}')).toEqual({ ok: false, reason: 'Items must not contain an empty key' });
    expect(parseDict('{"a:b":"x"}')).toEqual({ ok: false, reason: "Key 'a:b' must not contain ':'" });
    expect(parseDict('{"a":"1","a":"2"}')).toEqual({ ok: false, reason: "Key 'a' appears twice" });
    expect(parseDict(`{"a":"${'x'.repeat(MAX_DICT_CHARS)}"}`)).toMatchObject({ ok: false });
  });

  it('writes the entries back compact, in their order; pretty for reading; round trip', () => {
    const entries = [['b', '2'], ['1', 'one'], ['q"', 'x\ny']] as const;
    expect(dictText(entries)).toBe('{"b":"2","1":"one","q\\"":"x\\ny"}');
    expect(parseDict(dictText(entries))).toEqual({ ok: true, entries });
    expect(parseDict(dictPretty(entries))).toEqual({ ok: true, entries });
    expect(dictPretty([])).toBe('{}');
  });

  it('a key\'s problem: empty, a colon, the same as another', () => {
    expect(keyProblem('', [])).toBe('Key is empty');
    expect(keyProblem('a:b', [])).toBe("Key must not contain ':'");
    expect(keyProblem('a', ['b', 'a'])).toBe('Duplicate key');
    expect(keyProblem('a', ['b'])).toBeNull();
  });
});
