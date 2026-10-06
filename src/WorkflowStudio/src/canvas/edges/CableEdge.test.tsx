import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CableEdgeView } from './CableEdge';

describe('CableEdgeView', () => {
  it('draws the lit cable layers and an arrow head ending on the last point', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} /></svg>);

    expect(container.querySelector('.wshadow')!.getAttribute('d')).toBe('M0 8 L64 8');
    expect(container.querySelector('path.w')!.getAttribute('stroke')).toBe('#2DD4BF');
    expect(container.querySelector('.wcore')).not.toBeNull();
    expect(container.querySelector('polygon.ahead')!.getAttribute('points')).toBe('64,8 54,3 54,13');
    expect(container.querySelector('.wire')!.classList.contains('broken')).toBe(false);
  });

  it('marks a broken wire with the dashed class and a "!" at the middle of its longest segment', () => {
    const { container, getByText } = render(
      <svg><CableEdgeView points={[[0, 0], [16, 0], [16, 96], [32, 96]]} colour="#FF7A66" broken /></svg>,
    );

    expect(container.querySelector('.wire')!.classList.contains('broken')).toBe(true);
    const marker = container.querySelector('circle.brk')!;
    expect([marker.getAttribute('cx'), marker.getAttribute('cy')]).toEqual(['16', '48']);
    expect(getByText('!')).toBeInTheDocument();
  });
});
