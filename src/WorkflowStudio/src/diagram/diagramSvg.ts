import type { StudioDocument } from '../app/document';
import { UNDECIDED_COLOUR } from '../canvas/edges/CableEdge';
import { emptyRoot } from '../canvas/toFlow';
import { CACHE_H, CACHE_W, CAP_H, CHIP, SPHERE_R, STEP_H, STEP_W } from '../layout/geometry';
import type { Pt } from '../layout/router';
import { tetherPoints } from '../layout/wires';
import { CONDITIONS, conditionInfo } from '../model/entryConditions';

/**
 * The workflow as drawn in the studio, as one standalone SVG (the user's rule, 2026-10-11): published to the workflow
 * row on every applied Save, so the Kibana dashboard's diagram panel shows exactly the saved drawing. Pure: the same
 * placement and wire routes the canvas draws, with the blocks simplified to what reads at a glance (a step's name,
 * version, entry condition and processor; the workflow; each cache and its root) in the studio's own colours, on its own
 * background, so it reads the same on a light or a dark dashboard. No fonts, images or scripts are fetched.
 */
export function diagramSvg(doc: StudioDocument): string {
  const { graph, placement, wires } = doc;
  const { cx, cy } = placement.sphere;
  const out: string[] = [];

  // bounds of everything drawn
  const xs: number[] = [cx - SPHERE_R, cx + SPHERE_R], ys: number[] = [cy - SPHERE_R, cy + SPHERE_R];
  for (const p of placement.steps.values()) { xs.push(p.x, p.x + STEP_W); ys.push(p.y, p.y + STEP_H); }
  for (const p of placement.caches.values()) { xs.push(p.x, p.x + CACHE_W); ys.push(p.y, p.y + CACHE_H); }
  for (const w of wires) for (const [x, y] of w.points) { xs.push(x); ys.push(y); }
  const M = 32, HEAD = 44, FOOT = 40;
  const left = Math.floor(Math.min(...xs)) - M, top = Math.floor(Math.min(...ys)) - M - HEAD;
  const width = Math.ceil(Math.max(...xs)) + M - left, height = Math.ceil(Math.max(...ys)) + M + FOOT - top;

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`${graph.workflow.name} ${graph.workflow.version}`)}">`);
  out.push(`<style>text{font-family:"IBM Plex Sans Condensed","Helvetica Neue",Arial,sans-serif;fill:${INK}}.m{font-family:"IBM Plex Mono",ui-monospace,Consolas,monospace}.mu{fill:${MUTED}}</style>`);
  out.push(`<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${GROUND}"/>`);
  out.push(`<text x="${left + M}" y="${top + 28}" font-size="16" font-weight="600">${esc(graph.workflow.name)}<tspan class="m mu" font-size="12" dx="8">${esc(graph.workflow.version)}</tspan></text>`);

  // tethers under everything: the hub to each cache
  for (const [id, p] of placement.caches) {
    if (!graph.caches.has(id)) continue;
    out.push(`<polyline points="${pts(tetherPoints(placement.sphere, p))}" fill="none" stroke="${LINE2}" stroke-width="1.5" stroke-dasharray="4 4"/>`);
  }

  // wires, then their ends
  const used = new Set<number>();
  for (const w of wires) {
    if (w.points.length < 2) continue;
    if (w.condition !== null) used.add(w.condition);
    const colour = w.short ? ERROR : w.condition === null ? UNDECIDED_COLOUR : conditionInfo(w.condition).colour;
    out.push(`<polyline points="${pts(w.points)}" fill="none" stroke="${colour}" stroke-width="2.5" stroke-linejoin="round"${w.solid ? '' : ' stroke-dasharray="7 5"'}/>`);
    const tail = w.points[0]!, head = w.points.at(-1)!;
    if (w.headOn === 'terminal' && w.target !== null) out.push(arrow(w.points.at(-2)!, head, colour));
    if (w.headOn === 'junction') out.push(dot(head, colour));
    if (w.tailOn === 'junction') out.push(dot(tail, colour));
  }

  // the workflow
  out.push(`<circle cx="${cx}" cy="${cy}" r="${SPHERE_R}" fill="${PANEL}" stroke="${ACCENT}" stroke-width="2"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="${SPHERE_R - 10}" fill="none" stroke="${LINE2}" stroke-width="1"/>`);
  out.push(`<text x="${cx}" y="${cy - 10}" text-anchor="middle" font-size="11" letter-spacing="2" class="mu">WORKFLOW</text>`);
  out.push(`<text x="${cx}" y="${cy + 10}" text-anchor="middle" font-size="13" font-weight="600">${esc(cut(graph.workflow.name, 22))}</text>`);
  out.push(`<text x="${cx}" y="${cy + 28}" text-anchor="middle" font-size="11" class="m mu">${esc(graph.workflow.version)}</text>`);

  // steps
  for (const [id, p] of placement.steps) {
    const s = graph.steps.get(id);
    if (!s) continue;
    const c = conditionInfo(s.entryCondition);
    out.push(`<rect x="${p.x}" y="${p.y}" width="${STEP_W}" height="${STEP_H}" rx="6" fill="${BLOCK}" stroke="${LINE2}" stroke-width="1.5"/>`);
    out.push(`<line x1="${p.x}" y1="${p.y + CAP_H}" x2="${p.x + STEP_W}" y2="${p.y + CAP_H}" stroke="${LINE}"/>`);
    out.push(`<text x="${p.x + 12}" y="${p.y + 18}" font-size="13" font-weight="600">${esc(cut(s.name, 26))}</text>`);
    out.push(`<text x="${p.x + 12}" y="${p.y + 33}" font-size="10" class="m mu">STEP · v${esc(s.version)}</text>`);
    out.push(`<rect x="${p.x + STEP_W - 30}" y="${p.y + 10}" width="20" height="20" rx="4" fill="${c.colour}"/>`);
    out.push(`<text x="${p.x + STEP_W - 20}" y="${p.y + 24}" text-anchor="middle" font-size="12" font-weight="700" fill="${GROUND}" style="fill:${GROUND}">${esc(c.letter)}</text>`);
    const chip = { x: p.x + CHIP.x, y: p.y + CHIP.y, w: CHIP.w, h: CHIP.h };
    const proc = s.processorId === null ? undefined : graph.processors.get(s.processorId);
    if (s.processorId === null) {
      out.push(`<rect x="${chip.x}" y="${chip.y}" width="${chip.w}" height="${chip.h}" rx="4" fill="none" stroke="${WARN}" stroke-width="1.5" stroke-dasharray="6 4"/>`);
      out.push(`<text x="${chip.x + chip.w / 2}" y="${chip.y + chip.h / 2 + 5}" text-anchor="middle" font-size="12" fill="${WARN}" style="fill:${WARN}">⚠ no processor</text>`);
    } else {
      out.push(`<rect x="${chip.x}" y="${chip.y}" width="${chip.w}" height="${chip.h}" rx="4" fill="${PANEL2}" stroke="${LINE}"/>`);
      out.push(`<text x="${chip.x + 12}" y="${chip.y + 22}" font-size="10" letter-spacing="1.5" class="mu">PROCESSOR</text>`);
      out.push(`<text x="${chip.x + 12}" y="${chip.y + 44}" font-size="13" font-weight="600">${esc(cut(proc?.name ?? '(missing processor)', 22))}</text>`);
      if (proc) out.push(`<text x="${chip.x + 12}" y="${chip.y + 62}" font-size="10" class="m mu">${esc(proc.version)}</text>`);
    }
  }

  // caches
  for (const [id, p] of placement.caches) {
    const k = graph.caches.get(id);
    if (!k) continue;
    const empty = emptyRoot(k.root);
    out.push(`<rect x="${p.x}" y="${p.y}" width="${CACHE_W}" height="${CACHE_H}" rx="6" fill="${empty ? 'none' : PANEL}" stroke="${empty ? WARN : LINE2}" stroke-width="1.5"${empty ? ' stroke-dasharray="6 4"' : ''}/>`);
    out.push(`<text x="${p.x + CACHE_W / 2}" y="${p.y + 28}" text-anchor="middle" font-size="10" letter-spacing="1.5" class="mu">CACHE · v${esc(k.version)}</text>`);
    lines(k.name, 18).forEach((line, i) => out.push(`<text x="${p.x + CACHE_W / 2}" y="${p.y + 58 + i * 18}" text-anchor="middle" font-size="13" font-weight="600">${esc(line)}</text>`));
    out.push(empty
      ? `<text x="${p.x + CACHE_W / 2}" y="${p.y + 120}" text-anchor="middle" font-size="12" fill="${WARN}" style="fill:${WARN}">⚠ no root</text>`
      : `<text x="${p.x + CACHE_W / 2}" y="${p.y + 120}" text-anchor="middle" font-size="11" class="m mu">${esc(cut(k.root, 20))}</text>`);
  }

  // the legend: the families this drawing uses
  let lx = left + M;
  const ly = top + height - FOOT / 2;
  for (const c of CONDITIONS) {
    if (!used.has(c.value)) continue;
    out.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 24}" y2="${ly}" stroke="${c.colour}" stroke-width="2.5"/>`);
    out.push(`<text x="${lx + 30}" y="${ly + 4}" font-size="11" class="mu">${esc(c.name)}</text>`);
    lx += 40 + c.name.length * 7;
  }

  out.push('</svg>');
  return out.join('\n');
}

const GROUND = '#0A1220', PANEL = '#0E1828', PANEL2 = '#122036', BLOCK = '#0F1C31', LINE = '#1E3050', LINE2 = '#2A4166';
const INK = '#E6EEF8', MUTED = '#8193AE', ACCENT = '#7DD3FC', WARN = '#F5B841', ERROR = '#F87171';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pts = (points: readonly Pt[]) => points.map(([x, y]) => `${x},${y}`).join(' ');
const cut = (s: string, n: number) => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join('')}…` : s);

/** A name over at most two lines, broken after `-`, `_` or `.` (as the canvas breaks a cache's name). */
function lines(name: string, n: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const seg of name.split(/(?<=[-_.])/)) {
    if (current && Array.from(current + seg).length > n) { parts.push(current); current = seg; } else current += seg;
  }
  parts.push(current);
  return (parts.length > 2 ? [parts[0]!, parts.slice(1).join('')] : parts).map((l) => cut(l, n));
}

/** An arrow head at `to`, pointing along the last run. */
function arrow(from: Pt, to: Pt, colour: string): string {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]), L = 10, W = 5;
  const bx = to[0] - L * Math.cos(a), by = to[1] - L * Math.sin(a);
  const p1: Pt = [bx + W * Math.sin(a), by - W * Math.cos(a)], p2: Pt = [bx - W * Math.sin(a), by + W * Math.cos(a)];
  return `<polygon points="${pts([to, p1, p2].map(([x, y]) => [round(x), round(y)] as Pt))}" fill="${colour}"/>`;
}
const dot = ([x, y]: Pt, colour: string) => `<circle cx="${x}" cy="${y}" r="4.5" fill="${colour}"/>`;
const round = (v: number) => Math.round(v * 10) / 10;
