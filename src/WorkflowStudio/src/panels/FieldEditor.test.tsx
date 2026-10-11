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

describe('FieldEditor: the cron in a few words (2026-10-11)', () => {
  const cron = { key: 'cronExpression', label: 'Cron', kind: 'cron' as const, nullable: true };
  const hint = (container: HTMLElement) => container.querySelector('.fhint, .ferr');

  it('says the schedule under the field, as the field\'s description', () => {
    const { container } = render(<FieldEditor spec={cron} value="*/30 * * * * *" saved="" errors={[]} onChange={() => {}} />);
    const input = container.querySelector('input')!;
    expect(hint(container)!.className).toBe('fhint');
    expect(hint(container)!.textContent).toBe('Every 30 seconds');
    expect(input.getAttribute('aria-describedby')).toBe(hint(container)!.id);
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('says a blank field is not scheduled', () => {
    const { container } = render(<FieldEditor spec={cron} value="" saved="" errors={[]} onChange={() => {}} />);
    expect(hint(container)!.textContent).toBe('Not scheduled');
  });

  it('names an expression it cannot read in red and marks the field', () => {
    const { container } = render(<FieldEditor spec={cron} value="0 75 * * * *" saved="" errors={[]} onChange={() => {}} />);
    expect(hint(container)!.className).toBe('ferr');
    expect(hint(container)!.textContent).toBe('Minute 75 is out of range (0–59)');
    expect(container.querySelector('input')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('leaves other text fields without a wording', () => {
    const { container } = render(<FieldEditor spec={{ key: 'root', label: 'Root', kind: 'text' }} value="x" saved="" errors={[]} onChange={() => {}} />);
    expect(hint(container)).toBeNull();
    expect(container.querySelector('input')!.getAttribute('aria-describedby')).toBeNull();
  });
});
