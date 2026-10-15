import { describe, expect, it } from 'vitest';
import { keyCommand } from './keys';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  keyCommand({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('Start and Stop keys (review 2026-10-09)', () => {
  it('plain F5 starts and Shift+F5 stops', () => {
    expect([key('F5'), key('F5', { shiftKey: true })]).toEqual(['start', 'stop']);
  });

  it('Ctrl, Meta or Alt with F5 is left to the browser (Ctrl+F5 is a hard reload)', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }]) {
      expect(key('F5', mods)).toBeNull();
    }
  });
});
