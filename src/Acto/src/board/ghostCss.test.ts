import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const weight = (sel: string): number => (sel.match(/\.[\w-]+/g) ?? []).length;
const css = readFileSync('src/board/board.css', 'utf8');
const rules = [...css.matchAll(/^([^{}\n@/][^{}]*)\{([^}]*)\}/gm)].map((m, i) => ({ sels: m[1]!.split(',').map((x) => x.trim()), body: m[2]!, i }));

describe('ghost triangle look', () => {
  it('a ghost triangle body rule outranks the stopped one (the slate outline must not win)', () => {
    const stopped = rules.find((r) => r.sels.includes('.tri.stopped .tri-body'))!;
    const ghost = rules.find((r) => r.sels.includes('.tri.ghost.stopped .tri-body'))!;
    expect(ghost.body).toContain('stroke: var(--ghost-line)');
    expect(ghost.body).toContain('stroke-dasharray');
    expect(ghost.body).toContain('fill: var(--b-node)');
    expect(weight('.tri.ghost.stopped .tri-body')).toBeGreaterThan(weight('.tri.stopped .tri-body'));
    expect(ghost.i).toBeGreaterThan(stopped.i);
  });
});

describe('selected ghost look [user, 2026-11-24]', () => {
  const find = (sel: string) => rules.find((r) => r.sels.includes(sel))!;
  it('a selected ghost step, cache and triangle show the accent frame, after (and outranking) the ghost outline', () => {
    const outline = find('.ghost .node');
    const sel = find('.ghost .node.sel');
    expect(sel.body).toContain('border-color: var(--accent)');
    expect(sel.body).toContain('var(--accent-soft)');
    expect(sel.i).toBeGreaterThan(outline.i);
    expect(weight('.ghost .node.sel')).toBeGreaterThan(weight('.ghost .node'));
    expect(find('.ghost .cache-chip.sel').body).toContain('border-color: var(--accent)');
    const tri = find('.tri.ghost.stopped.sel .tri-body');
    expect(tri.body).toContain('stroke: var(--accent)');
    expect(tri.i).toBeGreaterThan(find('.tri.ghost.stopped .tri-body').i);
  });
  it('a selected ghost is far less faded than an unselected one', () => {
    expect(find('.react-flow__node.ghost:has(.sel)').body).toMatch(/opacity: \.85/);
  });
});
