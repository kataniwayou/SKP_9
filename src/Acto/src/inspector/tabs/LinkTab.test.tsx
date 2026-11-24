import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { openOn } from './testBoard';

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
  it("the Cron presets (Studio's) fill an entry arrow's cron field, which stays free text; Not scheduled clears it [user, 2026-11-23]", () => {
    const store = openOn('Link', [ENTRY]);
    const presets = screen.getByLabelText('Cron presets');
    expect([...presets.querySelectorAll('option:not([disabled])')].map((o) => o.textContent)).toEqual([
      'Every minute · 0 * * * * *', 'Every 5 minutes · 0 */5 * * * *', 'Every hour · 0 0 * * * *',
      'Every day at 00:00 · 0 0 0 * * *', 'Weekdays at 08:00 · 0 0 8 * * MON-FRI', 'Not scheduled',
    ]);
    fireEvent.change(presets, { target: { value: '4' } });
    expect(store.state().workflows.daily!.entryCrons).toEqual({ fetch: '0 0 8 * * MON-FRI' });
    expect(screen.getByLabelText('Cron')).toHaveValue('0 0 8 * * MON-FRI');
    expect((presets as HTMLSelectElement).value).toBe('');
    fireEvent.change(presets, { target: { value: '5' } });
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
  });
  it('aWireHasNoCronField', () => {
    openOn('Link', [{ kind: 'wire', from: 'fetch', to: 'expand' }]);
    expect(screen.queryByLabelText('Cron')).toBeNull();
  });
});
