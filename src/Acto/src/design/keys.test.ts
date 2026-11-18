import { describe, expect, it } from 'vitest';
import { escapeKey, nudgeKey, pasteKey, undoRedoKey } from './keys';

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

describe('nudgeKey', () => {
  const k = (init: KeyboardEventInit, target?: HTMLElement) => {
    const e = new KeyboardEvent('keydown', init);
    if (target) Object.defineProperty(e, 'target', { value: target });
    return nudgeKey(e);
  };
  it('maps the arrows to 8 px', () => {
    expect(k({ key: 'ArrowLeft' })).toEqual({ dx: -8, dy: 0 });
    expect(k({ key: 'ArrowRight' })).toEqual({ dx: 8, dy: 0 });
    expect(k({ key: 'ArrowUp' })).toEqual({ dx: 0, dy: -8 });
    expect(k({ key: 'ArrowDown' })).toEqual({ dx: 0, dy: 8 });
    expect(k({ key: 'a' })).toBeNull();
  });
  it('is null with a modifier', () => {
    expect(k({ key: 'ArrowLeft', ctrlKey: true })).toBeNull();
    expect(k({ key: 'ArrowLeft', metaKey: true })).toBeNull();
    expect(k({ key: 'ArrowLeft', altKey: true })).toBeNull();
  });
  it.each(['input', 'textarea', 'select'])('is null inside a %s', (tag) => {
    expect(k({ key: 'ArrowLeft' }, document.createElement(tag))).toBeNull();
  });
});

describe('escapeKey (Ruling D1)', () => {
  const k = (init: KeyboardEventInit, dragging: boolean, target?: HTMLElement) => {
    const e = new KeyboardEvent('keydown', init);
    if (target) Object.defineProperty(e, 'target', { value: target });
    return escapeKey(e, dragging);
  };
  it('cancels a drag in progress and only that', () => {
    expect(k({ key: 'Escape' }, true)).toBe('cancel-drag');
    expect(k({ key: 'Escape' }, true, document.createElement('input'))).toBe('cancel-drag');
  });
  it('clears the picks when no drag is in progress', () => {
    expect(k({ key: 'Escape' }, false)).toBe('clear-picks');
    expect(k({ key: 'Escape' }, false, document.createElement('div'))).toBe('clear-picks');
  });
  it.each(['input', 'textarea', 'select'])('leaves the picks alone while typing in a %s', (tag) => {
    expect(k({ key: 'Escape' }, false, document.createElement(tag))).toBeNull();
  });
  it('is null for any other key', () => { expect(k({ key: 'Enter' }, false)).toBeNull(); expect(k({ key: 'Enter' }, true)).toBeNull(); });
});
