import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Highlights } from '../app/highlights';
import type { Workspace } from '../app/workspace';
import { ChatPane } from './ChatPane';
import { ChatError, modelOf, NOT_CONFIGURED } from './kimi';
import type { ChatStore } from './chatStore';
import { useChat } from './useChat';

const ChatStoreContext = createContext<ChatStore | null>(null);

/** Provides the chat store to the page; dock panels are portals, so they see it too. */
export const ChatStoreProvider = ChatStoreContext.Provider;

/** Whether the server holds a key for the model (/ai/config): null while unknown or unreadable. */
function useConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    const c = new AbortController();
    modelOf(c.signal).then(
      () => setConfigured(true),
      (e: unknown) => { if (!c.signal.aborted && e instanceof ChatError && e.message === NOT_CONFIGURED) setConfigured(false); },
    );
    return () => c.abort();
  }, []);
  return configured;
}

/**
 * The Chat pane as the dock shows it (2026-10-26, as SKP Studio's): the agent loop acts on Valence's workspace and its
 * workflow filter, as the user's own gestures do.
 */
export function ChatHost({ workspace, highlights }: { workspace: Workspace; highlights: Highlights }) {
  const chat = useContext(ChatStoreContext);
  if (!chat) throw new Error('ChatHost needs a ChatStoreProvider above it.');
  const state = useSyncExternalStore(chat.subscribe, chat.getState);
  const { send, answer, stop, newChat, status } = useChat({ workspace, highlights }, chat);
  const configured = useConfigured();
  return <ChatPane chat={state} configured={configured} status={status} onSend={send} onAnswer={answer} onStop={stop} onNewChat={newChat} />;
}
