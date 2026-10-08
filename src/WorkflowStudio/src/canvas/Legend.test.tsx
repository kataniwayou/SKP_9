import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CONDITIONS } from '../model/entryConditions';
import { Legend } from './Legend';

describe('Legend', () => {
  it('shows each entry condition as its pill and a trace in its colour, ending in a chevron', () => {
    const { container, getByText } = render(<Legend />);
    for (const c of CONDITIONS) {
      expect(getByText(c.name)).toBeInTheDocument();
      const item = getByText(c.name).closest('.lg-item')!;
      expect(item.querySelector('.pill')!.textContent).toBe(c.letter);
      expect(item.querySelector('.lg-w')!.getAttribute('stroke')).toBe(c.colour);
      expect(item.querySelector('.lg-head')).not.toBeNull();
    }
    expect(container.querySelectorAll('.lg-item')).toHaveLength(CONDITIONS.length + 1);
  });

  it('shows a loose wire as a grey dashed line with an open end; no broken, no parked (plan 8)', () => {
    const { getByText, queryByText } = render(<Legend />);
    const loose = getByText('loose wire').closest('.lg-item')!;
    expect(loose.querySelector('.lg-loose')).not.toBeNull();
    expect(loose.querySelector('.lg-open')).not.toBeNull();
    expect(queryByText('broken')).toBeNull();
    expect(queryByText('parked')).toBeNull();
  });
});
