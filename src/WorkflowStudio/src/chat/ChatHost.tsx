import { createContext, useContext, useSyncExternalStore } from 'react';
import { ChatPane } from './ChatPane';
import type { ChatStore } from './chatStore';

const ChatStoreContext = createContext<ChatStore | null>(null);

/** Provides the chat store to the page; dock panels are portals, so they see it too. */
export const ChatStoreProvider = ChatStoreContext.Provider;

const NO_STATUS = { seconds: 0, tokens: 0, activity: 'thinking' };

/**
 * The Chat pane as the dock shows it. Not connected to the model yet (Task 8 wires `useChat` here): a message is
 * added to the conversation with a note saying so.
 */
export function ChatHost() {
  const store = useContext(ChatStoreContext);
  if (!store) throw new Error('ChatHost needs a ChatStoreProvider above it.');
  const chat = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <ChatPane
      chat={chat}
      configured={null}
      status={NO_STATUS}
      onSend={(text) => store.dispatch({
        type: 'entries',
        add: [{ kind: 'user', text }, { kind: 'note', text: 'The chat is not connected yet', level: 'info' }],
      })}
      onAnswer={() => undefined}
      onStop={() => undefined}
      onNewChat={() => store.dispatch({ type: 'newChat' })}
    />
  );
}
