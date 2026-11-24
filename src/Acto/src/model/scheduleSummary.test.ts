import { describe, expect, it } from 'vitest';
import { board } from '../design/boardFixtures';
import { scheduleSummary } from './scheduleSummary';

const wf = (entryCrons: Record<string, string>) => ({ ...board().workflows.daily!, entryCrons });

describe('scheduleSummary', () => {
  it('one cron reads as itself', () => expect(scheduleSummary(wf({ a: '*/10 * * * * *' }))).toBe('⏱ */10 * * * * *'));
  it('two different crons read as a count', () => expect(scheduleSummary(wf({ a: '0 * * * * *', b: '*/10 * * * * *' }))).toBe('⏱ 2 schedules'));
  it('no cron reads as not scheduled', () => expect(scheduleSummary(wf({}))).toBe('⏱ not scheduled'));
  it('chipShowsTheSharedCronWhenUnscheduledEntriesAreIgnored', () => {
    expect(scheduleSummary(wf({ a: '0 * * * * *', b: '  ', c: '0 * * * * *' }))).toBe('⏱ 0 * * * * *');
  });
  it('whitespace variants count as one cron', () => {
    expect(scheduleSummary(wf({ a: '0 * * * * *', b: ' 0  *  * * * *\t' }))).toBe('⏱ 0 * * * * *');
  });
});
