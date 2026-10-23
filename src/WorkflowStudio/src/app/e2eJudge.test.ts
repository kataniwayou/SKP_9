import { describe, expect, it } from 'vitest';
import { graphDto, processorDto, stepDto, workflowDto } from '../api/fixtures';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { installE2eJudge, judgeOf, type Judgement } from './e2eJudge';

async function store() {
  const s = createStudioStore();
  s.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  s.dispatch({
    type: 'loaded', workflowId: 'wf1',
    doc: await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { name: 'a', processorId: 'p1', nextStepIds: ['s2'] }), stepDto('s2', { name: 'b', processorId: 'p1' })],
      processors: [processorDto('p1', { name: 'fetcher' })],
    })),
  });
  return s;
}

describe('judgeOf', () => {
  it('reads the design by step names: links, processors, no shorts', async () => {
    const s = await store();
    const j = judgeOf(s.getState().docs[0]!)!;
    expect(j.links).toEqual(['a -> b', 'workflow -> a']);
    expect(j.steps.map((x) => [x.name, x.processor, x.entryCondition])).toEqual([['a', 'fetcher', 'Completed'], ['b', 'fetcher', 'Completed']]);
    expect(j.shorts).toEqual([]);
    expect(j.junctions).toBe(0);
  });

  it('is installed on the window in development, judging the active document', async () => {
    const s = await store();
    const win = { location: { search: '' } } as unknown as Window;
    installE2eJudge(s, win);
    expect((win as unknown as { __studioJudge(): Judgement }).__studioJudge().workflow).toBe('orders 1.0.0');
  });
});
