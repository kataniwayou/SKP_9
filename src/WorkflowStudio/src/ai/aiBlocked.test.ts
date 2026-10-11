import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { moveBlocks, EMPTY_DRAFT } from '../design/draft';
import { canSave, designLocked, hasChanges, INITIAL_STATE, reduce, saveBlocked, type OpenDocument, type StudioAction } from '../store/studioState';
import { AI_DRAWING, runBlocked } from '../store/run';
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

describe('while the AI draws, its document is locked (the user’s rule, 2026-10-11)', () => {
  it('refuses every design change, Undo and Redo; selecting still works; the lock lifts when the drawing ends', async () => {
    const d = await withSteps();
    const moved = moveBlocks(EMPTY_DRAFT, d, new Map([['s2', { x: 2000, y: 800 }]]));
    const states = [{ type: 'open', workflowId: 'w', name: 'wf', version: '1.0.0' }, { type: 'loaded', workflowId: 'w', doc: d },
      { type: 'design', workflowId: 'w', draft: moved }, { type: 'drawing', workflowId: 'w', on: true }] as StudioAction[];
    const locked = states.reduce(reduce, INITIAL_STATE);
    const doc = locked.docs[0]!;
    expect(designLocked(doc)).toBe(true);
    for (const a of [
      { type: 'design', workflowId: 'w', draft: EMPTY_DRAFT }, { type: 'undo', workflowId: 'w' }, { type: 'redo', workflowId: 'w' },
      { type: 'discardDesign', workflowId: 'w' }, { type: 'deletePicks', workflowId: 'w' },
      { type: 'createAssignment', workflowId: 'w', stepId: 's1', stepName: 's1', id: 'a1' },
    ] as StudioAction[]) expect(reduce(locked, a).docs[0]).toBe(doc);
    // navigation: a selection still lands, and the Inspector follows it
    const selected = reduce(locked, { type: 'select', workflowId: 'w', selection: { kind: 'step', stepId: 's1' } });
    expect(selected.docs[0]!.selection).toEqual({ kind: 'step', stepId: 's1' });
    // Save, Start and Stop wait
    expect(canSave(doc)).toBe(false);
    expect(runBlocked(doc)).toBe(AI_DRAWING);
    // the drawing ended: Undo works again
    const free = reduce(locked, { type: 'drawing', workflowId: 'w', on: false });
    expect(designLocked(free.docs[0]!)).toBe(false);
    expect(reduce(free, { type: 'undo', workflowId: 'w' }).docs[0]!.design.draft).not.toBe(doc.design.draft);
  });
});

describe('Save is always offered once loaded and idle; otherwise it says why (the user\'s rule, 2026-10-11)', () => {
  it('names what stops it', async () => {
    const d = await opened();
    expect(saveBlocked(d)).toBeNull();
    expect(hasChanges(d)).toBe(false);
    expect(saveBlocked({ ...d, saving: true })).toBe('Saving…');
    expect(saveBlocked({ ...d, drawing: true })).toBe(AI_DRAWING);
    expect(saveBlocked({ ...d, status: { kind: 'loading' } })).toBe('The workflow is still loading');
    expect(saveBlocked({ ...d, status: { kind: 'failed', message: 'x' } })).toBe('The workflow could not be loaded');
  });
});
