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
