import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { DrawingError, modelOf, NOT_CONFIGURED } from '../ai/drawing';
import { useStudioActionsOrNull } from '../app/studioActions';
import { newId } from '../design/ids';
import { useStudioStore } from '../store/studioStore';
import { ChatPane } from './ChatPane';
import type { ChatStore } from './chatStore';
import type { ToolContext } from './toolTypes';
import { useChat } from './useChat';

const ChatStoreContext = createContext<ChatStore | null>(null);

/** Provides the chat store to the page; dock panels are portals, so they see it too. */
export const ChatStoreProvider = ChatStoreContext.Provider;

export const UNAVAILABLE_NOTE = 'The chat is not available here: the studio\'s commands are missing';

/** Whether the server holds a key for the model (/ai/config, as the wand asks): null while unknown or unreadable. */
function useConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    const c = new AbortController();
    modelOf(c.signal).then(
      () => setConfigured(true),
      (e: unknown) => { if (!c.signal.aborted && e instanceof DrawingError && e.message === NOT_CONFIGURED) setConfigured(false); },
    );
    return () => c.abort();
  }, []);
  return configured;
}

/** The pane connected to the model: the agent loop acts on the studio through `ctx`. */
function ConnectedChat({ chat, ctx }: { chat: ChatStore; ctx: ToolContext }) {
  const state = useSyncExternalStore(chat.subscribe, chat.getState);
  const { send, answer, stop, newChat, status } = useChat(ctx, chat);
  const configured = useConfigured();
  return <ChatPane chat={state} configured={configured} status={status} onSend={send} onAnswer={answer} onStop={stop} onNewChat={newChat} />;
}

/**
 * The Chat pane as the dock shows it (2026-10-23). The tools act through the page's store, Inspector service, API and
 * workflow commands; without the commands (a pane rendered on its own) the chat cannot act, and says so.
 */
export function ChatHost() {
  const chat = useContext(ChatStoreContext);
  if (!chat) throw new Error('ChatHost needs a ChatStoreProvider above it.');
  const store = useStudioStore();
  const actions = useStudioActionsOrNull();
  const state = useSyncExternalStore(chat.subscribe, chat.getState);
  if (actions?.commands && actions.api) {
    return <ConnectedChat chat={chat} ctx={{ store, service: actions.service, api: actions.api, commands: actions.commands, newId }} />;
  }
  return (
    <ChatPane
      chat={state}
      configured={null}
      status={null}
      onSend={(text) => chat.dispatch({ type: 'entries', add: [{ kind: 'user', text }, { kind: 'note', text: UNAVAILABLE_NOTE, level: 'error' }] })}
      onAnswer={() => undefined}
      onStop={() => undefined}
      onNewChat={() => chat.dispatch({ type: 'newChat' })}
    />
  );
}
