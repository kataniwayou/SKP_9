import { test as base, expect } from '@playwright/test';
import { baseline, deleteE2eRows, isE2e, type Baseline, type Row } from './stack';
import { refusal } from './refusal';

export { refusal };

/**
 * Every spec imports `test` from here. It adds:
 * - `stack` (per worker): the stack as the run found it (every real row, all fields).
 * - `guard` (automatic, per test): the page may read anything, but a write reaches BaseAPI only when it is
 *     - POST /model/apply (or /validate) whose changes create rows named e2e-..., update or delete rows the run made, or
 *       update a real row with nothing changed but its location (controller ruling R5: Save is board-wide);
 *     - a validate or Kibana diagram publish of a workflow (what a Save does for every workflow it touched).
 *   A schema create that is not e2e-, a processor create or delete, a real schema's or processor's fields beyond its location, Start/Stop and every other write are aborted and fail the test.
 * - the throwaway rows (e2e-...) left by a test are deleted through /model/apply after it.
 */
export interface Stack extends Baseline {
  real: Map<string, Row>;
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
      } else if (method === 'POST' && (path === '/orchestration/start' || path === '/orchestration/stop')) {
        // only the live run (ACTO_E2E_LIVE=1, user 2026-11-23) may start or stop, and only a workflow this run made, never a real one
        const wf = String(req.postDataJSON() ?? '');
        if (process.env.ACTO_E2E_LIVE !== '1') why = 'Start/Stop only in the live run (ACTO_E2E_LIVE=1)';
        else if (stack.real.has(wf) || !wf) why = `Start/Stop of a workflow this run did not make (${wf || 'no id'})`;
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
