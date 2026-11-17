import { describe, expect, it } from 'vitest';
import { createOutputStore } from '../output/outputStore';
import type { LiveStore } from '../live/liveClient';
import type { WorkflowChange } from '../live/liveState';
import { watchTransitions } from './transitions';

function fakeLive() {
  const ls = new Set<(c: WorkflowChange[]) => void>();
  const live = { onWorkflowChange: (l: (c: WorkflowChange[]) => void) => { ls.add(l); return () => { ls.delete(l); }; } } as unknown as LiveStore;
  return { live, emit: (c: WorkflowChange[]) => ls.forEach((l) => l(c)) };
}

describe('watchTransitions', () => {
  it('logs running and stopped, and stops when unsubscribed', () => {
    const { live, emit } = fakeLive(); const o = createOutputStore(null);
    const off = watchTransitions(live, o, (id) => (id === 'w1' ? 'orders' : null));
    emit([{ workflowId: 'w1', running: true }]);
    emit([{ workflowId: 'w1', running: false }]);
    expect(o.lines().map((l) => [l.level, l.text])).toEqual([['ok', 'orders is running'], ['info', 'orders stopped']]);
    off(); emit([{ workflowId: 'w1', running: true }]);
    expect(o.lines()).toHaveLength(2);
  });
});
