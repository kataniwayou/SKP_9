import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChatPane } from './ChatPane';
import { ChatError, modelOf, NOT_CONFIGURED } from './kimi';
import type { ChatStore } from './chatStore';
import type { ToolContext } from './toolTypes';
import { useChat } from './useChat';

/** Whether the server holds a key for the model (/ai/config): null while unknown or unreadable. */
function useConfigured(fetchFn: typeof fetch | undefined): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    const c = new AbortController();
    modelOf(c.signal, fetchFn).then(
      () => { if (!c.signal.aborted) setConfigured(true); },
      (e: unknown) => { if (!c.signal.aborted && e instanceof ChatError && e.message === NOT_CONFIGURED) setConfigured(false); },
    );
    return () => c.abort();
  }, [fetchFn]);
  return configured;
}

export interface ChatHostProps {
  chat: ChatStore;
  /** What the tools act on: the page's board store, API, Output, live state and commands. */
  ctx: ToolContext;
  /** The model's fetch (/ai/config and /ai/chat/completions); the browser's by default. */
  fetchFn?: typeof fetch;
  /** False while the board is still loading (App's `loaded`): the pane takes no message or answer until then. */
  ready?: boolean;
  /** The page's localStorage, for the sent-message history; null where the browser keeps nothing. */
  storage?: Storage | null;
}

/**
 * The Chat pane connected to the model (WorkflowStudio's ChatHost, without its dock and studio context): the agent loop
 * acts on the board through `ctx`. The chat is written to storage when the page goes away.
 */
export function ChatHost({ chat, ctx, fetchFn, ready = true, storage = null }: ChatHostProps) {
  const state = useSyncExternalStore(chat.subscribe, chat.getState);
  const { send, answer, stop, newChat, status } = useChat(ctx, chat, fetchFn);
  const configured = useConfigured(fetchFn);
  useEffect(() => {
    const flush = () => chat.flush();
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); chat.flush(); };
  }, [chat]);
  return <ChatPane chat={state} configured={configured} status={status} onSend={send} onAnswer={answer} onStop={stop} onNewChat={newChat} ready={ready} storage={storage} />;
}
