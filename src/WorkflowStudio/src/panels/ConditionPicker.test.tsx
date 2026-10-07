import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CONDITIONS } from '../model/entryConditions';
import { ConditionPicker } from './ConditionPicker';

function Harness({ initial = '1', onChange = () => {} }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="ec">Entry condition</label>
      <ConditionPicker id="ec" value={value} onChange={(v) => { setValue(v); onChange(v); }} />
      <button type="button">elsewhere</button>
    </>
  );
}
const box = () => screen.getByLabelText('Entry condition');

describe('ConditionPicker', () => {
  it('shows the current condition as the legend draws it: pill, wire in its colour, name', () => {
    render(<Harness initial="2" />);
    expect(box()).toHaveAttribute('data-value', '2');
    expect(box()).toHaveAttribute('aria-expanded', 'false');
    expect(box().querySelector('.pill')!.textContent).toBe('F');
    expect(box().querySelector('.lg-w')!.getAttribute('stroke')).toBe('#FF7A66');
    expect(box()).toHaveTextContent('Failed');
  });

  it('opens a list of all five, each with its pill and wire, the current one selected', () => {
    render(<Harness initial="3" />);
    fireEvent.click(box());
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(CONDITIONS.length);
    CONDITIONS.forEach((c, i) => {
      expect(options[i]!.querySelector('.pill')!.textContent).toBe(c.letter);
      expect(options[i]!.querySelector('.lg-w')!.getAttribute('stroke')).toBe(c.colour);
      expect(options[i]).toHaveTextContent(c.name);
      expect(options[i]).toHaveAttribute('aria-selected', String(c.value === 3));
    });
  });

  it('picks with a click and closes', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box());
    fireEvent.click(screen.getByRole('option', { name: /Always/ }));
    expect(onChange).toHaveBeenCalledWith('4');
    expect(box()).toHaveAttribute('data-value', '4');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picking the current condition again is not an edit', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box());
    fireEvent.click(screen.getByRole('option', { name: /Completed/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keyboard: Down opens on the current one, Down/End/Home move, Enter picks', () => {
    render(<Harness initial="2" />);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    const active = () => document.getElementById(box().getAttribute('aria-activedescendant')!)!;
    expect(active()).toHaveTextContent('Failed');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(active()).toHaveTextContent('Cancelled');
    fireEvent.keyDown(box(), { key: 'End' });
    expect(active()).toHaveTextContent('Never');
    fireEvent.keyDown(box(), { key: 'Home' });
    expect(active()).toHaveTextContent('Completed');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box()).toHaveAttribute('data-value', '1');
    expect(box()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a letter picks its condition when closed, and moves to it when open', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'x' });
    expect(box()).toHaveAttribute('data-value', '3');
    fireEvent.keyDown(box(), { key: ' ' });
    fireEvent.keyDown(box(), { key: 'n' });
    expect(box()).toHaveAttribute('data-value', '3');
    fireEvent.keyDown(box(), { key: ' ' });
    expect(box()).toHaveAttribute('data-value', '5');
  });

  it('Escape closes without picking and does not reach the dock', () => {
    const dock = vi.fn((e: KeyboardEvent) => e.key);
    window.addEventListener('keydown', dock);
    render(<Harness />);
    fireEvent.click(box());
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box()).toHaveAttribute('data-value', '1');
    expect(dock.mock.results.map((r) => r.value)).not.toContain('Escape');
    window.removeEventListener('keydown', dock);
  });

  it('a press outside closes it', () => {
    render(<Harness />);
    fireEvent.click(box());
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a stored value outside the five shows as Invalid in grey and is not offered', () => {
    render(<Harness initial="0" />);
    expect(box()).toHaveTextContent('Invalid (0)');
    expect(box().querySelector('.pill')!.textContent).toBe('?');
    fireEvent.click(box());
    expect(screen.getAllByRole('option')).toHaveLength(CONDITIONS.length);
    expect(screen.getAllByRole('option').every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true);
  });
});
