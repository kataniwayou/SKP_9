import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { clampSize, DEFAULT_SIZES, readSizes, writeSizes } from './panelSizes';

describe('panelSizes', () => {
  it('clamps and round-trips sizes', () => {
    const st = memoryStorage();
    writeSizes(st, { tools: clampSize('tools', 999), inspector: 300, bottom: clampSize('bottom', 10), output: null });
    expect(readSizes(st)).toEqual({ tools: 340, inspector: 300, bottom: 90, output: null });
    expect(readSizes(null)).toEqual(DEFAULT_SIZES);
  });

  it('falls back to defaults on garbage and clamps stored values', () => {
    expect(readSizes(memoryStorage({ 'acto.panels': 'not json' }))).toEqual(DEFAULT_SIZES);
    const s = readSizes(memoryStorage({ 'acto.panels': JSON.stringify({ tools: 5, inspector: 'x', output: 5000 }) }));
    expect(s).toEqual({ tools: 150, inspector: 300, bottom: 190, output: 900 });
  });

  it('survives a storage that throws', () => {
    const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } } as unknown as Storage;
    expect(readSizes(bad)).toEqual(DEFAULT_SIZES);
    expect(() => writeSizes(bad, DEFAULT_SIZES)).not.toThrow();
  });
});
