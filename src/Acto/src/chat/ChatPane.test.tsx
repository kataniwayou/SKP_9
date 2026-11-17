import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPane, type ChatPaneProps } from './ChatPane';
import type { ChatState } from './chatStore';
import { HISTORY_KEY } from './history';
import { NOT_CONFIGURED } from './kimi';

const idle: ChatState = { entries: [], wire: [], question: null, busy: false };

function pane() {
  const onSend = vi.fn();
  render(<ChatPane chat={idle} onSend={onSend} onAnswer={() => {}} onStop={() => {}} onNewChat={() => {}} status={null} configured storage={localStorage} />);
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(box, { target: { value: text } });
  // the key pressed with the caret at `caret` (default: the end)
  const press = (key: string, caret = box.value.length) => { box.setSelectionRange(caret, caret); fireEvent.keyDown(box, { key }); };
  return { box, type, press, onSend };
}

function shown(over: Partial<ChatPaneProps> = {}) {
  const props: ChatPaneProps = {
    chat: idle, onSend: vi.fn(), onAnswer: vi.fn(), onStop: vi.fn(), onNewChat: vi.fn(), status: null, configured: true, ...over,
  };
  render(<ChatPane {...props} />);
  return props;
}

const headerButtons = () => within(screen.getByRole('toolbar', { name: 'Chat' })).getAllByRole('button').map((b) => b.textContent);

describe('ChatPane header', () => {
  it('has exactly New chat while idle', () => {
    shown();
    expect(headerButtons()).toEqual(['New chat']);
  });

  it('has New chat and Stop while answering; Stop and New chat call back', () => {
    const p = shown({ chat: { ...idle, busy: true }, status: { seconds: 3, prompt: 100, tokens: 20, activity: 'thinking' } });
    expect(headerButtons()).toEqual(['New chat', 'Stop']);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(p.onStop).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(p.onNewChat).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('(3s · ↑ 100 · ↓ 20 tokens · thinking)');
  });

  it('shows no keyboard hint', () => {
    shown();
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box.getAttribute('placeholder')).not.toMatch(/Enter|Shift|Ctrl/);
  });
});

describe('ChatPane ask row', () => {
  it('Send sends what is written, trimmed, and empties the box', () => {
    const { box, type, onSend } = pane();
    type('  add a step  ');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('add a step');
    expect(box.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
  it('Send is closed while answering', () => {
    shown({ chat: { ...idle, busy: true } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
  it('shows the user on the right in the accent bubble and the model on the left', () => {
    shown({ chat: { ...idle, entries: [{ kind: 'user', text: 'hi' }, { kind: 'model', text: 'hello' }] } });
    expect(screen.getByText('hi')).toHaveClass('msg', 'me');
    expect(screen.getByText('hello')).toHaveClass('msg', 'ai');
  });
});

describe('ChatPane content', () => {
  it('not configured: the not-configured line, and the box is closed', () => {
    const p = shown({ configured: false });
    expect(screen.getByText(NOT_CONFIGURED)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it('shows a destructive tool\'s question with its warnings and one button per choice', () => {
    const p = shown({ chat: { ...idle, question: { callId: 'c1', text: 'Delete orders 1.0.0?', choices: ['Yes', 'No'], warnings: ['It is running'] } } });
    const q = screen.getByRole('group', { name: 'Question' });
    expect(q).toHaveTextContent('Delete orders 1.0.0?');
    expect(q).toHaveTextContent('It is running');
    fireEvent.click(within(q).getByRole('button', { name: 'No' }));
    expect(p.onAnswer).toHaveBeenCalledWith('No');
  });

  it('shows each kind of entry, errors marked', () => {
    shown({ chat: { ...idle, entries: [
      { kind: 'user', text: 'add a step' }, { kind: 'model', text: 'Done.' }, { kind: 'action', text: '+ step a', ok: true },
      { kind: 'action', text: 'save orders: refused', ok: false }, { kind: 'note', text: 'Cancelled', level: 'info' },
    ] } });
    expect(screen.getByText('add a step')).toHaveClass('chat-user');
    expect(screen.getByText('Done.')).toHaveClass('chat-model');
    expect(screen.getByText('+ step a')).not.toHaveClass('err');
    expect(screen.getByText('save orders: refused')).toHaveClass('err');
  });
});

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
