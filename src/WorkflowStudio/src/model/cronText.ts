/**
 * A workflow's cron expression in a few words, shown under the Inspector's Cron field (the user, 2026-10-11).
 *
 * The forms BaseApi accepts (CronFieldForm.cs, Cronos): six fields with seconds first, or the standard five, whose
 * seconds are 0. Each field is `*`, `?`, a number, a range `a-b`, a step `x/n`, or a list of those; months and days of
 * week may be names; the day of month may be `L`, `LW` or `nW`, the day of week `nL` or `n#k`. Anything else is named
 * as a problem. The wording is only read off the text: the server still judges the expression on save.
 */
export type CronText = { text: string } | { problem: string };

type Item =
  | { kind: 'all' }
  | { kind: 'value'; v: number }
  | { kind: 'range'; a: number; b: number }
  | { kind: 'step'; from: 'all' | number | [number, number]; n: number }
  | { kind: 'last' } | { kind: 'lastWeekday' } | { kind: 'nearestWeekday'; v: number }
  | { kind: 'lastOf'; v: number } | { kind: 'nth'; v: number; k: number };
type Field = Item[];

interface Unit { name: string; min: number; max: number; names?: readonly string[] }
const SECOND: Unit = { name: 'second', min: 0, max: 59 };
const MINUTE: Unit = { name: 'minute', min: 0, max: 59 };
const HOUR: Unit = { name: 'hour', min: 0, max: 23 };
const DAY: Unit = { name: 'day of month', min: 1, max: 31 };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const MONTH: Unit = { name: 'month', min: 1, max: 12, names: MONTHS };
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const WEEKDAY: Unit = { name: 'day of week', min: 0, max: 7, names: WEEKDAYS };

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

class CronProblem extends Error {}

export function cronText(expression: string): CronText {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 0) return { text: 'Not scheduled' };
  if (fields.length !== 5 && fields.length !== 6) {
    return { problem: `A cron expression has 5 fields, or 6 with seconds first; this has ${fields.length}` };
  }
  const [s, m, h, dom, mon, dow] = fields.length === 6 ? fields : ['0', ...fields];
  try {
    const S = parse(s!, SECOND), M = parse(m!, MINUTE), H = parse(h!, HOUR);
    const D = parse(dom!, DAY), MO = parse(mon!, MONTH), W = parse(dow!, WEEKDAY);
    return { text: [time(S, M, H), ...days(D, MO, W)].join(', ') };
  } catch (e) {
    if (e instanceof CronProblem) return { problem: e.message };
    throw e;
  }
}

// ---- reading -------------------------------------------------------------------------------------------------------

function parse(text: string, unit: Unit): Field {
  const unreadable = () => new CronProblem(`Cannot read the ${unit.name} field "${text}"`);
  const num = (t: string): number => {
    const named = unit.names?.indexOf(t.toUpperCase() as never) ?? -1;
    const v = named >= 0 ? named + (unit === MONTH ? 1 : 0) : /^\d+$/.test(t) ? Number(t) : NaN;
    if (Number.isNaN(v)) throw unreadable();
    if (v < unit.min || v > unit.max) {
      throw new CronProblem(`${cap(unit.name)} ${v} is out of range (${unit.min}–${unit.max})`);
    }
    return v;
  };
  const range = (t: string): [number, number] => {
    const [a, b, extra] = t.split('-');
    if (extra !== undefined || !a || !b) throw unreadable();
    const r: [number, number] = [num(a), num(b)];
    if (r[0] > r[1]) throw unreadable();
    return r;
  };
  return text.split(',').map((part): Item => {
    if (part === '') throw unreadable();
    if (part === '*' || (part === '?' && (unit === DAY || unit === WEEKDAY))) return { kind: 'all' };
    if (unit === DAY) {
      if (/^L$/i.test(part)) return { kind: 'last' };
      if (/^LW$/i.test(part)) return { kind: 'lastWeekday' };
      const w = /^(\d+)W$/i.exec(part);
      if (w) return { kind: 'nearestWeekday', v: num(w[1]!) };
    }
    if (unit === WEEKDAY) {
      const last = /^(\w+)L$/i.exec(part);
      if (last) return { kind: 'lastOf', v: num(last[1]!) % 7 };
      const nth = /^(\w+)#([1-5])$/.exec(part);
      if (nth) return { kind: 'nth', v: num(nth[1]!) % 7, k: Number(nth[2]) };
    }
    const slash = part.split('/');
    if (slash.length === 2) {
      const [from, by] = slash as [string, string];
      if (!/^\d+$/.test(by) || Number(by) === 0) throw unreadable();
      return { kind: 'step', n: Number(by), from: from === '*' ? 'all' : from.includes('-') ? range(from) : num(from) };
    }
    if (slash.length > 2) throw unreadable();
    if (part.includes('-')) { const [a, b] = range(part); return { kind: 'range', a, b }; }
    return { kind: 'value', v: unit === WEEKDAY ? num(part) % 7 : num(part) };
  });
}

// ---- wording -------------------------------------------------------------------------------------------------------

const isAll = (f: Field) => f.length === 1 && f[0]!.kind === 'all';
const single = (f: Field): number | null => (f.length === 1 && f[0]!.kind === 'value' ? f[0]!.v : null);
const everyN = (f: Field): number | null => {
  const i = f[0]!;
  return f.length === 1 && i.kind === 'step' && i.from === 'all' ? i.n : null;
};
const values = (f: Field): number[] | null => (f.every((i) => i.kind === 'value') ? f.map((i) => (i as { v: number }).v) : null);

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (h: number, m: number, s: number) => `${pad(h)}:${pad(m)}${s ? `:${pad(s)}` : ''}`;
const cap = (t: string) => t[0]!.toUpperCase() + t.slice(1);
const list = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const plural = (n: number, unit: string) => (n === 1 ? unit : `${n} ${unit}s`);

/** One field's items as words: "seconds 5 and 35", "hours 9 through 17", "every 3 months". */
function phrase(f: Field, unit: string, show: (v: number) => string = String): string {
  const vs = values(f);
  if (vs) return vs.length === 1 ? `${unit} ${show(vs[0]!)}` : `${unit}s ${list(vs.map(show))}`;
  return list(f.map((i) => {
    switch (i.kind) {
      case 'value': return `${unit} ${show(i.v)}`;
      case 'range': return `${unit}s ${show(i.a)} through ${show(i.b)}`;
      case 'step':
        if (i.from === 'all') return `every ${plural(i.n, unit)}`;
        if (typeof i.from === 'number') return `every ${plural(i.n, unit)} from ${unit} ${show(i.from)}`;
        return `every ${plural(i.n, unit)}, ${unit}s ${show(i.from[0])} through ${show(i.from[1])}`;
      default: return '';
    }
  }));
}

function time(S: Field, M: Field, H: Field): string {
  const s = single(S), m = single(M), h = single(H);
  if (s !== null && m !== null) {
    if (h !== null) return `At ${clock(h, m, s)}`;
    const hs = values(H);
    if (hs && hs.length <= 6) return `At ${list(hs.map((x) => clock(x, m, s)))}`;
    if (H.length === 1 && H[0]!.kind === 'range') return `Every hour from ${clock(H[0]!.a, m, s)} to ${clock(H[0]!.b, m, s)}`;
  }
  const hours = isAll(H) ? '' : everyN(H) !== null ? `every ${plural(everyN(H)!, 'hour')}` : `during ${phrase(H, 'hour')}`;
  const minutes = isAll(M) ? '' : everyN(M) !== null ? `every ${plural(everyN(M)!, 'minute')}` : `at ${phrase(M, 'minute')}`;
  const parts: string[] = [];
  if (s === null) {
    // the seconds vary: they lead
    if (isAll(S)) parts.push('Every second', minutes, hours);
    else if (everyN(S) !== null) parts.push(`Every ${plural(everyN(S)!, 'second')}`, minutes, hours);
    else if (isAll(M)) parts.push('Every minute', `at ${phrase(S, 'second')}`, hours);
    else parts.push(`At ${phrase(S, 'second')}`, minutes, hours);
  } else if (m === null) {
    // a fixed second, varying minutes
    const at = s ? `at second ${s}` : '';
    if (isAll(M)) parts.push('Every minute', at, hours);
    else if (everyN(M) !== null) parts.push(`Every ${plural(everyN(M)!, 'minute')}`, at, hours);
    else if (isAll(H)) parts.push('Every hour', `at ${phrase(M, 'minute')}`, at);
    else parts.push(`At ${phrase(M, 'minute')}`, at, hours);
  } else {
    // a fixed minute and second in varying hours
    const at = m || s ? `at minute ${m}${s ? `, second ${s}` : ''}` : '';
    if (isAll(H)) parts.push('Every hour', at);
    else if (everyN(H) !== null) parts.push(`Every ${plural(everyN(H)!, 'hour')}`, at);
    else parts.push(`At minute ${m}${s ? `, second ${s}` : ''}`, hours);
  }
  return parts.filter(Boolean).join(', ');
}

function days(D: Field, MO: Field, W: Field): string[] {
  const out: string[] = [];
  const ofMonth = isAll(MO) || single(MO) === null ? ' of the month' : '';
  if (!isAll(W)) {
    const ws = values(W);
    const weekly = W.length === 1 && W[0]!.kind === 'range'
      ? `${DAY_NAMES[W[0]!.a]} through ${DAY_NAMES[W[0]!.b]}`
      : ws ? `on ${list(ws.map((v) => DAY_NAMES[v]!))}`
      : list(W.map((i) => {
        switch (i.kind) {
          case 'lastOf': return `on the last ${DAY_NAMES[i.v]}${ofMonth}`;
          case 'nth': return `on the ${ORDINALS[i.k]} ${DAY_NAMES[i.v]}${ofMonth}`;
          default: return phrase([i], 'day of week', (v) => DAY_NAMES[v]!);
        }
      }));
    out.push(weekly);
  }
  if (!isAll(D)) {
    const ds = values(D);
    out.push(ds
      ? `on ${ds.length === 1 ? 'day' : 'days'} ${list(ds.map(String))}${ofMonth}`
      : list(D.map((i) => {
        switch (i.kind) {
          case 'last': return `on the last day${ofMonth}`;
          case 'lastWeekday': return `on the last weekday${ofMonth}`;
          case 'nearestWeekday': return `on the weekday nearest day ${i.v}${ofMonth}`;
          default: return `on ${phrase([i], 'day')}${ofMonth}`;
        }
      })));
  }
  if (!isAll(MO)) {
    const n = everyN(MO);
    out.push(n !== null ? `every ${plural(n, 'month')}` : `in ${phrase(MO, 'month', (v) => MONTH_NAMES[v - 1]!).replace(/^months? /, '')}`);
  }
  return out;
}
