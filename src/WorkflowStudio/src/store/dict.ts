/**
 * A string-to-string dictionary field (2026-10-10: a cache's items). BaseApi's rules (CacheDtoValidator.CheckItems): a
 * JSON object; every key non-empty and free of ':' (the key is part of its L2 key `…:cache:{root}:{key}`); every value a
 * string; at most 1 MB of text. The studio keeps the stored order, which `JSON.parse` would not (it puts integer-like keys
 * first), so the object is read and written here by hand.
 */

/** One entry: its key and its value. */
export type DictEntry = readonly [key: string, value: string];

/** BaseApi's cap on the items text (CacheRules.MaxItemsChars). */
export const MAX_DICT_CHARS = 1_048_576;

/** Why a key cannot be stored, or null when it can (BaseApi's rules; `others` are the other keys, for duplicates). */
export function keyProblem(key: string, others: readonly string[]): string | null {
  if (key.length === 0) return 'Key is empty';
  if (key.includes(':')) return "Key must not contain ':'";
  if (others.includes(key)) return 'Duplicate key';
  return null;
}

/** The entries as the JSON object the field stores: compact, in their order. */
export function dictText(entries: readonly DictEntry[]): string {
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`;
}

/** The entries as JSON for reading: one entry a line, two spaces in. */
export function dictPretty(entries: readonly DictEntry[]): string {
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`;
}

/** Why stored text is no string dictionary, or null when it is (its size included). */
export function textProblem(text: string): string | null {
  if (text.length > MAX_DICT_CHARS) return `Items must be at most ${MAX_DICT_CHARS} characters`;
  return null;
}

export type DictParse = { ok: true; entries: DictEntry[] } | { ok: false; reason: string };

const WS = /[ \t\n\r]*/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

/**
 * The stored text as entries in their order, or why it is not a string dictionary. Blank text is the empty dictionary
 * (a cache made without items). A key that appears twice is refused: the table could not show both.
 */
export function parseDict(text: string): DictParse {
  if (text.trim() === '') return { ok: true, entries: [] };
  const size = textProblem(text);
  if (size) return { ok: false, reason: size };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'Items must be a JSON object' };
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') return { ok: false, reason: `The value of '${k}' must be a string` };
  }
  // valid JSON, an object of strings: walk it once more for the order (and any key written twice)
  let at = 0;
  const skip = () => { WS.lastIndex = at; WS.exec(text); at = WS.lastIndex; };
  const str = (): string => {
    STRING.lastIndex = at;
    const m = STRING.exec(text);
    if (!m) throw new Error('string expected');
    at = STRING.lastIndex;
    return JSON.parse(m[0]) as string;
  };
  const entries: DictEntry[] = [];
  const seen = new Set<string>();
  skip(); at++; skip(); // '{'
  if (text[at] === '}') return { ok: true, entries };
  for (;;) {
    const key = str(); skip(); at++; skip(); // ':'
    const value = str(); skip();
    if (key.length === 0) return { ok: false, reason: 'Items must not contain an empty key' };
    if (key.includes(':')) return { ok: false, reason: `Key '${key}' must not contain ':'` };
    if (seen.has(key)) return { ok: false, reason: `Key '${key}' appears twice` };
    seen.add(key);
    entries.push([key, value]);
    if (text[at] === ',') { at++; skip(); continue; }
    return { ok: true, entries };
  }
}
