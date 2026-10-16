import { describe, expect, it } from 'vitest';
import { SNAPSHOT, type ModelFields } from '../api/fields';
import { fieldTable, labelOf, SNAPSHOT_RULES } from './rules';

/** The snapshot with one field's rules replaced: what a BaseApi with other validators would describe. */
function withRules(table: string, field: string, rules: ModelFields['entities'][number]['fields'][number]['rules']): ModelFields {
  return {
    ...SNAPSHOT,
    entities: SNAPSHOT.entities.map((e) => e.table !== table ? e : { ...e, fields: e.fields.map((f) => (f.field === field ? { ...f, rules } : f)) }),
  };
}

describe('fieldTable: the field list and its checks come from the description, not from Valence', () => {
  const T = SNAPSHOT_RULES.table;

  it('lists each kind\'s non-arrow update fields in the DTO\'s order, labelled from their names', () => {
    expect(T.proc.map((f) => f.label)).toEqual(['Name', 'Version', 'Description', 'Source hash', 'Instance id']);
    expect(T.step.map((f) => f.key)).not.toContain('processorId');
    expect(T.wf.map((f) => f.key)).not.toContain('entryStepIds');
    expect(labelOf('cronExpression')).toBe('Cron expression');
  });

  it('picks the editor from the store type and the rules', () => {
    const kind = (type: keyof typeof T, key: string) => T[type].find((f) => f.key === key)!.kind;
    expect([kind('schema', 'definition'), kind('asg', 'payload'), kind('cache', 'items')]).toEqual(['json', 'json', 'json']);
    expect(kind('wf', 'description')).toBe('multiline');
    expect(kind('proc', 'sourceHash')).toBe('text');
    expect(kind('step', 'entryCondition')).toBe('choice');
  });

  it("offers an enum's values without the ones its rules refuse", () => {
    expect(T.step.find((f) => f.key === 'entryCondition')!.options).toEqual([
      { value: '1', label: 'PreviousCompleted' }, { value: '2', label: 'PreviousFailed' }, { value: '3', label: 'PreviousCancelled' },
      { value: '4', label: 'Always' }, { value: '5', label: 'Never' },
    ]);
  });

  it('follows a changed rule with no change in Valence', () => {
    const name = (fields: ModelFields) => fieldTable(fields).wf.find((f) => f.key === 'name')!;
    expect(name(SNAPSHOT).check('x'.repeat(50))).toBeNull();
    const tighter = withRules('workflows', 'name', [{ kind: 'required', value: null, message: null, conditional: false }, { kind: 'maxLength', value: '10', message: 'Keep it short.', conditional: false }]);
    expect(name(tighter).check('x'.repeat(50))).toBe('Keep it short.');
    expect(name(withRules('workflows', 'name', [])).check('')).toBeNull(); // no rule, no check
  });

  it("runs a code rule's stand-in only where BaseApi says a code rule exists", () => {
    const def = (fields: ModelFields) => fieldTable(fields).schema.find((f) => f.key === 'definition')!;
    expect(def(SNAPSHOT).check('{')).toMatch(/^Not valid JSON/);
    expect(def(withRules('schemas', 'definition', [{ kind: 'required', value: null, message: null, conditional: false }])).check('{')).toBeNull();
  });

  it('skips a pattern JavaScript cannot read, leaving it to BaseApi', () => {
    const odd = withRules('processors', 'sourceHash', [{ kind: 'pattern', value: '(?<x', message: null, conditional: false }]);
    expect(fieldTable(odd).proc.find((f) => f.key === 'sourceHash')!.check('anything')).toBeNull();
  });

  it('keeps the definition lock, a service rule BaseApi cannot describe', () => {
    expect(Object.values(T).flat().filter((f) => f.lock).map((f) => f.key)).toEqual(['definition']);
  });
});
