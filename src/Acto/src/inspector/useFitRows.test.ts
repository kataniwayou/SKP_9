import { describe, it, expect } from 'vitest';
import { fitRows } from './useFitRows';

describe('fitRows', () => {
  it('fits whole rows under the header', () => { expect(fitRows(24 + 27 * 16)).toBe(16); });
  it('clamps to 5 minimum', () => { expect(fitRows(10)).toBe(5); });
  it('clamps to 200 maximum', () => { expect(fitRows(100_000)).toBe(200); });
});
