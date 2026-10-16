import { describe, expect, it } from 'vitest';
import type { ProjectData } from '../api/project';
import project from '../test/fixtures/project.json';
import { arrowRows, detailRows, FIELDS, rowOf, savedText } from './fields';
import { atomKey, buildMolecule } from './model';

const field = (type: keyof typeof FIELDS, key: string) => FIELDS[type].find((f) => f.key === key)!;

describe('FIELDS (the user\'s list, 2026-10-15)', () => {
  it('holds every writable field that is not an arrow, and no arrow field', () => {
    const keys = Object.fromEntries(Object.entries(FIELDS).map(([t, fs]) => [t, fs.map((f) => f.key)]));
    const common = ['name', 'version', 'description'];
    expect(keys).toEqual({
      wf: [...common, 'cronExpression'], step: [...common, 'entryCondition'], proc: [...common, 'sourceHash', 'instanceId'],
      schema: [...common, 'definition'], asg: [...common, 'payload'], cache: [...common, 'root', 'items'],
    });
  });

  it('keeps the schema definition read-only for now', () => {
    expect(field('schema', 'definition').readOnly).toBe('Read-only for now');
    expect(FIELDS.proc.every((f) => !f.readOnly)).toBe(true);
  });

  it("checks BaseApi's rules", () => {
    expect(field('wf', 'name').check('')).toBe('Name is required');
    expect(field('wf', 'name').check('x'.repeat(201))).toBe('Name is at most 200 characters');
    expect(field('wf', 'version').check('1.0')).toBe('Version is x.y.z, e.g. 1.0.0');
    expect(field('wf', 'version').check('01.0.0')).toBe('Version is x.y.z, e.g. 1.0.0');
    expect(field('wf', 'version').check('2.10.0')).toBeNull();
    expect(field('wf', 'cronExpression').check('')).toBeNull();
    expect(field('wf', 'cronExpression').check('0 * * * *')).toBeNull();
    expect(field('wf', 'cronExpression').check('* *')).toBe('A cron has 5 or 6 fields');
    expect(field('step', 'entryCondition').check('0')).toBe('Pick an entry condition');
    expect(field('step', 'entryCondition').check('5')).toBeNull();
    expect(field('proc', 'sourceHash').check('ABC')).toBe('A source hash is 64 lowercase hex characters');
    expect(field('proc', 'sourceHash').check('a'.repeat(64))).toBeNull();
    expect(field('asg', 'payload').check('{')).toMatch(/^Not valid JSON/);
    expect(field('cache', 'root').check('a:b')).toBe('Root cannot contain ":"');
    expect(field('cache', 'items').check('[]')).toBe('Items are a JSON object');
    expect(field('cache', 'items').check('{"a":1}')).toBe('Key "a": values are strings');
    expect(field('cache', 'items').check('{"a:b":"x"}')).toBe('Key "a:b": keys are non-empty and without ":"');
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
    expect(rows).toContainEqual({ label: 'processor', target: proc.name });
    expect(rows.filter((r) => r.label === 'next step')).toHaveLength((s.nextStepIds ?? []).length);
  });
});
