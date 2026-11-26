import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { readSchemasMode, writeSchemasMode } from './schemasMode';

describe('schemasMode', () => {
  it("reads '1' as on, anything else off; blocked storage reads off and write does not throw", () => {
    expect(readSchemasMode(memoryStorage({ 'acto.schemas': '1' }))).toBe(true);
    expect(readSchemasMode(memoryStorage({ 'acto.schemas': '0' }))).toBe(false);
    expect(readSchemasMode(memoryStorage({ 'acto.schemas': 'yes' }))).toBe(false);
    expect(readSchemasMode(memoryStorage())).toBe(false);
    expect(readSchemasMode(null)).toBe(false);
    const st = memoryStorage();
    writeSchemasMode(st, true);
    expect(st.getItem('acto.schemas')).toBe('1');
    writeSchemasMode(st, false);
    expect(st.getItem('acto.schemas')).toBe('0');
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(readSchemasMode(blocked)).toBe(false);
    expect(() => writeSchemasMode(blocked, true)).not.toThrow();
    expect(() => writeSchemasMode(null, true)).not.toThrow();
  });
});
