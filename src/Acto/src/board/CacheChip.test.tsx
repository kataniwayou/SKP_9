import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LiveStoreProvider } from '../live/LiveContext';
import { liveStub } from '../test/liveStub';
import { Board } from './Board';
import { bw } from './fixtures';

describe('cache chips', () => {
  it('renders a linked cache in its frame and Delete unlinks it', async () => {
    const w = bw('w1', ['a']);
    w.graph.workflow.cacheIds = ['c1'];
    w.graph.caches.set('c1', { id: 'c1', name: 'orders', version: '1', description: null, root: '', items: '{}', audit: w.graph.workflow.audit });
    const deleteCache = vi.fn();
    const toolbar = { save: vi.fn(), deleteStep: vi.fn(), deleteWire: vi.fn(), deleteCache, status: () => ({ unsaved: false, problems: 0, saving: false }) };
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<LiveStoreProvider value={liveStub()}>
      <Board workflows={[w]} picks={[{ kind: 'cache', workflowId: 'w1', cacheId: 'c1' }]} onPick={() => {}} initialZoom={1} onEdit={onEdit} toolbar={toolbar} />
    </LiveStoreProvider>);
    expect(await screen.findByText('orders')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteCache).toHaveBeenCalledWith('w1', 'c1');
  });
});
