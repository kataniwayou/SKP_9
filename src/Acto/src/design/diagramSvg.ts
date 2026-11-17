import type { BoardWorkflow } from '../board/loadBoard';
import { FRAME_PAD, STEP_H, STEP_W } from '../board/geometry';
import { conditionStyle, landings } from '../board/wires';
import { wirePath } from '../board/wirePath';

const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const PAD = 24;
const TITLE_H = 40;
const LEGEND_H = 40;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One standalone SVG of a workflow in Acto's look (no live state, no external references). */
export function diagramSvg(bw: BoardWorkflow): string {
  const box = (id: string) => {
    const p = bw.stepAt.get(id);
    return p ? { x: p.x, y: p.y, w: STEP_W, h: STEP_H } : null;
  };
  const rects = bw.stepIds.map(box).filter((r): r is NonNullable<typeof r> => r !== null);
  const maxX = Math.max(0, ...rects.map((r) => r.x + r.w));
  const maxY = Math.max(0, ...rects.map((r) => r.y + r.h));
  // content origin is (0,0); the frame's own padding is kept so the picture matches the board
  const left = 0;
  const top = -TITLE_H;
  const w = Math.max(maxX + FRAME_PAD, 520) + 2 * PAD;
  const contentBottom = maxY + FRAME_PAD;
  const h = TITLE_H + contentBottom + LEGEND_H + 2 * PAD;
  const vbX = left - PAD;
  const vbY = top - PAD;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}">`,
    `<rect x="${vbX}" y="${vbY}" width="${w}" height="${h}" fill="#FFFFFF"/>`,
    `<text x="0" y="${-TITLE_H / 2 + 6}" font-size="22" font-weight="700" fill="#0F172A">${esc(bw.graph.workflow.name)}</text>`,
  );

  const lands = landings(bw.wires, box);
  for (const wire of bw.wires) {
    const l = lands.get(wire.id);
    if (!l) continue;
    const style = conditionStyle(wire.condition);
    const { d, pill } = wirePath(l.out, l.in);
    const m = `arrow-${wire.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    out.push(
      `<marker id="${m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${style.colour}"/></marker>`,
      `<path d="${d}" stroke="${style.colour}" stroke-width="2.2" fill="none" marker-end="url(#${m})"/>`,
      `<circle cx="${pill.x}" cy="${pill.y}" r="8" fill="${style.colour}"/>`,
      `<text x="${pill.x}" y="${pill.y}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="700" fill="#FFFFFF">${style.letter}</text>`,
    );
  }

  for (const id of bw.stepIds) {
    const p = bw.stepAt.get(id);
    const step = bw.graph.steps.get(id);
    if (!p || !step) continue;
    const proc = (step.processorId ? bw.graph.processors.get(step.processorId)?.name : undefined) ?? '';
    const role = bw.roles.get(id);
    const tag = role === 'first' ? 'FIRST' : role === 'parked' ? 'PARKED' : '';
    out.push(
      `<g>`,
      `<rect x="${p.x}" y="${p.y}" width="${STEP_W}" height="${STEP_H}" rx="12" ry="12" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.5"/>`,
      `<text x="${p.x + 14}" y="${p.y + 34}" font-size="15" font-weight="600" fill="#0F172A">${esc(clip(step.name, 24))}</text>`,
      `<text x="${p.x + 14}" y="${p.y + 56}" font-size="12" fill="#64748B">${esc(clip(proc, 30))}</text>`,
    );
    if (tag) {
      out.push(
        `<rect x="${p.x + 14}" y="${p.y + STEP_H - 28}" width="${tag.length * 7 + 14}" height="18" rx="9" fill="#EEF2FF"/>`,
        `<text x="${p.x + 21}" y="${p.y + STEP_H - 19}" dominant-baseline="central" font-size="10" font-weight="700" fill="#4F46E5">${tag}</text>`,
      );
    }
    out.push(`</g>`);
  }

  // legend: the five conditions
  const ly = contentBottom + 18;
  let lx = 0;
  for (const c of [1, 2, 3, 4, 5]) {
    const s = conditionStyle(c);
    out.push(
      `<circle cx="${lx + 8}" cy="${ly}" r="8" fill="${s.colour}"/>`,
      `<text x="${lx + 8}" y="${ly}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="700" fill="#FFFFFF">${s.letter}</text>`,
      `<text x="${lx + 22}" y="${ly}" dominant-baseline="central" font-size="12" fill="#334155">${s.name}</text>`,
    );
    lx += 30 + s.name.length * 7 + 12;
  }
  out.push('</svg>');
  return out.join('\n');
}
