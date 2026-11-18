import { STEP_H, STEP_W } from '../board/geometry';
import { conditionInfo, CONDITIONS } from '../model/entryConditions';
import type { Id } from '../model/graph';
import { reachOf, type BoardState } from './board';

const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const PAD = 32;
const TITLE_H = 44;
const LEGEND_H = 44;
const TRI_W = 64;
const TRI_H = 56;
const CACHE_W = 150;
const CACHE_H = 56;
const TRI_STROKE = '#4F46E5';
const CACHE_STROKE = '#64748B';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (n: number) => Math.round(n * 10) / 10;

interface Box { x: number; y: number; w: number; h: number }

/**
 * One standalone SVG of a workflow's triangle in Acto's look, on white: the triangle with an arrow from its tip to each
 * entry step, the steps it reaches and their wires (colour and letter from the target's entry condition), its caches on
 * dashed lines from the triangle's back, all at their board places; no live state; the legend below.
 */
export function diagramSvg(b: BoardState, workflowId: Id): string {
  const wf = b.workflows[workflowId];
  const title = wf?.name ?? workflowId;
  const stepIds = [...reachOf(b, workflowId)].filter((id) => b.steps[id]);
  const cacheIds = (wf?.cacheIds ?? []).filter((id) => b.caches[id]);

  // places, raw board coordinates; a row with no place is put in a row below the others
  let spare = 0;
  const place = (at: { x: number; y: number } | null | undefined, w: number, h: number): Box => {
    if (at) return { x: at.x, y: at.y, w, h };
    return { x: spare++ * (w + 40), y: 0, w, h };
  };
  const tri = place(wf?.at, TRI_W, TRI_H);
  const steps = new Map(stepIds.map((id) => [id, place(b.steps[id]!.at, STEP_W, STEP_H)]));
  const caches = new Map(cacheIds.map((id) => [id, place(b.caches[id]!.at, CACHE_W, CACHE_H)]));
  const all = [tri, ...steps.values(), ...caches.values()];
  const minX = Math.min(...all.map((r) => r.x));
  const minY = Math.min(...all.map((r) => r.y));
  const maxX = Math.max(...all.map((r) => r.x + r.w));
  const maxY = Math.max(...all.map((r) => r.y + r.h));
  // normalised into the viewBox: the picture starts at (PAD, PAD + title)
  const ox = PAD - minX;
  const oy = PAD + TITLE_H - minY;
  const shift = (r: Box): Box => ({ x: r.x + ox, y: r.y + oy, w: r.w, h: r.h });
  const T = shift(tri);
  const S = new Map([...steps].map(([id, r]) => [id, shift(r)]));
  const C = new Map([...caches].map(([id, r]) => [id, shift(r)]));

  const legendW = CONDITIONS.reduce((n, c) => n + 30 + c.name.length * 7 + 12, 0);
  const w = Math.max(maxX - minX, legendW, 360) + 2 * PAD;
  const contentBottom = PAD + TITLE_H + (maxY - minY);
  const h = contentBottom + LEGEND_H + PAD;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}" font-family="${FONT}">`,
    `<rect x="0" y="0" width="${num(w)}" height="${num(h)}" fill="#FFFFFF"/>`,
    `<text x="${PAD}" y="${PAD + 8}" font-size="22" font-weight="700" fill="#0F172A">${esc(title)}</text>`,
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

  // cache lines first, from the triangle's back (its left edge) to each cache
  for (const [, c] of C) {
    out.push(`<path d="${curve(T.x, T.y + T.h / 2, c.x + c.w / 2, c.y + (c.y < T.y ? c.h : 0))}" stroke="${CACHE_STROKE}" stroke-width="1.8" stroke-dasharray="6 5" fill="none"/>`);
  }

  // entry arrows from the tip, and wires between reached steps
  const wireOf = (from: { x: number; y: number }, to: Box, cond: number) => {
    const info = conditionInfo(cond);
    const m = arrow(info.colour);
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
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
      if (to) wireOf({ x: from.x + from.w, y: from.y + from.h / 2 }, to, b.steps[next]!.entryCondition);
    }
  }

  out.push(
    `<polygon points="${num(T.x)},${num(T.y)} ${num(T.x)},${num(T.y + T.h)} ${num(T.x + T.w)},${num(T.y + T.h / 2)}" fill="#EEF2FF" stroke="${TRI_STROKE}" stroke-width="2" stroke-linejoin="round"/>`,
  );

  for (const id of stepIds) {
    const p = S.get(id)!;
    const step = b.steps[id]!;
    const proc = (step.processorId ? b.processors[step.processorId]?.name : undefined) ?? '';
    out.push(
      `<g>`,
      `<rect x="${num(p.x)}" y="${num(p.y)}" width="${p.w}" height="${p.h}" rx="12" ry="12" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.5"/>`,
      `<text x="${num(p.x + 14)}" y="${num(p.y + 34)}" font-size="15" font-weight="600" fill="#0F172A">${esc(clip(step.name, 24))}</text>`,
      `<text x="${num(p.x + 14)}" y="${num(p.y + 56)}" font-size="12" fill="#64748B">${esc(clip(proc, 30))}</text>`,
      `</g>`,
    );
  }
  for (const [id, c] of C) {
    out.push(
      `<g>`,
      `<rect x="${num(c.x)}" y="${num(c.y)}" width="${c.w}" height="${c.h}" rx="10" ry="10" fill="#F8FAFC" stroke="${CACHE_STROKE}" stroke-width="1.5"/>`,
      `<text x="${num(c.x + 14)}" y="${num(c.y + c.h / 2)}" dominant-baseline="central" font-size="14" font-weight="600" fill="#0F172A">${esc(clip(b.caches[id]!.name, 18))}</text>`,
      `</g>`,
    );
  }

  // legend below: the five conditions
  const ly = contentBottom + 22;
  let lx = PAD;
  for (const c of CONDITIONS) {
    pill(lx + 8, ly, c.colour, c.letter);
    out.push(`<text x="${num(lx + 22)}" y="${num(ly)}" dominant-baseline="central" font-size="12" fill="#334155">${esc(c.name)}</text>`);
    lx += 30 + c.name.length * 7 + 12;
  }
  out.push('</svg>');
  return out.join('\n');
}
