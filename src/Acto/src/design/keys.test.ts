import { describe, expect, it } from 'vitest';
import { pasteKey, undoRedoKey } from './keys';

const key = (init: KeyboardEventInit, target?: HTMLElement) => {
  const e = new KeyboardEvent('keydown', init);
  if (target) Object.defineProperty(e, 'target', { value: target });
  return undoRedoKey(e);
};

describe('undoRedoKey', () => {
  it.each([
    [{ key: 'z', ctrlKey: true }, 'undo'],
    [{ key: 'z', metaKey: true }, 'undo'],
    [{ key: 'Z', ctrlKey: true, shiftKey: true }, 'redo'],
    [{ key: 'z', metaKey: true, shiftKey: true }, 'redo'],
    [{ key: 'y', ctrlKey: true }, 'redo'],
    [{ key: 'z' }, null],
    [{ key: 'y' }, null],
    [{ key: 'x', ctrlKey: true }, null],
  ] as const)('%j -> %s', (init, want) => { expect(key(init)).toBe(want); });
  it.each(['input', 'textarea', 'select'])('is ignored in a %s', (tag) => {
    expect(key({ key: 'z', ctrlKey: true }, document.createElement(tag))).toBeNull();
  });
  it('works on a div', () => { expect(key({ key: 'z', ctrlKey: true }, document.createElement('div'))).toBe('undo'); });
});

describe('pasteKey', () => {
  const k = (init: KeyboardEventInit, target?: HTMLElement) => {
    const e = new KeyboardEvent('keydown', init);
    if (target) Object.defineProperty(e, 'target', { value: target });
    return pasteKey(e);
  };
  it('is Ctrl/Cmd+V on the body', () => {
    expect(k({ key: 'v', ctrlKey: true })).toBe(true);
    expect(k({ key: 'V', metaKey: true })).toBe(true);
    expect(k({ key: 'v' })).toBe(false);
    expect(k({ key: 'c', ctrlKey: true })).toBe(false);
  });
  it.each(['input', 'textarea', 'select'])('is false inside a %s', (tag) => {
    expect(k({ key: 'v', ctrlKey: true }, document.createElement(tag))).toBe(false);
  });
  it('is false inside contentEditable', () => {
    const d = document.createElement('div');
    Object.defineProperty(d, 'isContentEditable', { value: true });
    expect(k({ key: 'v', ctrlKey: true }, d)).toBe(false);
  });
});
