import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from './ChatPane';
import type { ChatState } from './chatStore';
import { HISTORY_KEY } from './history';

const idle: ChatState = { entries: [], wire: [], question: null, busy: false };

function pane() {
  const onSend = vi.fn();
  render(<ChatPane chat={idle} onSend={onSend} onAnswer={() => {}} onStop={() => {}} onNewChat={() => {}} status={null} configured />);
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(box, { target: { value: text } });
  // the key pressed with the caret at `caret` (default: the end)
  const press = (key: string, caret = box.value.length) => { box.setSelectionRange(caret, caret); fireEvent.keyDown(box, { key }); };
  return { box, type, press, onSend };
}

describe('ChatPane message history (↑ / ↓, 2026-10-24)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('↑ brings back what was sent, newest first; ↓ walks forward and gives back the draft', () => {
    const { box, type, press, onSend } = pane();
    for (const m of ['first', 'second']) { type(m); press('Enter'); }
    expect(onSend.mock.calls.map((c) => c[0])).toEqual(['first', 'second']);
    expect(box.value).toBe('');
    type('half written');
    press('ArrowUp');
    expect(box.value).toBe('second');
    press('ArrowUp', 0);
    expect(box.value).toBe('first');
    press('ArrowUp', 0);
    expect(box.value).toBe('first');
    press('ArrowDown');
    expect(box.value).toBe('second');
    press('ArrowDown');
    expect(box.value).toBe('half written');
  });

  it('in a message of several lines the arrows move between its lines; only the first line goes back, the last forward', () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(['older', 'line one\nline two']));
    const { box, press } = pane();
    press('ArrowUp');
    expect(box.value).toBe('line one\nline two');
    // the caret is on the last line: ↑ is the textarea's own, the message stays
    press('ArrowUp');
    expect(box.value).toBe('line one\nline two');
    press('ArrowUp', 3);
    expect(box.value).toBe('older');
    press('ArrowDown', 0);
    expect(box.value).toBe('line one\nline two');
    press('ArrowDown', 3);
    expect(box.value).toBe('line one\nline two');
  });

  it('outlives the pane: the history is in the browser, and a message sent twice in a row is kept once', () => {
    const first = pane();
    for (const m of ['again', 'again']) { first.type(m); first.press('Enter'); }
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!)).toEqual(['again']);
  });
});
