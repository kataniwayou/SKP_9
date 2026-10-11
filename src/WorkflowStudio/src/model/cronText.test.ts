import { describe, expect, it } from 'vitest';
import { cronText } from './cronText';

const text = (expr: string) => {
  const r = cronText(expr);
  if ('problem' in r) throw new Error(`expected a wording for "${expr}", got the problem "${r.problem}"`);
  return r.text;
};
const problem = (expr: string) => {
  const r = cronText(expr);
  if (!('problem' in r)) throw new Error(`expected a problem for "${expr}", got "${r.text}"`);
  return r.problem;
};

describe('cronText: a cron expression in a few words (the user, 2026-10-11)', () => {
  it('reads the live workflows\' six-field (seconds first) schedules', () => {
    expect(text('0 * * * * *')).toBe('Every minute');
    expect(text('*/30 * * * * *')).toBe('Every 30 seconds');
    expect(text('5,35 * * * * *')).toBe('Every minute, at seconds 5 and 35');
    expect(text('* * * * * *')).toBe('Every second');
    expect(text('15 */5 * * * *')).toBe('Every 5 minutes, at second 15');
    expect(text('*/10 * 9-17 * * *')).toBe('Every 10 seconds, during hours 9 through 17');
  });

  it('reads the standard five fields, seconds then being 0', () => {
    expect(text('* * * * *')).toBe('Every minute');
    expect(text('*/5 * * * *')).toBe('Every 5 minutes');
    expect(text('15 * * * *')).toBe('Every hour, at minute 15');
    expect(text('0 * * * *')).toBe('Every hour');
    expect(text('0 */2 * * *')).toBe('Every 2 hours');
    expect(text('0,30 * * * *')).toBe('Every hour, at minutes 0 and 30');
  });

  it('says a time of day as a clock time', () => {
    expect(text('0 0 * * *')).toBe('At 00:00');
    expect(text('30 9 * * *')).toBe('At 09:30');
    expect(text('0 9,17 * * *')).toBe('At 09:00 and 17:00');
    expect(text('0 9-17 * * *')).toBe('Every hour from 09:00 to 17:00');
    expect(text('45 30 6 * * *')).toBe('At 06:30:45');
  });

  it('adds the days and months', () => {
    expect(text('30 9 * * 1-5')).toBe('At 09:30, Monday through Friday');
    expect(text('0 0 1 * *')).toBe('At 00:00, on day 1 of the month');
    expect(text('0 0 1,15 * *')).toBe('At 00:00, on days 1 and 15 of the month');
    expect(text('0 0 L * *')).toBe('At 00:00, on the last day of the month');
    expect(text('0 0 15W * *')).toBe('At 00:00, on the weekday nearest day 15 of the month');
    expect(text('0 12 * JAN,JUL MON')).toBe('At 12:00, on Monday, in January and July');
    expect(text('0 0 * * 5L')).toBe('At 00:00, on the last Friday of the month');
    expect(text('0 0 * * MON#2')).toBe('At 00:00, on the second Monday of the month');
    expect(text('0 0 * * 0')).toBe('At 00:00, on Sunday');
    expect(text('0 0 * * 7')).toBe('At 00:00, on Sunday');
    expect(text('0 0 ? * sun')).toBe('At 00:00, on Sunday');
    expect(text('0 0 1 */3 *')).toBe('At 00:00, on day 1 of the month, every 3 months');
  });

  it('is calm about spacing', () => {
    expect(text('  */30   * * * * * ')).toBe('Every 30 seconds');
  });

  it('says nothing is scheduled for a blank field', () => {
    expect(text('')).toBe('Not scheduled');
    expect(text('   ')).toBe('Not scheduled');
  });

  it('names what is wrong with an expression it cannot read', () => {
    expect(problem('* * *')).toBe('A cron expression has 5 fields, or 6 with seconds first; this has 3');
    expect(problem('0 75 * * * *')).toBe('Minute 75 is out of range (0–59)');
    expect(problem('0 25 * * *')).toBe('Hour 25 is out of range (0–23)');
    expect(problem('abc * * * *')).toBe('Cannot read the minute field "abc"');
    expect(problem('*/0 * * * *')).toBe('Cannot read the minute field "*/0"');
    expect(problem('0 0 * * 9-3')).toBe('Day of week 9 is out of range (0–7)');
    expect(problem('0 0 * * 5-1')).toBe('Cannot read the day of week field "5-1"');
  });
});
