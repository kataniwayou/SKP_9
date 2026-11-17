import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bw } from '../board/fixtures';
import type { Pick } from '../board/picks';
import { createBoardStore } from '../design/boardStore';
import { setWorkflowField } from '../design/state';
import { createOutputStore } from '../output/outputStore';
import { LiveStoreProvider } from '../live/LiveContext';
import { liveStub } from '../test/liveStub';
import { InspectorPanel } from './InspectorPanel';

describe('InspectorPanel', () => {
  it('explains where a wire colour comes from', () => {
    const w = bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 2 }]);
    render(<InspectorPanel workflows={[w]} picks={[{ kind: 'wire', workflowId: 'w1', wireId: 'a>b' }]} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/The colour is the entry condition of b-name/)).toBeInTheDocument();
  });
  it('names the workflows sharing a step', () => {
    render(<InspectorPanel workflows={[bw('w1', ['s']), bw('w2', ['s'])]} picks={[{ kind: 'step', workflowId: 'w1', stepId: 's' }]} />);
    expect(screen.getByText(/shared · 2/)).toBeInTheDocument();
  });
  it('summarises the board when nothing is selected, counting running workflows', () => {
    const live = liveStub(); live.known(['w2']);
    render(<LiveStoreProvider value={live}><InspectorPanel workflows={[bw('w1', ['a']), bw('w2', ['a'])]} picks={[]} /></LiveStoreProvider>);
    expect(screen.getByText('Board: 2 workflows, 1 running')).toBeInTheDocument();
  });
  it('describes a workflow', () => {
    render(<InspectorPanel workflows={[bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 1 }])]} picks={[{ kind: 'workflow', workflowId: 'w1' }]} />);
    expect(screen.getByText('w1-name')).toBeInTheDocument();
    expect(screen.getByText('not scheduled')).toBeInTheDocument();
    expect(screen.getByText('Steps').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Wires').nextSibling).toHaveTextContent('1');
  });
  it('shows "none" and no liveness for a step whose processor id is empty', () => {
    const w = bw('w1', ['a']);
    w.graph.steps.set('a', { ...w.graph.steps.get('a')!, processorId: '' });
    render(<LiveStoreProvider value={liveStub()}><InspectorPanel workflows={[w]} picks={[{ kind: 'step', workflowId: 'w1', stepId: 'a' }]} /></LiveStoreProvider>);
    expect(screen.getByText('Processor').nextSibling).toHaveTextContent('none');
    expect(screen.queryByText('Liveness')).toBeNull();
  });
  it('describes a step with condition, processor, liveness and role', () => {
    const live = liveStub(); live.known([], { 'p-a': true });
    render(<LiveStoreProvider value={live}><InspectorPanel workflows={[bw('w1', ['a'])]} picks={[{ kind: 'step', workflowId: 'w1', stepId: 'a' }]} /></LiveStoreProvider>);
    expect(screen.getByText('A Always')).toBeInTheDocument();
    expect(screen.getByText('a-proc')).toBeInTheDocument();
    expect(screen.getByText(/live · 1 of 1 replica healthy/)).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.queryByText(/shared/)).toBeNull();
  });
  describe('several picks', () => {
    const wires = [{ id: 'a>b', from: 'a', to: 'b', condition: 1 }];
    it('counts the picks and lists one row per pick, in pick order', () => {
      const w = bw('w1', ['a', 'b'], wires);
      w.graph.workflow.cacheIds = ['c1'];
      w.graph.caches.set('c1', { id: 'c1', name: 'orders', version: '1', description: null, root: '', items: '{}', audit: w.graph.workflow.audit });
      render(<InspectorPanel workflows={[w]} picks={[
        { kind: 'cache', workflowId: 'w1', cacheId: 'c1' }, { kind: 'wire', workflowId: 'w1', wireId: 'a>b' },
        { kind: 'step', workflowId: 'w1', stepId: 'a' }, { kind: 'workflow', workflowId: 'w1' }]} />);
      expect(screen.getByText('4 selected')).toBeInTheDocument();
      expect([...document.querySelectorAll('.in-picks li')].map((li) => li.textContent)).toEqual(['orders', 'a-name → b-name', 'a-name', 'w1-name']);
    });
    it('lists three picks under "3 selected"', () => {
      render(<InspectorPanel workflows={[bw('w1', ['a', 'b'])]} picks={[
        { kind: 'step', workflowId: 'w1', stepId: 'b' }, { kind: 'step', workflowId: 'w1', stepId: 'a' }, { kind: 'workflow', workflowId: 'w1' }]} />);
      expect(screen.getByText('3 selected')).toBeInTheDocument();
      expect(document.querySelectorAll('.in-picks li')).toHaveLength(3);
    });
    it('Undo and Redo act on the workflow of the last pick', () => {
      const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
      store.load({ listed: true, workflows: [bw('w1', ['a']), bw('w2', ['a'])], failures: [] }, []);
      store.edit('w1', (s) => setWorkflowField(s, 'name', 'changed'));
      const p1 = { kind: 'workflow', workflowId: 'w1' } as const;
      const p2 = { kind: 'workflow', workflowId: 'w2' } as const;
      const view = (picks: Pick[]) => <LiveStoreProvider value={liveStub()}><InspectorPanel workflows={store.boards()} picks={picks} store={store} /></LiveStoreProvider>;
      const { rerender } = render(view([p1, p2]));
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
      rerender(view([p2, p1]));
      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(store.boards()[0]!.graph.workflow.name).toBe('w1-name');
    });
  });
});
