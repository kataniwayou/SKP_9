import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { board } from '../../design/boardFixtures';
import { setPayload } from '../../design/payloads';
import { prettyJson } from '../../model/json';
import { childNames, childTab, openOn, REQUIRED, topTab } from './testBoard';

afterEach(() => sessionStorage.clear());

describe('SchemaTab', () => {
  it('the schemas are children of Processor, in a second, named row, none chosen at first; the top row is Step, Processor', () => {
    openOn('Processor');
    const top = within(screen.getByRole('tablist', { name: 'Inspector tabs' })).getAllByRole('tab').map((t) => t.textContent);
    expect(top).toEqual(['Step', 'Processor']);
    expect(childNames('Processor')).toEqual(['Input schema', 'Config schema']);
    const subs = within(screen.getByRole('tablist', { name: 'Processor tabs' })).getAllByRole('tab');
    expect(subs.every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
    expect(subs[0]!.className).toContain('ins-subtab');
    // the processor's own fields show until a child is chosen
    expect(screen.getByLabelText('Source hash')).toBeInTheDocument();
    fireEvent.click(childTab('Processor', 'Input schema'));
    expect(screen.getByText('schema · input of proc')).toBeInTheDocument();
    // the parent tab again: its own fields
    fireEvent.click(topTab('Processor'));
    expect(screen.getByLabelText('Source hash')).toBeInTheDocument();
    expect(subs.every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
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
  it('the Definition is read-only [user, 2026-11-19]: disabled, typing changes nothing, the note says why', () => {
    const store = openOn('Config schema');
    expect(screen.getByLabelText('Definition')).toBeDisabled();
    expect(screen.getByLabelText('Definition')).toHaveValue(JSON.stringify(JSON.parse(REQUIRED), null, 2));
    fireEvent.change(screen.getByLabelText('Definition'), { target: { value: '{"type":"object"}' } });
    expect(store.state().processors.p1!.configSchemaId).toBe('s-cfg');
    expect(store.state().schemas['s-cfg']!.definition).toBe(REQUIRED);
    expect(store.unsaved().size).toBe(0);
    expect(screen.getByText('The definition is read-only: a change needs the processor restarted.')).toBeInTheDocument();
  });
  it('Name, Version and Description stay editable: an edit makes the processor its own copy, the definition kept', () => {
    const store = openOn('Config schema');
    for (const label of ['Name', 'Version', 'Description']) expect(screen.getByLabelText(label)).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'renamed' } });
    const copyId = store.state().processors.p1!.configSchemaId!;
    expect(copyId).not.toBe('s-cfg');
    expect(store.state().schemas[copyId]).toMatchObject({ name: 'renamed', definition: REQUIRED, updatedAt: null });
    expect(store.state().schemas['s-cfg']!.name).toBe('cfg');
    expect(screen.getByLabelText('Unique name')).toHaveTextContent('renamed 1.0.0');
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2.0.0' } });
    expect(store.state().processors.p1!.configSchemaId).toBe(copyId);
    expect(store.state().schemas[copyId]!.version).toBe('2.0.0');
  });
  it('the payload is checked against the config schema, in the workflow child tab of Step', () => {
    const store = openOn('daily');
    expect(document.querySelector('.in-problem')).not.toBeNull(); // '{}' lacks the required key
    act(() => store.edit((b) => setPayload(b, 'daily', 'fetch', '{"k":1}', () => 'n')));
    expect(document.querySelector('.in-problem')).toBeNull();
    expect(screen.getByText('✓ checked against cfg 1.0.0; Save checks it again')).toBeInTheDocument();
  });
  it('a processor with no schemas: no child row is drawn', () => {
    openOn('Processor', [{ kind: 'step', id: 'fetch' }], board());
    expect(screen.queryByRole('tablist', { name: 'Processor tabs' })).toBeNull();
    expect(screen.getByLabelText('Source hash')).toBeInTheDocument();
  });
  it('a step without a processor: no sub-tabs, "none"', () => {
    const b0 = board();
    openOn('Processor', [{ kind: 'step', id: 'fetch' }], { ...b0, steps: { ...b0.steps, fetch: { ...b0.steps.fetch!, processorId: null } } });
    expect(screen.queryByRole('tablist', { name: 'Processor tabs' })).toBeNull();
    expect(screen.getByText('Processor', { selector: 'dt' }).nextSibling).toHaveTextContent('none');
  });
});
