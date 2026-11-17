import { render } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { bw } from '../fixtures';
import type { BoardWorkflow } from '../loadBoard';
import { BoardContext } from './boardContext';
import { WorkflowFrame } from './WorkflowFrame';

const frame = (byId: ReadonlyMap<string, BoardWorkflow>) => (
  <ReactFlowProvider>
    <BoardContext.Provider value={byId}>
      <WorkflowFrame {...({ id: 'wf:w1', data: { workflowId: 'w1' }, selected: false } as unknown as NodeProps)} />
    </BoardContext.Provider>
  </ReactFlowProvider>
);

describe('WorkflowFrame', () => {
  it('renders nothing, without throwing, once its workflow is gone', () => {
    const { container, rerender } = render(frame(new Map([['w1', bw('w1', ['a'])]])));
    expect(container.querySelector('.frame')).not.toBeNull();
    expect(() => rerender(frame(new Map()))).not.toThrow();
    expect(container.querySelector('.frame')).toBeNull();
  });
});
