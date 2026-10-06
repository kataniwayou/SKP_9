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

  it('shows broken as grey dashes around the amber warning, and parked as a dashed notched frame', () => {
    const { getByText } = render(<Legend />);
    const broken = getByText('broken').closest('.lg-item')!;
    expect(broken.querySelector('.lg-dash')).not.toBeNull();
    expect(broken.querySelector('.lg-warn')!.textContent).toBe('⚠');
    expect(getByText('parked').closest('.lg-item')!.querySelector('.lg-parked')).not.toBeNull();
  });
});
