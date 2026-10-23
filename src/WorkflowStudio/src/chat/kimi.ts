import { AI_EFFORT, AI_SILENCE_MS, NOT_CONFIGURED } from '../ai/drawing';

/** One tool call the model made: its id, the tool's name and the arguments as the JSON text the model wrote. */
export interface ToolCall { id: string; name: string; arguments: string }
/** One answer of the model: what it said, what it thought, the tools it called, and the tokens it spent. */
export interface AssistantTurn { text: string; reasoning: string; calls: ToolCall[]; tokens: number }

/** A message as the model's API takes it (OpenAI style). */
export type ChatWire =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning_content?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** How far one answer has come: waiting for the first word, thinking, or writing (text or tool calls). */
export interface Progress { phase: 'waiting' | 'thinking' | 'writing'; tokens: number }

export class ChatError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Asks the model for its next turn (2026-10-23), streamed, with the tools it may call. Tool calls arrive in pieces joined
 * by `index` (the first piece has id and name, the rest only argument fragments); `usage` arrives as a last chunk of its
 * own, and its completion_tokens already include the thinking. Without usage the tokens are estimated at 4 characters each.
 * The round is given up after AI_SILENCE_MS without a byte, as the wand's is.
 */
export async function requestTurn(
  model: string, messages: readonly ChatWire[], tools: readonly object[], signal: AbortSignal,
  onProgress: (p: Progress) => void, fetchFn: typeof fetch = fetch,
): Promise<AssistantTurn> {
  const round = new AbortController();
  let silent = false;
  let silence: ReturnType<typeof setTimeout> | undefined;
  const quiet = () => {
    clearTimeout(silence);
    silence = setTimeout(() => { silent = true; round.abort(); }, AI_SILENCE_MS);
  };
  const onAbort = () => round.abort();
  if (signal.aborted) throw new ChatError('cancelled');
  signal.addEventListener('abort', onAbort);
  const failed = (what: string): ChatError => (signal.aborted ? new ChatError('cancelled')
    : silent ? new ChatError(`no word from the model for ${AI_SILENCE_MS / 1000} s`) : new ChatError(what));
  try {
    onProgress({ phase: 'waiting', tokens: 0 });
    quiet();
    let r: Response;
    try {
      r = await fetchFn('/ai/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: round.signal,
        body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, messages, tools, reasoning_effort: AI_EFFORT }),
      });
    } catch (e) {
      throw failed(`the model could not be reached (${e instanceof Error ? e.message : 'network error'})`);
    }
    if (r.status === 503 || r.status === 404) throw new ChatError(NOT_CONFIGURED);
    if (r.status === 401 || r.status === 403) throw new ChatError(`the model refused the key (HTTP ${r.status})`);
    // 400 is what the model answers to a conversation over its context length (2026-10-23): the way out is a New chat
    if (r.status === 400) throw new ChatError(`The conversation is too long for the model: start a New chat (HTTP ${r.status})`);
    if (!r.ok) throw new ChatError(`the model answered HTTP ${r.status}`);
    if (!r.body) throw new ChatError('the model sent no stream');
    try {
      return await readTurn(r.body, onProgress, quiet);
    } catch (e) {
      if (e instanceof ChatError && !signal.aborted && !silent) throw e;
      throw failed('the model\'s reply could not be read');
    }
  } finally {
    clearTimeout(silence);
    signal.removeEventListener('abort', onAbort);
  }
}

/** The turn from an OpenAI-style event stream, until [DONE]; `heard` is called at every read, however empty. */
async function readTurn(body: ReadableStream<Uint8Array>, onProgress: (p: Progress) => void, heard: () => void): Promise<AssistantTurn> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', reasoning = '', usage: number | null = null;
  const pieces = new Map<number, ToolCall>();
  let phase: Progress['phase'] = 'waiting';
  const tokens = () => usage ?? Math.round((text.length + reasoning.length + [...pieces.values()].reduce((n, c) => n + c.arguments.length, 0)) / 4);
  const line = (l: string): boolean => {
    const t = l.trim();
    if (!t.startsWith('data:')) return false;
    const data = t.slice(5).trim();
    if (data === '[DONE]') return true;
    let v: unknown;
    try { v = JSON.parse(data); } catch { throw new ChatError('the model\'s reply is not JSON'); }
    if (!isObj(v)) return false;
    if (isObj(v.error)) throw new ChatError(`the model failed: ${String(v.error.message ?? 'error').slice(0, 200)}`);
    if (isObj(v.usage) && typeof v.usage.completion_tokens === 'number') usage = v.usage.completion_tokens;
    const choice = Array.isArray(v.choices) && isObj(v.choices[0]) ? v.choices[0] : undefined;
    const delta = choice && isObj(choice.delta) ? choice.delta : undefined;
    if (delta) {
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') { reasoning += delta.reasoning_content; phase = 'thinking'; }
      if (typeof delta.content === 'string' && delta.content !== '') { text += delta.content; phase = 'writing'; }
      if (Array.isArray(delta.tool_calls)) {
        for (const p of delta.tool_calls) {
          if (!isObj(p) || typeof p.index !== 'number') continue;
          const call = pieces.get(p.index) ?? { id: '', name: '', arguments: '' };
          if (typeof p.id === 'string') call.id = p.id;
          const f = isObj(p.function) ? p.function : {};
          if (typeof f.name === 'string') call.name += f.name;
          if (typeof f.arguments === 'string') call.arguments += f.arguments;
          pieces.set(p.index, call);
          phase = 'writing';
        }
      }
    }
    onProgress({ phase, tokens: tokens() });
    return false;
  };
  const turn = (): AssistantTurn => ({ text, reasoning, calls: [...pieces].sort((a, b) => a[0] - b[0]).map(([, c]) => c), tokens: tokens() });
  for (;;) {
    const { done, value } = await reader.read();
    heard();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const l of lines) if (line(l)) { void reader.cancel(); return turn(); }
    if (done) return turn();
  }
}
