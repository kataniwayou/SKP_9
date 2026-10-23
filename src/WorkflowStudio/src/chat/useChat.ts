import { useMemo, useSyncExternalStore } from 'react';
import { DrawingError, modelOf } from '../ai/drawing';
import type { ChatAction, ChatStore, ChatState } from './chatStore';
import type { ChatStatus } from './ChatPane';
import { ChatError, requestTurn, type ChatWire, type ToolCall } from './kimi';
import { systemPrompt } from './prompt';
import { runTool } from './runTool';
import { TOOLS } from './tools';
import type { ToolContext } from './toolTypes';

/** A user request may take this many rounds with the model; then the loop is ended with a note (spec: a runaway loop). */
export const MAX_ROUNDS = 40;
export const ANSWER_FIRST = 'Answer the question first';
// what Undo reaches is the drawing only (2026-10-23): field edits and assignments are reversed by Revert entity / Discard design
export const CANCELLED_NOTE = 'Cancelled: what was already done stays (Undo reverses drawing changes; Revert entity or Discard design reverses field edits)';
const LOST_CALL = 'The question\'s tool call was lost; nothing was done';
const NOT_RUN_STOPPED = 'not run: the user stopped the request';
// a call unanswered after a refresh may have run (the request died before its result was recorded), so it is not said to be "not run"
const NOT_RUN_LOST = 'the request was lost at refresh before this call\'s result was recorded: it may have run; read the design and Output before going on';

type Outcome = 'asked' | 'continue';

/** One request in flight: its cancel signal, and `put`, which drops what it dispatches once the chat was started anew. */
interface Run { signal: AbortSignal; put(action: ChatAction): void }

const toWire = (c: ToolCall) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } });

/** The last assistant message's calls that have no tool message yet (a request stopped or lost at refresh among them). */
function unanswered(wire: readonly ChatWire[]): string[] {
  const at = wire.findLastIndex((m) => m.role === 'assistant');
  const m = wire[at];
  if (!m || m.role !== 'assistant' || !m.tool_calls) return [];
  const answered = new Set(wire.slice(at + 1).flatMap((x) => (x.role === 'tool' ? [x.tool_call_id] : [])));
  return m.tool_calls.map((c) => c.id).filter((id) => !answered.has(id));
}

/** The calls of the last assistant message and where `callId` is among them, or null. */
function callsOf(state: ChatState, callId: string): { calls: ToolCall[]; index: number } | null {
  const m = state.wire.findLast((x) => x.role === 'assistant');
  if (!m || m.role !== 'assistant' || !m.tool_calls) return null;
  const calls = m.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
  const index = calls.findIndex((c) => c.id === callId);
  return index < 0 ? null : { calls, index };
}

/**
 * The chat's agent loop (2026-10-23): the user's message, then rounds of the model's turn and its tool calls carried out
 * in order, each shown as it finishes (the canvas has already changed), until a turn calls no tool. A destructive call
 * stops the loop with the studio's question; the answer runs that same call once and the loop goes on, even after a
 * refresh (the call is found in the stored conversation by its id). One per chat store, so it outlives the pane's
 * mounting (a dock pane may be hidden and shown again while the model works).
 */
class ChatRunner {
  ctx: ToolContext | null = null;
  fetchFn: typeof fetch = (...a) => fetch(...a);
  private ctl: AbortController | null = null;
  private generation = 0;
  // the current user request: its rounds and the tokens of its finished rounds; `roundTokens` the round in flight
  private rounds = 0;
  private tokens = 0;
  private roundTokens = 0;
  private activity = 'thinking';
  private started = 0;
  private status: ChatStatus | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly chat: ChatStore) {}

  getStatus = (): ChatStatus | null => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private show(): void {
    this.status = this.ctl
      ? { seconds: Math.floor((Date.now() - this.started) / 1000), tokens: this.tokens + this.roundTokens, activity: this.activity }
      : null;
    for (const l of [...this.listeners]) l();
  }

  private setActivity(activity: string): void {
    if (activity === this.activity) return;
    this.activity = activity;
    this.show();
  }

  send(text: string): void {
    const t = text.trim();
    const state = this.chat.getState();
    if (t === '' || this.ctl || state.busy) return;
    const q = state.question;
    if (q) {
      const choice = q.choices.find((c) => c.trim().toLowerCase() === t.toLowerCase());
      if (choice !== undefined) this.answer(choice, t);
      else this.chat.dispatch({ type: 'entries', add: [{ kind: 'user', text: t }, { kind: 'note', text: ANSWER_FIRST, level: 'info' }] });
      return;
    }
    this.rounds = 0;
    this.tokens = 0;
    // a call left without its answer (a stop, a refresh) is answered now: the model's API takes no call unanswered
    const fillers: ChatWire[] = unanswered(state.wire).map((id) => ({ role: 'tool', tool_call_id: id, content: NOT_RUN_LOST }));
    this.chat.dispatch({ type: 'entries', add: [{ kind: 'user', text: t }] });
    this.chat.dispatch({ type: 'wire', add: [...fillers, { role: 'user', content: t }] });
    void this.drive(async () => 'continue');
  }

  /** The user's choice on the open question; `shown` is what the chat shows they said (the typed text, or the button's). */
  answer(choice: string, shown: string = choice): void {
    const state = this.chat.getState();
    const q = state.question;
    if (!q || this.ctl || state.busy || !q.choices.includes(choice)) return;
    const found = callsOf(state, q.callId);
    this.chat.dispatch({ type: 'entries', add: [{ kind: 'user', text: shown }] });
    this.chat.dispatch({ type: 'ask', question: null });
    if (!found) {
      this.chat.dispatch({ type: 'entries', add: [{ kind: 'note', text: LOST_CALL, level: 'error' }] });
      return;
    }
    void this.drive(async (run) => {
      if (await this.runCall(run, found.calls[found.index]!, choice, q.pin) === 'asked') return 'asked';
      return this.runCalls(run, found.calls, found.index + 1);
    });
  }

  stop(): void {
    this.ctl?.abort();
  }

  /** Forgets the conversation; a request in flight is cancelled and nothing more of it reaches the new chat. */
  newChat(): void {
    this.generation++;
    this.ctl?.abort();
    // the old run unwinds later; a message sent meanwhile must start a run of its own, not be taken as "busy"
    this.ctl = null;
    this.chat.dispatch({ type: 'newChat' });
  }

  private async drive(start: (run: Run) => Promise<Outcome>): Promise<void> {
    const ctl = new AbortController();
    const generation = this.generation;
    const run: Run = { signal: ctl.signal, put: (a) => { if (generation === this.generation) this.chat.dispatch(a); } };
    const note = (text: string, level: 'info' | 'error') => run.put({ type: 'entries', add: [{ kind: 'note', text, level }] });
    this.ctl = ctl;
    this.started = Date.now();
    this.activity = 'thinking';
    this.roundTokens = 0;
    run.put({ type: 'busy', on: true });
    this.show();
    const tick = setInterval(() => this.show(), 1000);
    try {
      if (await start(run) === 'asked') return;
      let model: string | null = null;
      for (;;) {
        if (this.rounds >= MAX_ROUNDS) { note(`Stopped after ${MAX_ROUNDS} rounds`, 'error'); return; }
        this.rounds++;
        model ??= await modelOf(run.signal, this.fetchFn);
        this.setActivity('thinking');
        const messages: ChatWire[] = [{ role: 'system', content: systemPrompt() }, ...this.chat.getState().wire];
        const turn = await requestTurn(model, messages, TOOLS, run.signal, (p) => {
          this.roundTokens = p.tokens;
          this.setActivity(p.phase === 'writing' ? 'writing' : 'thinking');
        }, this.fetchFn);
        this.tokens += turn.tokens;
        this.roundTokens = 0;
        // an id is what pairs a call with its answer; one missing from the stream is made up, unique in the request
        const calls = turn.calls.map((c, i) => (c.id === '' ? { ...c, id: `call-${this.rounds}-${i}` } : c));
        // a turn with neither text nor calls adds nothing to the wire: an empty assistant message is refused by the model's API
        if (turn.text.trim() !== '' || calls.length > 0) {
          run.put({ type: 'wire', add: [{ role: 'assistant', content: turn.text, ...(calls.length > 0 ? { tool_calls: calls.map(toWire) } : {}) }] });
        }
        if (turn.text.trim() !== '') run.put({ type: 'entries', add: [{ kind: 'model', text: turn.text.trim() }] });
        if (calls.length === 0) {
          if (turn.text.trim() === '') note('The model gave no answer', 'error');
          return;
        }
        if (await this.runCalls(run, calls, 0) === 'asked') return;
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (ctl.signal.aborted || text === 'cancelled') note(CANCELLED_NOTE, 'info');
      else note(e instanceof ChatError || e instanceof DrawingError ? text.replace(/^AI drawing is not configured/, 'The chat is not configured') : `the chat failed: ${text}`, 'error');
    } finally {
      clearInterval(tick);
      if (this.ctl === ctl) this.ctl = null;
      run.put({ type: 'busy', on: false });
      this.show();
    }
  }

  /** Carries out `calls` from `from` on, in order, until one asks the user; a stop leaves the rest answered as not run. */
  private async runCalls(run: Run, calls: readonly ToolCall[], from: number): Promise<Outcome> {
    for (let i = from; i < calls.length; i++) {
      if (run.signal.aborted) {
        run.put({ type: 'wire', add: calls.slice(i).map((c): ChatWire => ({ role: 'tool', tool_call_id: c.id, content: NOT_RUN_STOPPED })) });
        throw new ChatError('cancelled');
      }
      if (await this.runCall(run, calls[i]!) === 'asked') return 'asked';
    }
    return 'continue';
  }

  /** One call: its action line and echoed Output in the chat and its answer to the model, or the studio's question. */
  private async runCall(run: Run, call: ToolCall, answer?: string, pin?: string): Promise<Outcome | 'done'> {
    if (!this.ctx) throw new ChatError('the chat has no studio to act on');
    this.setActivity(`running ${call.name}`);
    const out = await runTool(this.ctx, call, answer, pin);
    if (out.kind === 'ask') {
      run.put({ type: 'ask', question: { callId: call.id, ...out.question } });
      return 'asked';
    }
    // a failed action says why: the result's first line, unless the action line already does
    const why = out.result.split('\n')[0]!;
    const line = out.ok || out.action.includes(why) ? out.action : `${out.action}: ${why}`;
    run.put({ type: 'entries', add: [{ kind: 'action', text: line, ok: out.ok }, ...out.entries] });
    run.put({ type: 'wire', add: [{ role: 'tool', tool_call_id: call.id, content: out.result }] });
    return 'done';
  }
}

const runners = new WeakMap<ChatStore, ChatRunner>();

function runnerOf(chat: ChatStore): ChatRunner {
  let r = runners.get(chat);
  if (!r) { r = new ChatRunner(chat); runners.set(chat, r); }
  return r;
}

export interface Chat {
  send(text: string): void;
  answer(choice: string): void;
  stop(): void;
  newChat(): void;
  /** What the model is doing while a request runs, else null. */
  status: ChatStatus | null;
}

/**
 * The chat's loop for the pane (2026-10-23): `send` a message, `answer` the open question, `stop` the request in flight
 * (what was done stays), `newChat`; `status` ticks each second while it works. `ctx` is what the tools act on.
 */
export function useChat(ctx: ToolContext, chat: ChatStore, fetchFn?: typeof fetch): Chat {
  const runner = runnerOf(chat);
  // the latest studio pieces: a call always acts on what the page has now
  runner.ctx = ctx;
  if (fetchFn) runner.fetchFn = fetchFn;
  const status = useSyncExternalStore(runner.subscribe, runner.getStatus);
  const actions = useMemo(() => ({
    send: (text: string) => runner.send(text),
    answer: (choice: string) => runner.answer(choice),
    stop: () => runner.stop(),
    newChat: () => runner.newChat(),
  }), [runner]);
  return { ...actions, status };
}
