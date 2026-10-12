import { describe, expect, it } from 'vitest';
import { activityOf } from './useAiDrawing';

describe('the Cancel button says what is arriving (the user, 2026-10-12)', () => {
  it('waiting, then thinking, then writing, in thousands of characters; a later round names itself', () => {
    expect(activityOf('drawing', null)).toBe('waiting');
    expect(activityOf('drawing', { thinking: 0, writing: 0 })).toBe('waiting');
    expect(activityOf('drawing', { thinking: 640, writing: 0 })).toBe('thinking 640');
    expect(activityOf('drawing', { thinking: 18_400, writing: 0 })).toBe('thinking 18k');
    expect(activityOf('drawing', { thinking: 18_400, writing: 2_100 })).toBe('writing 2k');
    expect(activityOf('refining', { thinking: 5_000, writing: 0 })).toBe('refining · thinking 5k');
    expect(activityOf('correcting', null)).toBe('correcting · waiting');
  });
});
