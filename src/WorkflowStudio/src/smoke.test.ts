import { describe, expect, it } from 'vitest';

describe('test runner', () => {
  it('runs in jsdom with the React Flow shims', () => {
    expect(typeof window).toBe('object');
    expect(typeof ResizeObserver).toBe('function');
  });
});
