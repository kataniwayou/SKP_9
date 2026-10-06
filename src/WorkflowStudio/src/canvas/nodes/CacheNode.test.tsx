import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CacheView, type CacheNodeData } from './CacheNode';
import { CACHE_FRAME } from './nxShapes';

const data: CacheNodeData = {
  lines: ['chain-artist-', 'whitelist'],
  versionLine: { text: 'CACHE · v1.0.0', full: 'CACHE · v1.0.0', cut: false },
  root: { text: 'chain-artists', full: 'chain-artists', cut: false },
  plateWidth: 100,
  tooltip: 'chain-artist-whitelist 1.0.0\nroot chain-artists',
};

describe('CacheView', () => {
  it('draws the square frame, the hex mark, the name on two lines, CACHE and version, and the root on its plate', () => {
    const { container, getByText } = render(<svg><CacheView {...data} /></svg>);
    expect(container.querySelector('path.nx-brk')!.getAttribute('d')).toBe(CACHE_FRAME);
    expect(container.querySelectorAll('polygon')).toHaveLength(2);
    expect(getByText('chain-artist-').getAttribute('y')).toBe('88');
    expect(getByText('whitelist').getAttribute('y')).toBe('102');
    expect(getByText('CACHE · v1.0.0')).toBeInTheDocument();
    expect(getByText('chain-artists')).toBeInTheDocument();
    const plate = container.querySelector('rect.nx-plate')!;
    expect([plate.getAttribute('x'), plate.getAttribute('width')]).toEqual(['30', '100']);
    expect(container.querySelector('.cachetag > title')!.textContent).toBe('chain-artist-whitelist 1.0.0\nroot chain-artists');
  });

  it('puts a one-line name on the middle line', () => {
    const { getByText } = render(<svg><CacheView {...data} lines={['lookups']} /></svg>);
    expect(getByText('lookups').getAttribute('y')).toBe('95');
  });
});
