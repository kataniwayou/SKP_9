import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { openOn } from './testBoard';

afterEach(() => sessionStorage.clear());
const rowValue = (term: string) => screen.getByText(term, { selector: 'dt' }).nextSibling;

describe('ProcessorTab', () => {
  it('the processor\'s fields, then Liveness, the slots read-only and Used by; no schema editors, no In/Out/Config buttons', () => {
    openOn('Processor');
    expect(screen.getByLabelText('Name')).toHaveValue('proc');
    expect(screen.getByLabelText('Source hash')).toHaveValue('a'.repeat(64));
    expect(screen.getByLabelText('Instance id')).toHaveValue('');
    expect(rowValue('Input schema')).toHaveTextContent('in 1.0.0');
    expect(rowValue('Output schema')).toHaveTextContent('none');
    expect(rowValue('Config schema')).toHaveTextContent('cfg 1.0.0');
    expect(rowValue('Used by')).toHaveTextContent('fetch-orders, expand, lonely');
    expect(screen.queryByLabelText('Definition')).toBeNull();
    expect(screen.queryByLabelText(/schema definition/)).toBeNull();
    for (const name of [/^In$/, /^Out$/, /^Config$/, /^Clear/]) expect(screen.queryByRole('button', { name })).toBeNull();
    // Studio's order: Description, Source hash, Instance id, then the related rows
    const order = ['Description', 'Source hash', 'Instance id'].map((l) => screen.getByLabelText(l));
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[2]!.compareDocumentPosition(screen.getByText('Liveness')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('editing Source hash marks the processor unsaved', () => {
    const store = openOn('Processor');
    fireEvent.change(screen.getByLabelText('Source hash'), { target: { value: 'b'.repeat(64) } });
    expect(store.state().processors.p1!.sourceHash).toBe('b'.repeat(64));
    expect(store.unsaved().size).toBeGreaterThan(0);
    expect([...store.unsaved()].some((k) => k.includes('p1'))).toBe(true);
  });
  it('Instance id: typed text is kept, blank stores null', () => {
    const store = openOn('Processor');
    const input = screen.getByLabelText('Instance id');
    fireEvent.change(input, { target: { value: 'pod-7' } });
    expect(store.state().processors.p1!.instanceId).toBe('pod-7');
    fireEvent.change(input, { target: { value: '' } });
    expect(store.state().processors.p1!.instanceId).toBeNull();
    expect(store.unsaved().size).toBe(0);
  });
  it('typing the processor name is one undo step', () => {
    const store = openOn('Processor');
    const input = screen.getByLabelText('Name');
    fireEvent.change(input, { target: { value: 'p' } });
    fireEvent.change(input, { target: { value: 'pr' } });
    expect(store.state().processors.p1!.name).toBe('pr');
    store.undo();
    expect(store.state().processors.p1!.name).toBe('proc');
    expect(store.canUndo()).toBe(false);
  });
});
