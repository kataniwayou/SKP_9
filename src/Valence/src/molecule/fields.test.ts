import { describe, expect, it } from 'vitest';
import type { ProjectData } from '../api/project';
import project from '../test/fixtures/project.json';
import { NOTHING_REMOVED } from './deletion';
import { arrowRows, definitionLock, detailRows, editStates, rowOf, savedText } from './fields';
import { atomKey, buildMolecule } from './model';
import { SNAPSHOT_RULES } from './rules';

// the field table built from BaseApi's description (the bundled snapshot of GET /model/fields)
const FIELDS = SNAPSHOT_RULES.table;
const field = (type: keyof typeof FIELDS, key: string) => FIELDS[type].find((f) => f.key === key)!;

describe("the field table, from BaseApi's description (the user's list, 2026-10-15)", () => {
  it('holds every writable field that is not an arrow, and no arrow field', () => {
    const keys = Object.fromEntries(Object.entries(FIELDS).map(([t, fs]) => [t, fs.map((f) => f.key)]));
    const common = ['name', 'version', 'description'];
    expect(keys).toEqual({
      wf: [...common, 'cronExpression'], step: [...common, 'entryCondition'], proc: [...common, 'sourceHash', 'instanceId'],
      schema: [...common, 'definition'], asg: [...common, 'payload'], cache: [...common, 'root', 'items'],
    });
  });

  it('locks only the schema definition, and only by a rule', () => {
    expect(Object.values(FIELDS).flat().filter((f) => f.lock).map((f) => f.key)).toEqual(['definition']);
  });

  it('checks a definition as JSON, then as a draft 2020-12 JSON Schema', () => {
    const def = field('schema', 'definition');
    expect(def.check('')).toBe('Definition is required');
    expect(def.check('{')).toMatch(/^Not valid JSON/);
    expect(def.check('{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}')).toBeNull();
    expect(def.check('true')).toBeNull();
    expect(def.check('[]')).toBe('Not a valid JSON Schema (draft 2020-12) — the root: a schema is an object or true/false');
    expect(def.check('{"properties":{"a":{"type":"text"}}}')).toMatch(/^Not a valid JSON Schema \(draft 2020-12\) — \/properties\/a\/type: one of/);
    expect(def.check('{"required":["a","a"]}')).toMatch(/\/required: a list of property names without repeats$/);
    expect(def.check('{"minLength":-1}')).toMatch(/\/minLength: a whole number, 0 or more$/);
    expect(def.check('{"allOf":[]}')).toMatch(/\/allOf: a non-empty list of schemas$/);
    expect(def.check('{"x-own":1,"pattern":"[","format":"anything"}')).toBeNull(); // unknown keywords and formats are annotations
  });

  it("checks BaseApi's rules, with BaseApi's own messages where it has them", () => {
    expect(field('wf', 'name').check('')).toBe('Name is required');
    expect(field('wf', 'name').check('x'.repeat(201))).toBe('Name is at most 200 characters');
    expect(field('wf', 'version').check('1.0')).toBe('Version does not match ^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$');
    expect(field('wf', 'version').check('01.0.0')).toMatch(/^Version does not match /);
    expect(field('wf', 'version').check('2.10.0')).toBeNull();
    expect(field('wf', 'cronExpression').check('')).toBeNull();
    expect(field('wf', 'cronExpression').check('0 * * * *')).toBeNull();
    expect(field('wf', 'cronExpression').check('* *')).toMatch(/^CronExpression must be a valid 5- or 6-field cron expression/);
    expect(field('step', 'entryCondition').check('0')).toMatch(/^EntryCondition must not be PreviousProcessing/);
    expect(field('step', 'entryCondition').check('9')).toBe('Entry condition is not one of its values');
    expect(field('step', 'entryCondition').check('5')).toBeNull();
    expect(field('proc', 'sourceHash').check('ABC')).toBe('SourceHash must be a lowercase SHA-256 hex string (64 chars, [a-f0-9]).');
    expect(field('proc', 'sourceHash').check('a'.repeat(64))).toBeNull();
    expect(field('proc', 'instanceId').check('')).toBeNull();
    expect(field('asg', 'payload').check('{')).toMatch(/^Not valid JSON/);
    expect(field('cache', 'root').check('a:b')).toBe("Root must not contain ':'.");
    expect(field('cache', 'root').check(' ')).toBe('Root is required');
    expect(field('cache', 'items').check('[]')).toBe('Items must be a JSON object.');
    expect(field('cache', 'items').check('{"a":1}')).toBe("Items value for key 'a' must be a string.");
    expect(field('cache', 'items').check('{"a:b":"x"}')).toBe("Items key 'a:b' must not contain ':'.");
    expect(field('cache', 'items').check('{"a":"x"}')).toBeNull();
  });

  it('shows a stored value as text: null as empty, JSON pretty-printed', () => {
    expect(savedText({ description: null }, field('wf', 'description'))).toBe('');
    expect(savedText({ entryCondition: 4 }, field('step', 'entryCondition'))).toBe('4');
    expect(savedText({ payload: '{"a":1}' }, field('asg', 'payload'))).toBe('{\n  "a": 1\n}');
  });
});

describe('the read-only section', () => {
  const data = project as ProjectData;
  const m = buildMolecule(data);
  const s = data.steps.find((x) => (x.nextStepIds ?? []).length > 0)!;
  const key = atomKey('step', s.id);

  it('lists the details: table, id, audit, and what points at the row', () => {
    const rows = detailRows(m, { ...rowOf(data, 'step', s.id)!, createdAt: '2026-08-15T21:37:03.989467Z', createdBy: null }, key);
    expect(rows.map((r) => r.label)).toEqual(['Table', 'Id', 'Created', 'Updated', 'Pointed at by']);
    expect(rows[0]!.value).toBe('steps');
    expect(rows[1]!.value).toBe(s.id);
    expect(rows[2]!.value).toBe('2026-08-15 21:37:03 · —');
    expect(rows[4]!.value).toMatch(/assignments\.step_id/);
  });

  it('lists the arrows that leave the row, by the target\'s name', () => {
    const rows = arrowRows(m, key);
    const proc = data.processors.find((p) => p.id === s.processorId)!;
    expect(rows).toContainEqual({ label: 'processor', target: proc.name, key: `uses|${key}|proc:${proc.id}` });
    expect(rows.filter((r) => r.label === 'next step')).toHaveLength((s.nextStepIds ?? []).length);
  });
});

describe('editStates: finished edits are changes, unfinished ones are not (the user, 2026-10-16)', () => {
  it('counts an atom finished only when every edited field passes its rule', () => {
    const m = buildMolecule(project as ProjectData);
    const wf = [...m.atoms.values()].find((a) => a.type === 'wf')!.key;
    const step = [...m.atoms.values()].find((a) => a.type === 'step')!.key;
    const states = editStates(FIELDS, m, { [wf]: { name: 'renamed', version: '2.0.0' }, [step]: { name: 'ok', version: '1.' }, 'wf:gone': { name: 'x' } });
    expect([...states.finished]).toEqual([wf]);
    expect([...states.unfinished]).toEqual([step]);
  });
});

describe("definitionLock: BaseApi's freeze, judged on the virtual entities (the user, 2026-10-16)", () => {
  const H = 'a'.repeat(64);
  const proc = (id: string, slots: Record<string, string | null>) => ({ id, name: id, version: '1.0.0', description: null, sourceHash: H, instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null, ...slots });
  const data = {
    workflows: [], steps: [], assignments: [], caches: [],
    processors: [proc('p1', { inputSchemaId: 'c1' }), proc('p2', { configSchemaId: 'c1', outputSchemaId: 'c1' })],
    schemas: [{ id: 'c1', name: 'c1', version: '1.0.0', description: null, definition: '{}' }, { id: 'c2', name: 'c2', version: '1.0.0', description: null, definition: '{}' }],
  } as unknown as ProjectData;
  const m = buildMolecule(data);
  const C1 = atomKey('schema', 'c1'), C2 = atomKey('schema', 'c2');
  const into = m.arrows.filter((x) => x.to === C1).map((x) => `${x.kind}|${x.from}|${x.to}`);

  it('freezes a schema any processor slot points at, naming each one', () => {
    const lock = definitionLock(m, NOTHING_REMOVED, C1);
    expect(lock.locked).toBe(true);
    expect(lock.note).toMatch(/^Frozen: used by p1 \(input\), p2 \(output\), p2 \(config\)\. /);
    expect(definitionLock(m, NOTHING_REMOVED, C2).locked).toBe(false);
  });

  it('stays frozen until every arrow is gone, by arrow deletes or a processor delete', () => {
    expect(into).toHaveLength(3);
    expect(definitionLock(m, { atoms: [], arrows: into.slice(0, 2) }, C1).locked).toBe(true);
    expect(definitionLock(m, { atoms: [], arrows: into }, C1)).toMatchObject({ locked: false, note: expect.stringMatching(/^Open: /) });
    const p1Input = into.find((k) => k.startsWith('input|'))!;
    expect(definitionLock(m, { atoms: [atomKey('proc', 'p2')], arrows: [p1Input] }, C1).locked).toBe(false);
  });

  it('makes a definition edit unfinished, and frozen, once an arrow comes back', () => {
    const edits = { [C1]: { definition: '{"type":"object"}' } };
    expect(editStates(FIELDS, m, edits, { atoms: [], arrows: into })).toMatchObject({ finished: new Set([C1]), frozen: new Set() });
    expect(editStates(FIELDS, m, edits, NOTHING_REMOVED)).toMatchObject({ finished: new Set(), unfinished: new Set([C1]), frozen: new Set([C1]) });
    // a name edit is never frozen
    expect(editStates(FIELDS, m, { [C1]: { name: 'renamed' } }, NOTHING_REMOVED).finished.has(C1)).toBe(true);
  });
});
