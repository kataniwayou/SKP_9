import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DictEditor } from './DictEditor';

const spec = { key: 'items', label: 'Items', kind: 'dict' as const };

/** The editor over a field that takes what it commits, as the Inspector's design edit does. */
function Field({ initial, onCommit }: { initial: string; onCommit: (t: string) => void }) {
  const [value, setValue] = useState(initial);
  return <DictEditor spec={spec} value={value} errors={[]} onChange={(t) => { onCommit(t); setValue(t); }} />;
}

const key = (n: number) => screen.getByRole('textbox', { name: `Key ${n}` });
const val = (n: number) => screen.getByRole('textbox', { name: `Value ${n}` });
const type = (el: HTMLElement, text: string) => { fireEvent.focus(el); fireEvent.change(el, { target: { value: text } }); fireEvent.blur(el); };

describe('DictEditor (2026-10-10, a cache\'s items as a table)', () => {
  it('shows the entries in stored order with their count', () => {
    render(<Field initial={'{"usd":"3.7","10":"ten"}'} onCommit={vi.fn()} />);
    expect([key(1), val(1), key(2), val(2)].map((e) => (e as HTMLInputElement).value)).toEqual(['usd', '3.7', '10', 'ten']);
    expect(screen.getByText('2 items')).toBeInTheDocument();
  });

  it('edits a value and a key, committed on leaving the cell, as the JSON object in order', () => {
    const onCommit = vi.fn();
    render(<Field initial={'{"a":"1","b":"2"}'} onCommit={onCommit} />);
    type(val(1), 'one');
    expect(onCommit).toHaveBeenLastCalledWith('{"a":"one","b":"2"}');
    type(key(2), 'c');
    expect(onCommit).toHaveBeenLastCalledWith('{"a":"one","c":"2"}');
    // Enter commits too
    fireEvent.focus(val(2));
    fireEvent.change(val(2), { target: { value: 'two' } });
    fireEvent.keyDown(val(2), { key: 'Enter' });
    fireEvent.blur(val(2));
    expect(onCommit).toHaveBeenLastCalledWith('{"a":"one","c":"two"}');
  });

  it('adds a row focused on its key, committed once it has one; × deletes a row', () => {
    const onCommit = vi.fn();
    render(<Field initial={'{"a":"1"}'} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add item' }));
    expect(key(2)).toHaveFocus();
    // an empty new row is not committed
    fireEvent.blur(key(2));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('Key is empty: not committed')).toBeInTheDocument();
    type(key(2), 'b');
    type(val(2), '2');
    expect(onCommit).toHaveBeenLastCalledWith('{"a":"1","b":"2"}');
    fireEvent.click(screen.getByRole('button', { name: 'Delete item 1' }));
    expect(onCommit).toHaveBeenLastCalledWith('{"b":"2"}');
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('a duplicate, colon or empty key marks its row red and is not committed; the other rows still are', () => {
    const onCommit = vi.fn();
    render(<Field initial={'{"a":"1","b":"2"}'} onCommit={onCommit} />);
    type(key(2), 'a');
    expect(screen.getByText('Duplicate key: not committed')).toBeInTheDocument();
    expect(key(2)).toHaveAttribute('aria-invalid', 'true');
    expect(onCommit).not.toHaveBeenCalled();
    // another row's edit commits, the red row as it was last committed
    type(val(1), 'x');
    expect(onCommit).toHaveBeenLastCalledWith('{"a":"x","b":"2"}');
    type(key(2), 'b:c');
    expect(screen.getByText("Key must not contain ':': not committed")).toBeInTheDocument();
    type(key(2), '');
    expect(screen.getByText('Key is empty: not committed')).toBeInTheDocument();
    type(key(2), 'c');
    expect(onCommit).toHaveBeenLastCalledWith('{"a":"x","c":"2"}');
    expect(screen.queryByText(/not committed/)).toBeNull();
  });

  it('Escape puts the cell back as it was', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Field initial={'{"a":"1"}'} onCommit={onCommit} />);
    fireEvent.focus(val(1));
    fireEvent.change(val(1), { target: { value: 'oops' } });
    fireEvent.keyDown(val(1), { key: 'Escape' });
    expect(val(1)).toHaveValue('1');
    vi.runAllTimers();
    vi.useRealTimers();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('stored text that is no string dictionary is shown as text with the reason, the table toggle off', () => {
    render(<DictEditor spec={spec} value={'{"n":1}'} errors={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Items as JSON' })).toHaveValue('{"n":1}');
    expect(screen.getByText("Stored items are not a string dictionary: The value of 'n' must be a string")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled();
  });

  it('the JSON toggle shows the same dictionary as text; a valid edit commits on leaving it and the table follows; an invalid one is not committed', () => {
    const onCommit = vi.fn();
    render(<Field initial={'{"a":"1","b":"2"}'} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    const box = screen.getByRole('textbox', { name: 'Items as JSON' });
    expect(box).toHaveValue('{\n  "a": "1",\n  "b": "2"\n}');
    fireEvent.change(box, { target: { value: '{"a":' } });
    expect(screen.getByText('Not committed: Not valid JSON')).toBeInTheDocument();
    fireEvent.blur(box);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '{"z":"26","a":"1"}' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenLastCalledWith('{"z":"26","a":"1"}');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    expect([key(1), val(1), key(2)].map((e) => (e as HTMLInputElement).value)).toEqual(['z', '26', 'a']);
  });

  it('follows the field when it changes from outside (an undo, another cache)', () => {
    const { rerender } = render(<DictEditor spec={spec} value={'{"a":"1"}'} errors={[]} onChange={vi.fn()} />);
    rerender(<DictEditor spec={spec} value={'{"q":"9"}'} errors={[]} onChange={vi.fn()} />);
    expect((key(1) as HTMLInputElement).value).toBe('q');
  });

  it('read-only: no add or delete, cells not editable', () => {
    render(<DictEditor spec={spec} value={'{"a":"1"}'} errors={[]} onChange={vi.fn()} readOnly />);
    expect(screen.queryByRole('button', { name: '+ Add item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete item 1' })).toBeNull();
    expect(key(1)).toHaveAttribute('readonly');
  });
});
