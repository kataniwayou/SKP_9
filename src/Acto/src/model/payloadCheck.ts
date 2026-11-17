import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

/**
 * An assignment's payload checked against its processor's config schema while it is typed (the user, 2026-11-02). Only
 * a hint: BaseApi's Save still judges it, and it checks a step only once the step is wired into the workflow. Draft
 * 2020-12, as BaseApi's JsonSchema.Net; `format` is not asserted, as there. A value still a `payloadSkeleton` marker
 * ("<integer>") is named as one, though a "<string>" passes the schema.
 */
export type PayloadCheck = { problems: string[] } | { unchecked: string };

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
/** By definition text: a schema is compiled once however often the payload is typed. */
const compiled = new Map<string, ValidateFunction | string>();

function validatorOf(definition: string): ValidateFunction | string {
  const known = compiled.get(definition);
  if (known !== undefined) return known;
  let made: ValidateFunction | string;
  try {
    made = ajv.compile(JSON.parse(definition) as object);
  } catch {
    // not JSON, not a schema, or a $ref the browser cannot follow
    made = 'The config schema could not be checked here; Save checks it.';
  }
  compiled.set(definition, made);
  return made;
}

const MARKER = /^<([a-z]+)>$/;
const ARTICLE: Readonly<Record<string, string>> = {
  string: 'a string', integer: 'an integer', number: 'a number', boolean: 'true or false', object: 'an object', array: 'an array', value: 'a value',
};

/** A JSON Pointer token, escaped. */
const token = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** The paths of the values still a marker, with the type each names. */
function markersIn(value: unknown, path: string, out: Map<string, string>): void {
  if (typeof value === 'string') {
    const m = MARKER.exec(value);
    if (m) out.set(path, m[1]!);
  } else if (Array.isArray(value)) value.forEach((v, i) => markersIn(v, `${path}/${i}`, out));
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) markersIn(v, `${path}/${token(k)}`, out);
}

function describe(e: ErrorObject): string {
  const at = e.instancePath === '' ? '/' : e.instancePath;
  const p = e.params as Record<string, unknown>;
  if (e.keyword === 'required') return `${at}: missing required "${String(p.missingProperty)}"`;
  if (e.keyword === 'additionalProperties') return `${at}: "${String(p.additionalProperty)}" is not in the schema`;
  if (e.keyword === 'enum' && Array.isArray(p.allowedValues)) return `${at}: must be one of ${p.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
  return `${at}: ${e.message ?? 'is not valid'}`;
}

/** The payload's problems against the config schema's definition; none for a payload that is not JSON (the field says so). */
export function checkPayload(definition: string, payload: string): PayloadCheck {
  const validate = validatorOf(definition);
  if (typeof validate === 'string') return { unchecked: validate };
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { problems: [] };
  }
  const markers = new Map<string, string>();
  markersIn(value, '', markers);
  const problems = [...markers].map(([path, type]) => `${path || '/'}: still a placeholder: fill in ${ARTICLE[type] ?? `a ${type}`}`);
  if (!validate(value)) {
    // a marker's own type error says nothing more than "still a placeholder"
    for (const e of validate.errors ?? []) if (!(markers.has(e.instancePath) && e.keyword === 'type')) problems.push(describe(e));
  }
  return { problems: [...new Set(problems)] };
}
