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
    expect(container.querySelectorAll('.lg-item')).toHaveLength(CONDITIONS.length + 2);
  });

  it('shows the undecided wire (grey, dashed, a ring and an arrow head) and the short circuit; no loose wire, nothing broken or parked (plan 9 §5)', () => {
    const { getByText, queryByText, container } = render(<Legend />);
    const undecided = getByText('undecided').closest('.lg-item')!;
    expect(undecided.querySelector('.lg-undecided')).not.toBeNull();
    expect(undecided.querySelector('.lg-ring')).not.toBeNull();
    expect(undecided.querySelector('.lg-arrow')).not.toBeNull();
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
