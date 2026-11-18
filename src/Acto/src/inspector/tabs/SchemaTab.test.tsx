import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { board } from '../../design/boardFixtures';
import { setPayload } from '../../design/payloads';
import { prettyJson } from '../../model/json';
import { openOn, REQUIRED, subTab } from './testBoard';

afterEach(() => sessionStorage.clear());

describe('SchemaTab', () => {
  it('the schemas are sub-tabs of Processor, in a second, named row; the top tabs stay Step, Processor, the workflows', () => {
    openOn('Processor');
    const top = within(screen.getByRole('tablist', { name: 'Inspector tabs' })).getAllByRole('tab').map((t) => t.textContent);
    expect(top).toEqual(['Step', 'Processor', 'daily']);
    const subs = within(screen.getByRole('tablist', { name: 'Processor tabs' })).getAllByRole('tab');
    expect(subs.map((t) => t.textContent)).toEqual(['Processor', 'Input schema', 'Config schema']);
    expect(subs[0]).toHaveAttribute('aria-selected', 'true');
    expect(subs[0]!.className).toContain('ins-subtab');
  });
  it('the config schema\'s entity form: head, kind line, fields and its Definition as pretty JSON', () => {
    openOn('Config schema');
    expect(screen.getByLabelText('Unique name')).toHaveTextContent('cfg 1.0.0');
    expect(screen.getByText('schema · config of proc')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('cfg');
    expect(screen.getByLabelText('Version')).toHaveValue('1.0.0');
    expect(screen.getByLabelText('Definition')).toHaveValue(prettyJson(REQUIRED));
    expect(prettyJson(REQUIRED)).toContain('\n  "type": "object",\n');
  });
  it('a schema whose definition is not read is shown, not edited', () => {
    openOn('Input schema');
    expect(screen.getByText('schema · input of proc')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByText('Definition', { selector: 'dt' }).nextSibling).toHaveTextContent('not loaded');
  });
  it('the definition retyped as the same JSON is no edit', () => {
    const store = openOn('Config schema');
    fireEvent.change(screen.getByLabelText('Definition'), { target: { value: '{ "type" : "object", "required": ["k"] }' } });
    expect(store.state().processors.p1!.configSchemaId).toBe('s-cfg');
    expect(store.unsaved().size).toBe(0);
  });
  it('a definition edit makes one copy, edits it in place after', () => {
    const store = openOn('Config schema');
    fireEvent.change(screen.getByLabelText('Definition'), { target: { value: '{"type":"object"}' } });
    const copyId = store.state().processors.p1!.configSchemaId!;
    expect(copyId).not.toBe('s-cfg');
    expect(store.state().schemas[copyId]).toMatchObject({ definition: '{"type":"object"}', updatedAt: null });
    expect(store.state().schemas['s-cfg']!.definition).toBe(REQUIRED);
    fireEvent.change(screen.getByLabelText('Definition'), { target: { value: '{"type":"object","x":1}' } });
    expect(store.state().processors.p1!.configSchemaId).toBe(copyId);
    expect(Object.keys(store.state().schemas)).toHaveLength(3);
    expect(subTab('Config schema')).toHaveAttribute('aria-selected', 'true');
  });
  it('the schema name edits the copy too', () => {
    const store = openOn('Config schema');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'renamed' } });
    expect(store.state().schemas[store.state().processors.p1!.configSchemaId!]!.name).toBe('renamed');
    expect(store.state().schemas['s-cfg']!.name).toBe('cfg');
    expect(screen.getByLabelText('Unique name')).toHaveTextContent('renamed 1.0.0');
  });
  it('the payload is checked against the config schema, in the workflow tab', () => {
    const store = openOn('daily');
    expect(document.querySelector('.in-problem')).not.toBeNull(); // '{}' lacks the required key
    act(() => store.edit((b) => setPayload(b, 'daily', 'fetch', '{"k":1}', () => 'n')));
    expect(document.querySelector('.in-problem')).toBeNull();
    expect(screen.getByText('✓ checked against cfg 1.0.0; Save checks it again')).toBeInTheDocument();
  });
  it('a processor with no schemas: the Processor sub-tab alone', () => {
    openOn('Processor', [{ kind: 'step', id: 'fetch' }], board());
    expect(within(screen.getByRole('tablist', { name: 'Processor tabs' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Processor']);
  });
  it('a step without a processor: no sub-tabs, "none"', () => {
    const b0 = board();
    openOn('Processor', [{ kind: 'step', id: 'fetch' }], { ...b0, steps: { ...b0.steps, fetch: { ...b0.steps.fetch!, processorId: null } } });
    expect(screen.queryByRole('tablist', { name: 'Processor tabs' })).toBeNull();
    expect(screen.getByText('Processor', { selector: 'dt' }).nextSibling).toHaveTextContent('none');
  });
});
