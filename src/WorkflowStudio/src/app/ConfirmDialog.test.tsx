import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

const added: HTMLElement[] = [];
const outside = () => {
  const input = document.createElement('input');
  document.body.appendChild(input);
  added.push(input);
  return input;
};

describe('ConfirmDialog (final review 4)', () => {
  const windowKeys = vi.fn();
  const listen = (e: KeyboardEvent) => { if (!e.defaultPrevented) windowKeys(e.key); };
  afterEach(() => { window.removeEventListener('keydown', listen); windowKeys.mockReset(); for (const e of added.splice(0)) e.remove(); });

  const show = () => {
    const onCancel = vi.fn();
    const discard = vi.fn();
    render(<ConfirmDialog doc={document} title="Unsaved changes" message="m" onCancel={onCancel}
      buttons={[{ label: 'Discard', onClick: discard }, { label: 'Save', primary: true, onClick: vi.fn() }]} />);
    window.addEventListener('keydown', listen);
    return { onCancel };
  };

  it('Escape with focus outside the dialog cancels it, and the page never sees the key', () => {
    const { onCancel } = show();
    const input = outside();
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(windowKeys).not.toHaveBeenCalled();
  });

  it('keeps every other key outside the dialog from the page, and lets keys inside it work', () => {
    show();
    fireEvent.keyDown(outside(), { key: 'w', altKey: true });
    fireEvent.keyDown(document.body, { key: 'o', ctrlKey: true });
    expect(windowKeys).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Save' }), { key: 'Enter' });
    expect(windowKeys).toHaveBeenCalledWith('Enter');
  });

  it('Tab and Shift+Tab cycle within its buttons', () => {
    show();
    const save = screen.getByRole('button', { name: 'Save' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const discard = screen.getByRole('button', { name: 'Discard' });
    expect(save).toHaveFocus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(save).toHaveFocus();
    fireEvent.keyDown(save, { key: 'Tab', shiftKey: true });
    expect(discard).toHaveFocus();
    const input = outside();
    input.focus();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(cancel).toHaveFocus();
  });

  it('a destructive question (safe): Cancel is the default, focused and primary; Continue is never primary', () => {
    const onCancel = vi.fn();
    const go = vi.fn();
    render(<ConfirmDialog doc={document} title="Delete workflow" message="m" onCancel={onCancel} safe
      buttons={[{ label: 'Continue', primary: true, onClick: go }]} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    expect(cancel).toHaveClass('primary');
    expect(screen.getByRole('button', { name: 'Continue' })).not.toHaveClass('primary');
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
  });
});
