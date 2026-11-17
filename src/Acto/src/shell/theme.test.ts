import { describe, expect, it } from 'vitest';
import { applyTheme, saveTheme, savedTheme } from './theme';
import { memoryStorage } from '../test/memoryStorage';

describe('theme', () => {
  it('is light unless dark was saved', () => {
    const st = memoryStorage();
    expect(savedTheme(st)).toBe('light');
    st.setItem('acto.theme', 'dark');
    expect(savedTheme(st)).toBe('dark');
    st.setItem('acto.theme', 'nonsense');
    expect(savedTheme(st)).toBe('light');
    expect(savedTheme(null)).toBe('light');
  });
  it('is light when storage throws, and saving into a throwing storage is silent', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(savedTheme(bad)).toBe('light');
    expect(() => saveTheme('dark', bad)).not.toThrow();
  });
  it('saves under acto.theme', () => {
    const st = memoryStorage();
    saveTheme('dark', st);
    expect(st.getItem('acto.theme')).toBe('dark');
  });
  it('applies to the document element', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
