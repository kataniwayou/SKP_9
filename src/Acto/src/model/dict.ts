// Ported from WorkflowStudio's store/dict.ts (2026-11-18); the rules are BaseAPI's own (CacheDtoValidator.CheckItems).
/**
 * A string-to-string dictionary field (a cache's items). BaseApi's rules (CacheRules.CheckItems): every key non-empty,
 * free of ':' (the key is part of its L2 key `…:cache:{root}:{key}`) and at most 256 characters; every value a string of
 * at most 1 MB; no bound on the dictionary as a whole (items are rows since 2026-11-24). Acto keeps the stored order, which `JSON.parse` would not (it puts integer-like keys
 * first), so the object is read and written here by hand.
 */

/** One entry: its key and its value. */
export type DictEntry = readonly [key: string, value: string];

/** BaseApi's bound on a key (CacheRules.MaxKeyLength). */
export const MAX_KEY_CHARS = 256;

/** BaseApi's bound on a value (CacheRules.MaxValueChars). */
export const MAX_VALUE_CHARS = 1_048_576;

/** Why a key cannot be stored, or null when it can (BaseApi's rules; `others` are the other keys, for duplicates). */
export function keyProblem(key: string, others: readonly string[]): string | null {
  if (key.length === 0) return 'Key is empty';
  if (key.includes(':')) return "Key must not contain ':'";
  if (key.length > MAX_KEY_CHARS) return `Key must be at most ${MAX_KEY_CHARS} characters`;
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

/** Why a value cannot be stored, or null when it can (BaseApi's rule). */
export function valueProblem(value: string): string | null {
  return value.length > MAX_VALUE_CHARS ? `Value must be at most ${MAX_VALUE_CHARS} characters` : null;
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
    if (key.length > MAX_KEY_CHARS) return { ok: false, reason: `Key '${key.slice(0, 40)}…' must be at most ${MAX_KEY_CHARS} characters` };
    if (value.length > MAX_VALUE_CHARS) return { ok: false, reason: `The value of '${key}' must be at most ${MAX_VALUE_CHARS} characters` };
    if (seen.has(key)) return { ok: false, reason: `Key '${key}' appears twice` };
    seen.add(key);
    entries.push([key, value]);
    if (text[at] === ',') { at++; skip(); continue; }
    return { ok: true, entries };
  }
}
