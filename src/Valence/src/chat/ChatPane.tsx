import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatEntry, ChatState } from './chatStore';
import { readHistory, stepHistory, withSent, writeHistory } from './history';
import { StatusLine } from './StatusLine';

export interface ChatStatus { seconds: number; prompt: number; tokens: number; activity: string }

export interface ChatPaneProps {
  chat: ChatState;
  onSend(text: string): void;
  onAnswer(choice: string): void;
  onStop(): void;
  onNewChat(): void;
  /** What the model is doing, while a request runs; null when none runs here. */
  status: ChatStatus | null;
  /** Whether the model has a key on the server: null while that is not known yet. */
  configured: boolean | null;
}

export const NOT_CONFIGURED_NOTE = 'The chat is not configured: the server holds no key for the model.';

function Entry({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case 'user': return <div className="chat-e chat-user">{entry.text}</div>;
    case 'model': return <div className="chat-e chat-model">{entry.text}</div>;
    case 'action': return <div className={entry.ok ? 'chat-e chat-action' : 'chat-e chat-action err'}>{entry.text}</div>;
    case 'output':
      return <div className={entry.level === 'error' ? 'chat-e chat-output err' : 'chat-e chat-output'} data-level={entry.level}><b>{entry.name}</b> {entry.text}</div>;
    case 'problems':
      return <div className="chat-e chat-problems err" role="list" aria-label="Problems">{entry.lines.map((l, i) => <div key={i} role="listitem">{l}</div>)}</div>;
    case 'note': return <div className={entry.level === 'error' ? 'chat-e chat-note err' : 'chat-e chat-note'} data-level={entry.level}>{entry.text}</div>;
  }
}

/** Within this many pixels of its end a log counts as read to the end. */
const NEAR_END = 24;

/**
 * The Chat pane (2026-10-23): the conversation, the model's question as one button per choice, what it is doing and a
 * Stop while it works, a box to write in and New chat. It shows the store and calls back; the agent loop is not here.
 * In the box ↑ on the first line and ↓ on the last walk what was sent before (2026-10-24, as in Claude Code), ↓ past the
 * newest giving back what was being written.
 */
export function ChatPane({ chat, onSend, onAnswer, onStop, onNewChat, status, configured }: ChatPaneProps) {
  const [text, setText] = useState('');
  const [log, setLog] = useState<HTMLDivElement | null>(null);
  // follows the end while the user is there; a user who scrolled up to read is left where they are
  const following = useRef(true);
  useEffect(() => {
    if (log && following.current) log.scrollTop = log.scrollHeight;
  }, [log, chat.entries, chat.question, chat.busy]);
  const blocked = configured === false;
  // the sent messages, the one the box shows (null: the user's own draft, kept aside while they walk back)
  const [history, setHistory] = useState(readHistory);
  const [at, setAt] = useState<number | null>(null);
  const draft = useRef('');
  const input = useRef<HTMLTextAreaElement>(null);
  const [recalled, setRecalled] = useState(0);
  // a recalled message is shown with the caret at its end
  useLayoutEffect(() => {
    const el = input.current;
    if (recalled > 0 && el) el.setSelectionRange(el.value.length, el.value.length);
  }, [recalled]);

  const send = () => {
    const t = text.trim();
    if (t === '' || chat.busy || blocked) return;
    const next = withSent(history, t);
    setHistory(next);
    writeHistory(next);
    setAt(null);
    draft.current = '';
    setText('');
    following.current = true;
    onSend(t);
  };
  const recall = (e: KeyboardEvent<HTMLTextAreaElement>, by: -1 | 1): void => {
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    // only from the first line up, or the last line down: elsewhere the arrow moves the caret between lines
    if (by === -1 ? text.slice(0, el.selectionStart).includes('\n') : text.slice(el.selectionEnd).includes('\n')) return;
    const step = stepHistory(history.length, at, by);
    if (!step) return;
    e.preventDefault();
    if (at === null) draft.current = text;
    setAt(step.at);
    setText(step.at === null ? draft.current : history[step.at]!);
    setRecalled((n) => n + 1);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) recall(e, e.key === 'ArrowUp' ? -1 : 1);
  };

  return (
    <div className="paneBody chat" data-pane="chat">
      <div className="otools" role="toolbar" aria-label="Chat">
        <button type="button" className="qb" aria-label="New chat" data-tip="Forget this conversation and start again" onClick={onNewChat}>New chat</button>
      </div>
      <div
        ref={setLog}
        className="pbody chat-log"
        role="log"
        aria-label="Chat"
        onScroll={(e) => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_END; }}
      >
        {chat.entries.length === 0 && !blocked && <div className="note pane-note">Ask about the project, or for a change to it, and watch it happen on the molecule.</div>}
        {chat.entries.map((e, i) => <Entry key={i} entry={e} />)}
        {blocked && <div className="chat-e chat-note err" data-level="error">{NOT_CONFIGURED_NOTE}</div>}
        {chat.question && (
          <div className="chat-question" role="group" aria-label="Question">
            <div className="chat-q-text">{chat.question.text}</div>
            {chat.question.warnings?.map((w, i) => <div key={i} className="chat-q-warn">{w}</div>)}
            <div className="chat-choices">
              {chat.question.choices.map((c) => <button key={c} type="button" className="qb" onClick={() => onAnswer(c)}>{c}</button>)}
            </div>
          </div>
        )}
      </div>
      {chat.busy && (
        <div className="chat-busy">
          {status && <StatusLine seconds={status.seconds} prompt={status.prompt} tokens={status.tokens} activity={status.activity} />}
          <button type="button" className="qb" aria-label="Stop" onClick={onStop}>Stop</button>
        </div>
      )}
      <textarea
        ref={input}
        className="chat-input"
        aria-label="Message"
        rows={2}
        placeholder={chat.busy ? 'Working…' : 'Write a message (Enter sends, Shift+Enter for a new line)'}
        value={text}
        disabled={chat.busy || blocked}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
