import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SaveButton, saveLabel } from './SaveButton';

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
