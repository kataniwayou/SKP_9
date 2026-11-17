import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bw } from '../board/fixtures';
import { LiveStoreProvider } from '../live/LiveContext';
import { liveStub } from '../test/liveStub';
import { InspectorPanel } from './InspectorPanel';

describe('InspectorPanel', () => {
  it('explains where a wire colour comes from', () => {
    const w = bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 2 }]);
    render(<InspectorPanel workflows={[w]} selection={{ kind: 'wire', workflowId: 'w1', wireId: 'a>b' }} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/The colour is the entry condition of b-name/)).toBeInTheDocument();
  });
  it('names the workflows sharing a step', () => {
    render(<InspectorPanel workflows={[bw('w1', ['s']), bw('w2', ['s'])]} selection={{ kind: 'step', workflowId: 'w1', stepId: 's' }} />);
    expect(screen.getByText(/shared · 2/)).toBeInTheDocument();
  });
  it('summarises the board when nothing is selected, counting running workflows', () => {
    const live = liveStub(); live.known(['w2']);
    render(<LiveStoreProvider value={live}><InspectorPanel workflows={[bw('w1', ['a']), bw('w2', ['a'])]} selection={null} /></LiveStoreProvider>);
    expect(screen.getByText('Board: 2 workflows, 1 running')).toBeInTheDocument();
  });
  it('describes a workflow', () => {
    render(<InspectorPanel workflows={[bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 1 }])]} selection={{ kind: 'workflow', workflowId: 'w1' }} />);
    expect(screen.getByText('w1-name')).toBeInTheDocument();
    expect(screen.getByText('not scheduled')).toBeInTheDocument();
    expect(screen.getByText('Steps').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Wires').nextSibling).toHaveTextContent('1');
  });
  it('describes a step with condition, processor, liveness and role', () => {
    const live = liveStub(); live.known([], { 'p-a': true });
    render(<LiveStoreProvider value={live}><InspectorPanel workflows={[bw('w1', ['a'])]} selection={{ kind: 'step', workflowId: 'w1', stepId: 'a' }} /></LiveStoreProvider>);
    expect(screen.getByText('A Always')).toBeInTheDocument();
    expect(screen.getByText('a-proc')).toBeInTheDocument();
    expect(screen.getByText(/live · 1 of 1 replica healthy/)).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.queryByText(/shared/)).toBeNull();
  });
});
