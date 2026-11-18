import { test as base, expect } from '@playwright/test';
import { baseline, deleteE2eRows, isE2e, type Baseline, type Row } from './stack';

/**
 * Every spec imports `test` from here. It adds:
 * - `stack` (per worker): the stack as the run found it (every real row, all fields).
 * - `guard` (automatic, per test): the page may read anything, but a write reaches BaseAPI only when it is
 *     - POST /model/apply (or /validate) whose changes create rows named e2e-..., update or delete rows the run made, or
 *       update a real row with nothing changed but its location (controller ruling R5: Save is board-wide);
 *     - a validate or Kibana diagram publish of a workflow (what a Save does for every workflow it touched).
 *   A processor or schema change, Start/Stop and every other write are aborted and fail the test.
 * - the throwaway rows (e2e-...) left by a test are deleted through /model/apply after it.
 */
export interface Stack extends Baseline {
  real: Map<string, Row>;
}

const norm = (v: unknown) => (v === undefined || v === '' ? null : Array.isArray(v) ? [...v].sort() : v);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/** Why a /model change must not go out, or null. */
export function refusal(c: { op?: string; table?: string; id?: string; row?: Record<string, unknown> }, real: Map<string, Row>): string | null {
  if (c.table !== 'workflows' && c.table !== 'steps' && c.table !== 'caches' && c.table !== 'assignments') return `a ${c.table} change (only workflows, steps, caches and assignments may be written)`;
  const was = real.get(c.id ?? '');
  if (c.op === 'create') return isE2e(c.row?.name) ? null : `create of "${String(c.row?.name)}": a throwaway must be named e2e-...`;
  if (!was) return null; // a row the run made
  if (c.op === 'delete') return `delete of the real ${c.table} row ${was.name}`;
  for (const [k, v] of Object.entries(c.row ?? {})) {
    if (k === 'boardX' || k === 'boardY') continue;
    if (!sameValue(was[k], v)) return `update of the real ${c.table} row ${was.name}: ${k} would change (${JSON.stringify(was[k])} -> ${JSON.stringify(v)})`;
  }
  return null;
}

/**
 * The workflow list as the board reads it, with one accommodation: a real workflow that has no entry step (the stack's legacy
 * `untitled`) and no location is given one here. BaseAPI refuses every update of such a row ("EntryStepIds must contain at least one
 * Step Id"), the location-only one Acto would send for it included, and that one refusal would make every board-wide Save of the
 * suite fail. The row itself is never touched (teardown checks it).
 */
function placeUnsavable(rows: Row[]): Row[] {
  return rows.map((w, i) => (w.boardX == null && ((w.entryStepIds as string[] | undefined) ?? []).length === 0 && !isE2e(w.name)
    ? { ...w, boardX: -2000 - i * 400, boardY: -2000 } : w));
}

export const test = base.extend<{ guard: string[] }, { stack: Stack }>({
  stack: [async ({}, use) => {
    const b = baseline();
    const real = new Map<string, Row>();
    for (const rows of Object.values(b.snapshot)) for (const r of rows) real.set(r.id, r);
    await use({ ...b, real });
    await deleteE2eRows();
  }, { scope: 'worker' }],

  guard: [async ({ page, stack }, use) => {
    const violations: string[] = [];
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request();
      const method = req.method();
      const path = new URL(req.url()).pathname.replace(/^\/api\/v1/, '');
      if (method === 'GET' && path === '/workflows') {
        const answer = await route.fetch();
        return route.fulfill({ response: answer, json: placeUnsavable((await answer.json()) as Row[]) });
      }
      if (method === 'GET') return route.continue();
      let why: string | null = null;
      if (path === '/model/apply' || path === '/model/validate') {
        const body = (req.postDataJSON() ?? {}) as { changes?: { op?: string; table?: string; id?: string; row?: Record<string, unknown> }[] };
        for (const c of body.changes ?? []) { why = refusal(c, stack.real); if (why) break; }
      } else if (!(method === 'POST' && /^\/workflows\/[^/]+\/validate$/.test(path)) && !(method === 'PUT' && /^\/workflows\/[^/]+\/diagram$/.test(path))) {
        why = 'only a board save (/model/apply), a validate and a diagram publish may be written (never Start/Stop)';
      }
      if (why) { violations.push(`${method} ${path}: ${why}`); return route.abort(); }
      return route.continue();
    });
    try {
      await use(violations);
      expect(violations, 'writes the guard refused').toEqual([]);
    } finally {
      await deleteE2eRows();
    }
  }, { auto: true }],
});

export { expect };
