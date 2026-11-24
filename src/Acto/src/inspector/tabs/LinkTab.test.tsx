import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { openOn, withSchemas } from './testBoard';

afterEach(() => sessionStorage.clear());

const ENTRY = { kind: 'entry' as const, workflowId: 'daily', stepId: 'fetch' };

describe('the Link tab', () => {
  it('anEntryArrowEditsItsCron', () => {
    const store = openOn('Link', [ENTRY]);
    expect(screen.getByLabelText('Cron')).toHaveProperty('placeholder', 'not scheduled');
    fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '*/10 * * * * *' } });
    expect(store.state().workflows.daily!.entryCrons).toEqual({ fetch: '*/10 * * * * *' });
    expect(store.state().workflows.hourly!.entryCrons).toEqual({});
    expect(screen.getByText(/10 seconds/i)).toBeTruthy();
    act(() => store.undo());
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
    expect(store.canUndo()).toBe(false);
  });
  it('aWireHasNoCronField', () => {
    openOn('Link', [{ kind: 'wire', from: 'fetch', to: 'expand' }]);
    expect(screen.queryByLabelText('Cron')).toBeNull();
  });
  it('the workflow tab shows an entry row with its own cron', () => {
    const b = withSchemas();
    openOn('Workflow', [{ kind: 'workflow', id: 'daily' }], { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryCrons: { fetch: '*/10 * * * * *' } } } });
    expect(screen.getByText('⏱ */10 * * * * *')).toBeTruthy();
  });
});
