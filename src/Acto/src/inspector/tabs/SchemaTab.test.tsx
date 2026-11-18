import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { board } from '../../design/boardFixtures';
import { setPayload } from '../../design/payloads';
import { prettyJson } from '../../model/json';
import { openOn, REQUIRED } from './testBoard';

afterEach(() => sessionStorage.clear());

describe('SchemaTab', () => {
  it('the step shows a tab per slot holding a schema, after Processor; none without schemas', () => {
    openOn('Step');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Step', 'Processor', 'Input schema', 'Config schema', 'daily']);
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
    expect(screen.getByRole('tab', { name: 'Config schema' })).toHaveAttribute('aria-selected', 'true');
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
  it('a processor with no schemas gives no schema tabs', () => {
    openOn('Step', [{ kind: 'step', id: 'fetch' }], board());
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Step', 'Processor', 'daily']);
  });
});
