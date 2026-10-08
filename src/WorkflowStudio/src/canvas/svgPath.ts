import type { Pt } from '../layout/router';

export const pathOf = (points: Pt[]): string => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
