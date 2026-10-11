import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { moveBlocks, EMPTY_DRAFT } from '../design/draft';
import { INITIAL_STATE, reduce, type OpenDocument, type StudioAction } from '../store/studioState';
import { aiBlocked } from './useAiDrawing';

const withSteps = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')],
}));

async function opened(doc = withSteps(), ...more: StudioAction[]): Promise<OpenDocument> {
  const d = await doc;
  const state = [{ type: 'open', workflowId: 'w', name: 'wf', version: '1.0.0' }, { type: 'loaded', workflowId: 'w', doc: d }, ...more]
    .reduce((s, a) => reduce(s, a as StudioAction), INITIAL_STATE);
  return state.docs[0]!;
}

describe('the AI button: only a valid saved workflow (the user\'s rule, 2026-10-11)', () => {
  it('draws a saved workflow with steps and no problems, whatever its run state', async () => {
    expect(aiBlocked(await opened())).toBeNull();
  });

  it('is off, with the reason, for a new workflow, unsaved changes, problems, a blank workflow, a Save in flight', async () => {
    expect(aiBlocked({ ...(await opened()), virtual: true })).toBe('Save the workflow first');
    const d = await withSteps();
    const moved = moveBlocks(EMPTY_DRAFT, d, new Map([['s2', { x: 2000, y: 800 }]]));
    expect(aiBlocked(await opened(Promise.resolve(d), { type: 'design', workflowId: 'w', draft: moved }))).toBe('Save your changes first');
    expect(aiBlocked({ ...(await opened()), errors: [{ kind: 'step', id: 's1', stage: 'steps', field: null, message: 'refused' }] })).toBe('Fix the problems in Output first');
    expect(aiBlocked(await opened(loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: [] }), steps: [] }))))).toBe('Nothing to draw');
    expect(aiBlocked({ ...(await opened()), saving: true })).toBe('Saving…');
    expect(aiBlocked({ ...(await opened()), status: { kind: 'loading' } })).toBe('The workflow is not loaded');
  });
});
