import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { openOn, withSchemas } from './testBoard';

afterEach(() => { cleanup(); sessionStorage.clear(); });

const twoEntries = () => {
  const b = withSchemas();
  return { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: ['fetch', 'expand'] } } };
};
const WF = [{ kind: 'workflow' as const, id: 'daily' }];
const row = (sid: string) => screen.getByTestId(`schedule:${sid}`);

describe('the Workflow tab schedules', () => {
  it('theSchedulesSectionEditsEachEntrysCron', () => {
    const store = openOn('Workflow', WF, twoEntries());
    expect(within(row('fetch')).getByLabelText('Cron')).toHaveProperty('placeholder', 'not scheduled');
    fireEvent.change(within(row('expand')).getByLabelText('Cron'), { target: { value: '*/10 * * * * *' } });
    expect(store.state().workflows.daily!.entryCrons).toEqual({ expand: '*/10 * * * * *' });
    expect(within(row('expand')).getByText(/10 seconds/i)).toBeTruthy();
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent('⏱ */10 * * * * *');
    expect(within(row('fetch')).queryByText(/seconds/i)).toBeNull();
    act(() => store.undo());
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
    expect(store.canUndo()).toBe(false);
  });
  it('the Schedules rows follow the entry order and have presets', () => {
    openOn('Workflow', WF, twoEntries());
    const ids = [...document.querySelectorAll('[data-testid^="schedule:"]')].map((e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['schedule:fetch', 'schedule:expand']);
    expect(within(row('fetch')).getByLabelText('Cron presets')).toBeTruthy();
  });
  it('schedule edits of one arrow merge into one undo step, under the key the Link tab uses', () => {
    const b = twoEntries();
    const store = openOn('Workflow', WF, b);
    fireEvent.change(within(row('fetch')).getByLabelText('Cron'), { target: { value: '0 * * * * *' } });
    fireEvent.change(within(row('fetch')).getByLabelText('Cron'), { target: { value: '0 0 * * * *' } });
    // the same merge key as the Link tab: both edits are one undo step
    act(() => store.undo());
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
    expect(store.canUndo()).toBe(false);
  });
  it('a Link-tab edit of the same arrow reads back in the Schedules section', () => {
    const b = twoEntries();
    const bb = { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryCrons: { fetch: '0 0 * * * *' } } } };
    openOn('Workflow', WF, bb);
    expect(within(row('fetch')).getByLabelText('Cron')).toHaveValue('0 0 * * * *');
    expect(within(row('expand')).getByLabelText('Cron')).toHaveValue('');
  });
  it('aWorkflowWithoutEntriesExplainsHowToSchedule', () => {
    const b = withSchemas();
    openOn('Workflow', WF, { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: [] } } });
    expect(screen.getByText('No entry steps — draw an entry arrow to schedule this workflow.')).toBeTruthy();
    expect(screen.queryByLabelText('Cron')).toBeNull();
  });
});
