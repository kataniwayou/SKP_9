import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DiscardButton, SaveButton, saveLabel, TakeStoredButton } from './SaveButton';

describe('SaveButton', () => {
  it('reads Save, Save · N or Saving…', () => {
    expect(saveLabel(0, false)).toBe('Save');
    expect(saveLabel(3, false)).toBe('Save · 3');
    expect(saveLabel(3, true)).toBe('Saving…');
  });
  it('is disabled with nothing changed or while saving, and saves when pressed', () => {
    const onSave = vi.fn();
    const { rerender } = render(<SaveButton unsaved={0} saving={false} onSave={onSave} />);
    expect(screen.getByRole('button')).toBeDisabled();
    rerender(<SaveButton unsaved={2} saving={false} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save · 2' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    rerender(<SaveButton unsaved={2} saving onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });
  it('is disabled while Save is blocked (outcome unknown)', () => {
    render(<SaveButton unsaved={2} saving={false} blocked onSave={vi.fn()} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('TakeStoredButton', () => {
  it('is hidden with no stale rows, and takes them when pressed', () => {
    const onTake = vi.fn();
    const { rerender, container } = render(<TakeStoredButton count={0} saving={false} onTake={onTake} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TakeStoredButton count={2} saving={false} onTake={onTake} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take stored · 2' }));
    expect(onTake).toHaveBeenCalledTimes(1);
    rerender(<TakeStoredButton count={2} saving onTake={onTake} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('DiscardButton [user, 2026-11-25]', () => {
  it('is disabled with nothing unsaved or while saving, and discards on a click otherwise', () => {
    const onDiscard = vi.fn();
    const { rerender } = render(<DiscardButton unsaved={0} saving={false} onDiscard={onDiscard} />);
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    rerender(<DiscardButton unsaved={3} saving={false} onDiscard={onDiscard} />);
    const b = screen.getByRole('button', { name: 'Discard' });
    expect(b).toBeEnabled();
    expect(b).toHaveAttribute('title', 'Discard all 3 unsaved changes (Ctrl+Z brings them back)');
    fireEvent.click(b);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    rerender(<DiscardButton unsaved={3} saving onDiscard={onDiscard} />);
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });
});
