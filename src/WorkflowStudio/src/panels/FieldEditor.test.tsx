import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FieldEditor } from './FieldEditor';

const spec = (kind: 'multiline' | 'json') => ({ key: 'description', label: 'Description', kind, nullable: true });

describe('FieldEditor sizing', () => {
  it('sizes a multi-line field to its content, capped at 40% of the window', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300);
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    const { container } = render(<FieldEditor spec={spec('multiline')} value={'a\nb\nc'} saved="" errors={[]} onChange={() => {}} />);
    expect(container.querySelector('textarea')!.style.height).toBe('200px'); // 300 of content, cap 0.4 * 500
    scroll.mockReturnValue(120);
    const again = render(<FieldEditor spec={spec('multiline')} value="x" saved="" errors={[]} onChange={() => {}} />);
    expect(parseFloat(again.container.querySelector('textarea')!.style.height)).toBeGreaterThanOrEqual(120);
    scroll.mockRestore();
  });

  it('leaves a JSON editor at its rows', () => {
    const { container } = render(<FieldEditor spec={spec('json')} value="{}" saved="" errors={[]} onChange={() => {}} />);
    expect(container.querySelector('textarea')!.style.height).toBe('');
  });
});
