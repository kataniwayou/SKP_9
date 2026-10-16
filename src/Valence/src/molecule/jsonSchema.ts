/**
 * Whether a value is a valid JSON Schema of draft 2020-12, in the shape BaseApi's schema validators check it
 * (`MetaSchemas.Draft202012.Evaluate`): every keyword the draft defines holds a value of its kind, down through every
 * subschema. Formats are annotations there (a `pattern` or `$id` is not parsed), so they are not checked here either.
 * This catches the mistakes a hand edit makes while typing; BaseApi stays the judge on apply.
 */

const TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
/** Keywords whose value is one schema. */
const ONE = ['additionalProperties', 'propertyNames', 'items', 'contains', 'not', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema'];
/** Keywords whose value is an object of schemas. */
const MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];
/** Keywords whose value is a non-empty array of schemas. */
const LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const COUNTS = ['maxLength', 'minLength', 'maxItems', 'minItems', 'maxContains', 'minContains', 'maxProperties', 'minProperties'];
const NUMBERS = ['maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum'];
const STRINGS = ['$id', '$schema', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor', '$comment', 'title', 'description', 'format', 'pattern', 'contentMediaType', 'contentEncoding'];
const FLAGS = ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const unique = (a: readonly unknown[]) => new Set(a.map((x) => JSON.stringify(x))).size === a.length;
const path = (at: string, key: string | number) => `${at}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** The first problem found, as `where: what`, or null when the value is a valid draft 2020-12 schema. */
export function schemaProblem(value: unknown, at = ''): string | null {
  if (typeof value === 'boolean') return null;
  if (!isObject(value)) return `${at || 'the root'}: a schema is an object or true/false`;
  const s = value;
  for (const k of ONE) if (k in s) { const p = schemaProblem(s[k], path(at, k)); if (p) return p; }
  for (const k of MAP) {
    if (!(k in s)) continue;
    if (!isObject(s[k])) return `${path(at, k)}: an object of schemas`;
    // the old `dependencies` may also map a property to the names it requires
    for (const [name, sub] of Object.entries(s[k] as object)) {
      if (k === 'dependencies' && Array.isArray(sub)) continue;
      const p = schemaProblem(sub, path(path(at, k), name)); if (p) return p;
    }
  }
  for (const k of LIST) {
    if (!(k in s)) continue;
    const v = s[k];
    if (!Array.isArray(v) || v.length === 0) return `${path(at, k)}: a non-empty list of schemas`;
    for (let i = 0; i < v.length; i++) { const p = schemaProblem(v[i], path(path(at, k), i)); if (p) return p; }
  }
  if ('type' in s) {
    const t = s.type;
    const ok = typeof t === 'string' ? TYPES.has(t) : Array.isArray(t) && t.length > 0 && unique(t) && t.every((x) => typeof x === 'string' && TYPES.has(x));
    if (!ok) return `${path(at, 'type')}: one of ${[...TYPES].join(', ')}, or a list of them without repeats`;
  }
  if ('enum' in s && !Array.isArray(s.enum)) return `${path(at, 'enum')}: a list`;
  if ('examples' in s && !Array.isArray(s.examples)) return `${path(at, 'examples')}: a list`;
  for (const k of COUNTS) if (k in s && !(Number.isInteger(s[k]) && (s[k] as number) >= 0)) return `${path(at, k)}: a whole number, 0 or more`;
  for (const k of NUMBERS) if (k in s && typeof s[k] !== 'number') return `${path(at, k)}: a number`;
  if ('multipleOf' in s && !(typeof s.multipleOf === 'number' && s.multipleOf > 0)) return `${path(at, 'multipleOf')}: a number above 0`;
  for (const k of STRINGS) if (k in s && typeof s[k] !== 'string') return `${path(at, k)}: text`;
  for (const k of FLAGS) if (k in s && typeof s[k] !== 'boolean') return `${path(at, k)}: true or false`;
  const names = (v: unknown) => Array.isArray(v) && unique(v) && v.every((x) => typeof x === 'string');
  if ('required' in s && !names(s.required)) return `${path(at, 'required')}: a list of property names without repeats`;
  if ('dependentRequired' in s) {
    if (!isObject(s.dependentRequired)) return `${path(at, 'dependentRequired')}: an object of name lists`;
    for (const [k, v] of Object.entries(s.dependentRequired)) if (!names(v)) return `${path(path(at, 'dependentRequired'), k)}: a list of property names without repeats`;
  }
  if ('$vocabulary' in s && !(isObject(s.$vocabulary) && Object.values(s.$vocabulary).every((v) => typeof v === 'boolean'))) {
    return `${path(at, '$vocabulary')}: an object of true/false`;
  }
  return null;
}
