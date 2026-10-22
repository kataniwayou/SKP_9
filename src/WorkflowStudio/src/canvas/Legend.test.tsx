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

  it('shows the short circuit and no undecided wire (the user, 2026-10-22); no loose wire, nothing broken or parked (plan 9 §5)', () => {
    const { getByText, queryByText, container } = render(<Legend />);
    expect(queryByText('undecided')).toBeNull();
    expect(container.querySelector('.lg-undecided')).toBeNull();
    const short = getByText('short circuit').closest('.lg-item')!;
    expect(short.querySelector('.lg-short')).not.toBeNull();
    // its tooltip names all three kinds: two families at a junction, a loop, an overlap with another net
    expect(short.getAttribute('title')).toMatch(/two families[\s\S]*loop[\s\S]*another net/);
    expect(container.querySelector('.lg-open')).toBeNull();
    expect(queryByText(/loose/)).toBeNull();
    expect(queryByText('broken')).toBeNull();
    expect(queryByText('parked')).toBeNull();
  });
});
