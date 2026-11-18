import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import type { ApiResult } from './api/client';
import { boardApi } from './board/testApi';
import { liveStub } from './test/liveStub';
import { memoryStorage } from './test/memoryStorage';
import { chatPanel, chatSettled, say, scriptedAi, sendChat } from './test/scriptedAi';

describe('App chat: storage and loading', () => {
  it('a browser that blocks site data: the board and the chat render, and a message still goes to the model (Must 1)', async () => {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    try {
      const aiFetch = scriptedAi([say('hello')]);
      render(<App api={boardApi()} live={liveStub()} storage={null} session={null} aiFetch={aiFetch as unknown as typeof fetch} />);
      expect(await screen.findByTestId('rf__node-wf:daily')).toBeInTheDocument();
      expect(await screen.findByText('Board loaded: 2 workflows')).toBeInTheDocument();
      await sendChat('hi');
      expect(await chatPanel().findByText('hello')).toBeInTheDocument();
      await chatSettled();
      expect(aiFetch.mock.calls.map((c) => c[0])).toContain('/ai/chat/completions');
    } finally {
      if (own) Object.defineProperty(window, 'localStorage', own);
      else delete (window as { localStorage?: Storage }).localStorage;
    }
  });

  it('the chat waits for the board: the box and a restored question stay closed until the board has loaded (S1)', async () => {
    const api = boardApi();
    const list = api.listWorkflows;
    let release: () => void = () => {};
    api.listWorkflows = (() => new Promise<ApiResult<never>>((res) => { release = () => res(list() as never); })) as typeof api.listWorkflows;
    const session = memoryStorage({ 'acto.chat': JSON.stringify({ entries: [], wire: [], question: { callId: 'c1', text: 'Stop hourly?', choices: ['Stop', 'Cancel'], pin: 'hourly' } }) });
    const aiFetch = scriptedAi();
    render(<App api={api} live={liveStub()} storage={memoryStorage()} session={session} aiFetch={aiFetch as unknown as typeof fetch} />);
    expect(await screen.findByText('Loading the board…', { selector: '.board-wait' })).toBeInTheDocument();
    await waitFor(() => expect(aiFetch).toHaveBeenCalledWith('/ai/config', expect.anything()));
    await Promise.resolve();
    expect(chatPanel().getByText('Loading the board…')).toBeInTheDocument();
    expect(chatPanel().getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(chatPanel().getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(chatPanel().getByRole('button', { name: 'Cancel' })).toBeDisabled();
    release();
    expect(await screen.findByText('Board loaded: 2 workflows')).toBeInTheDocument();
    expect(await screen.findByTestId('rf__node-wf:hourly')).toBeInTheDocument();
    await waitFor(() => expect(chatPanel().getByRole('textbox', { name: 'Message' })).not.toBeDisabled());
    expect(chatPanel().getByRole('button', { name: 'Stop' })).not.toBeDisabled();
    expect(chatPanel().queryByText('Loading the board…')).toBeNull();
  });
});
