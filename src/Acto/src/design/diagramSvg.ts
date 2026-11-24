import { conditionInfo, CONDITIONS } from '../model/entryConditions';
import type { Id } from '../model/graph';
import { reachOf, type BoardState } from './board';

const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "Consolas, 'Courier New', monospace";
const PAD = 32;
const TITLE_H = 44;
const LEGEND_H = 44;
const TRI_W = 64;
const TRI_H = 56;
const BADGE_W = 128;
const BADGE_H = 44;
const BADGE_GAP = 10;
const BOX_W = 250;
const CACHE_W = 220;
const HEAD_H = 34;
const ROW_H = 20;
const BOX_PAD = 10;
const MAX_ROWS = 12;
const GAP = 24;
const TRI_STROKE = '#4F46E5';
const CACHE_STROKE = '#64748B';
const MASK = '••••••';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);
const num = (n: number) => Math.round(n * 10) / 10;

interface Box { x: number; y: number; w: number; h: number }
export interface Row { key: string; value: string; masked?: boolean }

/** A setting whose key names a secret is never drawn: the picture goes to Kibana [user, 2026-11-22]. */
const SECRET = /pass(word|wd)?|secret|token|api[-_]?key|credential|private[-_]?key/i;

/** A JSON payload as key/value rows: nested objects flattened with dots, arrays as compact JSON, secrets masked. */
export function settingRows(payload: string): Row[] {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return payload.trim() ? [{ key: 'payload', value: payload.trim() }] : [];
  }
  const rows: Row[] = [];
  const walk = (val: unknown, key: string) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, x] of Object.entries(val)) walk(x, key ? `${key}.${k}` : k);
      return;
    }
    const text = typeof val === 'string' ? val : JSON.stringify(val);
    if (SECRET.test(key)) rows.push({ key, value: MASK, masked: true });
    else rows.push({ key: key || 'value', value: text });
  };
  walk(v, '');
  return rows;
}

const two = (n: string) => n.padStart(2, '0');
const isNum = (f: string) => /^\d+$/.test(f);
const any = (f: string) => f === '*' || f === '?';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A plain reading of the common cron shapes (5 fields, or 6 with seconds first); null when it is not one of them. */
export function cronText(expr: string): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5 && f.length !== 6) return null;
  const [sec, min, hour, dom, mon, dow] = f.length === 6 ? f : ['0', ...f];
  const at = () => `${two(hour!)}:${two(min!)}:${two(sec!)}`;
  if (!any(mon!) || !any(dom!)) return null;
  if (!any(dow!)) {
    if (!/^\d(,\d)*$/.test(dow!) || !isNum(sec!) || !isNum(min!) || !isNum(hour!)) return null;
    return `weekly on ${dow!.split(',').map((d) => DAYS[Number(d)] ?? d).join(', ')} at ${at()}`;
  }
  if (isNum(sec!) && isNum(min!) && isNum(hour!)) return `daily at ${at()}`;
  if (isNum(sec!) && isNum(min!) && hour === '*') return `hourly at :${two(min!)}:${two(sec!)}`;
  const every = (g: string) => /^\*\/(\d+)$/.exec(g)?.[1];
  if (isNum(sec!) && isNum(min!) && every(hour!)) return `every ${every(hour!)} hours at :${two(min!)}`;
  if (isNum(sec!) && every(min!) && hour === '*') return `every ${every(min!)} minutes`;
  if (isNum(sec!) && min === '*' && hour === '*') return 'every minute';
  if (every(sec!) && min === '*' && hour === '*') return `every ${every(sec!)} seconds`;
  return null;
}

/** "2026-11-22 14:05", local time, from BaseAPI's stamp; null when it has none. */
function stamp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const boxH = (rows: number) => HEAD_H + Math.max(1, rows) * ROW_H + BOX_PAD;
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

/**
 * One standalone SVG of a workflow for its Kibana tab [user, 2026-11-22], in Acto's look on white: the name, version,
 * save time and counts; the triangle with its cron (and a plain reading of it) under it; each step it reaches with this
 * workflow's settings as key/value rows (secrets masked); its caches with root and item count on dashed lines; the wires
 * (colour and letter from the target's entry condition) at the box headers; the legend below. Boxes keep their board
 * places; a box grown by its rows pushes the ones under it down so nothing overlaps.
 */
export function diagramSvg(b: BoardState, workflowId: Id): string {
  const wf = b.workflows[workflowId];
  const title = wf?.name ?? workflowId;
  const stepIds = [...reachOf(b, workflowId)].filter((id) => b.steps[id]);
  const cacheIds = (wf?.cacheIds ?? []).filter((id) => b.caches[id]);

  // this workflow's settings per step: its own assignment rows on that step
  const mine = (wf?.assignmentIds ?? []).map((id) => b.assignments[id]).filter((a) => !!a);
  const rowsOf = new Map(stepIds.map((id) => [id, mine.filter((a) => a.stepId === id).flatMap((a) => settingRows(a.payload))]));
  const shown = (rows: Row[]) => (rows.length > MAX_ROWS ? MAX_ROWS : rows.length);
  const cacheItems = (items: string) => {
    try {
      const v = JSON.parse(items);
      return v && typeof v === 'object' ? Object.keys(v).length : 0;
    } catch {
      return 0;
    }
  };

  // places, raw board coordinates; a row with no place is put in a row below the others
  let spare = 0;
  const place = (at: { x: number; y: number } | null | undefined, w: number, h: number): Box => {
    if (at) return { x: at.x, y: at.y, w, h };
    return { x: spare++ * (w + 40), y: 0, w, h };
  };
  // the triangle and its cron badge are one block
  const triAt = place(wf?.at, TRI_W, TRI_H);
  const tb: Box = { x: triAt.x + TRI_W / 2 - BADGE_W / 2, y: triAt.y, w: BADGE_W, h: TRI_H + BADGE_GAP + BADGE_H };
  const steps = new Map(stepIds.map((id) => {
    const rows = rowsOf.get(id)!;
    return [id, place(b.steps[id]!.at, BOX_W, boxH(shown(rows) + (rows.length > MAX_ROWS ? 1 : 0)))];
  }));
  const caches = new Map(cacheIds.map((id) => [id, place(b.caches[id]!.at, CACHE_W, boxH(2))]));

  // a box taller than on the board pushes the boxes under it down, top to bottom
  const placed: Box[] = [tb];
  for (const r of [...steps.values(), ...caches.values()].sort((a, c) => a.y - c.y || a.x - c.x)) {
    for (let moved = true; moved;) {
      moved = false;
      for (const o of placed) {
        if (overlaps(r, o)) {
          r.y = o.y + o.h + GAP;
          moved = true;
        }
      }
    }
    placed.push(r);
  }

  const all = placed;
  const minX = Math.min(...all.map((r) => r.x));
  const minY = Math.min(...all.map((r) => r.y));
  const maxX = Math.max(...all.map((r) => r.x + r.w));
  const maxY = Math.max(...all.map((r) => r.y + r.h));
  // normalised into the viewBox: the picture starts at (PAD, PAD + title)
  const ox = PAD - minX;
  const oy = PAD + TITLE_H - minY;
  const shift = (r: Box): Box => ({ x: r.x + ox, y: r.y + oy, w: r.w, h: r.h });
  const T: Box = { x: triAt.x + ox, y: triAt.y + oy, w: TRI_W, h: TRI_H };
  const B: Box = { x: tb.x + ox, y: T.y + TRI_H + BADGE_GAP, w: BADGE_W, h: BADGE_H };
  const S = new Map([...steps].map(([id, r]) => [id, shift(r)]));
  const C = new Map([...caches].map(([id, r]) => [id, shift(r)]));

  const meta = [
    wf ? `v${wf.version}` : null,
    stamp(wf?.updatedAt ?? null) ? `saved ${stamp(wf!.updatedAt)}` : null,
    `${stepIds.length} step${stepIds.length === 1 ? '' : 's'}`,
    `${cacheIds.length} cache${cacheIds.length === 1 ? '' : 's'}`,
  ].filter((s) => s !== null).join(' · ');
  const titleW = 22 * 0.62 * title.length + 16 + meta.length * 7;
  const legendW = CONDITIONS.reduce((n, c) => n + 30 + c.name.length * 7 + 12, 0) + 90;
  const w = Math.max(maxX - minX, legendW, titleW, 360) + 2 * PAD;
  const contentBottom = PAD + TITLE_H + (maxY - minY);
  const h = contentBottom + LEGEND_H + PAD;

  const out: string[] = [];
  const titleX = PAD + 22 * 0.62 * title.length + 16;
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}" font-family="${FONT}">`,
    `<rect x="0" y="0" width="${num(w)}" height="${num(h)}" fill="#FFFFFF"/>`,
    `<text x="${PAD}" y="${PAD + 8}" font-size="22" font-weight="700" fill="#0F172A">${esc(title)}</text>`,
    `<text x="${num(titleX)}" y="${PAD + 8}" font-size="14" fill="#64748B">${esc(meta)}</text>`,
  );

  const arrowDefs = new Set<string>();
  const arrow = (colour: string): string => {
    const id = `arrow-${colour.replace('#', '')}`;
    if (!arrowDefs.has(id)) {
      arrowDefs.add(id);
      out.push(`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${colour}"/></marker>`);
    }
    return id;
  };
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${num(x1)} ${num(y1)} C ${num(x1 + dx)} ${num(y1)}, ${num(x2 - dx)} ${num(y2)}, ${num(x2)} ${num(y2)}`;
  };
  const pill = (x: number, y: number, colour: string, letter: string) => {
    out.push(
      `<circle cx="${num(x)}" cy="${num(y)}" r="8" fill="${colour}"/>`,
      `<text x="${num(x)}" y="${num(y)}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="700" fill="#FFFFFF">${esc(letter)}</text>`,
    );
  };

  // cache lines first: from under the cron badge to a cache below, else from the triangle's back
  for (const [, c] of C) {
    const below = c.y >= B.y + B.h;
    const [x1, y1] = below ? [B.x + B.w / 2, B.y + B.h] : [T.x, T.y + T.h / 2];
    const [x2, y2] = [c.x + c.w / 2, below ? c.y : c.y + c.h];
    const mid = (y1 + y2) / 2;
    const d = below
      ? `M ${num(x1)} ${num(y1)} C ${num(x1)} ${num(mid)}, ${num(x2)} ${num(mid)}, ${num(x2)} ${num(y2)}`
      : curve(x1, y1, x2, y2);
    out.push(`<path d="${d}" stroke="${CACHE_STROKE}" stroke-width="1.6" stroke-dasharray="6 5" fill="none"/>`);
  }

  // entry arrows from the tip, and wires between reached steps, at the middle of the box headers
  const wireOf = (from: { x: number; y: number }, to: Box, cond: number) => {
    const info = conditionInfo(cond);
    const m = arrow(info.colour);
    const x2 = to.x;
    const y2 = to.y + HEAD_H / 2;
    out.push(`<path d="${curve(from.x, from.y, x2, y2)}" stroke="${info.colour}" stroke-width="2.2" fill="none" marker-end="url(#${m})"/>`);
    pill((from.x + x2) / 2, (from.y + y2) / 2, info.colour, info.letter);
  };
  for (const id of wf?.entryStepIds ?? []) {
    const to = S.get(id);
    if (to) wireOf({ x: T.x + T.w, y: T.y + T.h / 2 }, to, b.steps[id]!.entryCondition);
  }
  for (const id of stepIds) {
    const from = S.get(id)!;
    for (const next of b.steps[id]!.nextStepIds) {
      const to = S.get(next);
      if (to) wireOf({ x: from.x + from.w, y: from.y + HEAD_H / 2 }, to, b.steps[next]!.entryCondition);
    }
  }

  // the triangle and its cron badge
  const cron: string | null = null; // Task 4 draws the entry crons here; a workflow has none of its own
  const reading = cron ? cronText(cron) : null;
  out.push(
    `<polygon points="${num(T.x)},${num(T.y)} ${num(T.x)},${num(T.y + T.h)} ${num(T.x + T.w)},${num(T.y + T.h / 2)}" fill="#EEF2FF" stroke="${TRI_STROKE}" stroke-width="2" stroke-linejoin="round"/>`,
    `<g data-part="cron">`,
    `<rect x="${num(B.x)}" y="${num(B.y)}" width="${B.w}" height="${B.h}" rx="8" ry="8" fill="#EEF2FF" stroke="#C7D2FE"/>`,
  );
  if (cron) {
    out.push(
      `<text x="${num(B.x + B.w / 2)}" y="${num(B.y + (reading ? 17 : B.h / 2))}" text-anchor="middle" dominant-baseline="central" font-size="13" font-weight="600" font-family="${MONO}" fill="#3730A3">${esc(clip(cron, 17))}</text>`,
    );
    if (reading) out.push(`<text x="${num(B.x + B.w / 2)}" y="${num(B.y + 34)}" text-anchor="middle" dominant-baseline="central" font-size="11" fill="#6366F1">${esc(clip(reading, 22))}</text>`);
  } else {
    out.push(`<text x="${num(B.x + B.w / 2)}" y="${num(B.y + B.h / 2)}" text-anchor="middle" dominant-baseline="central" font-size="12" font-style="italic" fill="#6366F1">manual start</text>`);
  }
  out.push('</g>');

  // a box: name header, a rule, then key/value rows (key left, value right in mono, both clipped to fit)
  const box = (p: Box, name: string, rows: Row[], fill: string, stroke: string, part: string, more = 0) => {
    out.push(
      `<g data-part="${part}">`,
      `<rect x="${num(p.x)}" y="${num(p.y)}" width="${p.w}" height="${p.h}" rx="8" ry="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`,
      `<text x="${num(p.x + 14)}" y="${num(p.y + HEAD_H / 2)}" dominant-baseline="central" font-size="14" font-weight="600" fill="#0F172A">${esc(clip(name, Math.floor((p.w - 28) / 7.6)))}</text>`,
      `<line x1="${num(p.x)}" y1="${num(p.y + HEAD_H)}" x2="${num(p.x + p.w)}" y2="${num(p.y + HEAD_H)}" stroke="#E2E8F0"/>`,
    );
    const inner = p.w - 28;
    rows.forEach((r, i) => {
      const y = p.y + HEAD_H + ROW_H * i + ROW_H / 2 + 4;
      // about 7px a character; the key keeps what the value does not need, and never less than 8 characters
      const total = Math.floor(inner / 7) - 2;
      const keyN = Math.min(r.key.length, Math.max(8, total - r.value.length));
      const valN = Math.max(4, total - keyN);
      out.push(
        `<text x="${num(p.x + 14)}" y="${num(y)}" dominant-baseline="central" font-size="12" fill="#64748B">${esc(clip(r.key, keyN))}</text>`,
        `<text x="${num(p.x + p.w - 14)}" y="${num(y)}" text-anchor="end" dominant-baseline="central" font-size="12" font-family="${MONO}" fill="${r.masked ? '#94A3B8' : '#0F172A'}">${esc(clip(r.value, valN))}</text>`,
      );
    });
    if (more > 0) {
      const y = p.y + HEAD_H + ROW_H * rows.length + ROW_H / 2 + 4;
      out.push(`<text x="${num(p.x + 14)}" y="${num(y)}" dominant-baseline="central" font-size="12" font-style="italic" fill="#94A3B8">+${more} more</text>`);
    }
    if (rows.length === 0 && more === 0) {
      out.push(`<text x="${num(p.x + 14)}" y="${num(p.y + HEAD_H + ROW_H / 2 + 4)}" dominant-baseline="central" font-size="12" font-style="italic" fill="#94A3B8">no settings</text>`);
    }
    out.push('</g>');
  };

  for (const id of stepIds) {
    const rows = rowsOf.get(id)!;
    box(S.get(id)!, b.steps[id]!.name, rows.slice(0, MAX_ROWS), '#FFFFFF', '#CBD5E1', 'step', Math.max(0, rows.length - MAX_ROWS));
  }
  for (const [id, c] of C) {
    const cache = b.caches[id]!;
    box(c, cache.name, [{ key: 'root', value: cache.root }, { key: 'items', value: String(cacheItems(cache.items)) }], '#F8FAFC', CACHE_STROKE, 'cache');
  }

  // legend below: the five conditions and the cache line
  const ly = contentBottom + 22;
  let lx = PAD;
  for (const c of CONDITIONS) {
    pill(lx + 8, ly, c.colour, c.letter);
    out.push(`<text x="${num(lx + 22)}" y="${num(ly)}" dominant-baseline="central" font-size="12" fill="#334155">${esc(c.name)}</text>`);
    lx += 30 + c.name.length * 7 + 12;
  }
  out.push(
    `<line x1="${num(lx)}" y1="${num(ly)}" x2="${num(lx + 30)}" y2="${num(ly)}" stroke="${CACHE_STROKE}" stroke-width="1.6" stroke-dasharray="6 5"/>`,
    `<text x="${num(lx + 38)}" y="${num(ly)}" dominant-baseline="central" font-size="12" fill="#334155">cache</text>`,
  );
  out.push('</svg>');
  return out.join('\n');
}
