import { test as base, expect, request as pwRequest } from '@playwright/test';
import { baseline, type Baseline } from './stack';

/**
 * Every spec imports `test` from here. It adds:
 * - `stack` (per worker): the stack as the run found it, and the throwaway workflows this worker wrote to; those still on
 *   BaseAPI are deleted when the worker ends (a 404 is fine).
 * - `guard` (automatic, per test): the page may read anything, but a write reaches BaseAPI only when it is a design save,
 *   diagram, validate or delete of a workflow that did not exist before the run, and a design save carries no processor
 *   or schema edit. Start/Stop and every other write are aborted and fail the test. After the test, no pre-existing
 *   workflow may be left unsaved on the page (except one that loaded unsaved from its stored design).
 */
export interface Stack extends Baseline {
  /** Ids of the workflows this worker sent a write for (recorded before the write goes). */
  created: Set<string>;
  preIds: Set<string>;
}

export const test = base.extend<{ guard: string[] }, { stack: Stack }>({
  stack: [async ({}, use, workerInfo) => {
    const b = baseline();
    const stack: Stack = { ...b, created: new Set(), preIds: new Set(b.workflows.map((w) => w.id.toLowerCase())) };
    await use(stack);
    const ctx = await pwRequest.newContext({ baseURL: workerInfo.project.use.baseURL! });
    try {
      for (const id of stack.created) {
        if (stack.preIds.has(id.toLowerCase())) continue;
        const r = await ctx.get(`/api/v1/workflows/${id}`);
        if (r.status() === 404) continue;
        const d = await ctx.post(`/api/v1/workflows/${id}/delete`);
        if (!d.ok() && d.status() !== 404) console.warn(`[acto e2e] could not delete throwaway ${id}: ${d.status()}`);
      }
    } finally { await ctx.dispose(); }
  }, { scope: 'worker' }],

  guard: [async ({ page, stack }, use) => {
    const violations: string[] = [];
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request();
      const method = req.method();
      if (method === 'GET') return route.continue();
      const path = new URL(req.url()).pathname.replace(/^\/api\/v1/, '');
      const wf = /^\/workflows\/([^/]+)\/(design|diagram|validate|delete)$/.exec(path);
      let why: string | null = null;
      if (!wf) why = 'only a throwaway workflow may be written to (Start/Stop and entity writes are never sent)';
      else if (stack.preIds.has(wf[1]!.toLowerCase())) why = 'a pre-existing workflow';
      else if (wf[2] === 'design') {
        const body = (req.postDataJSON() ?? {}) as { processors?: unknown[]; schemas?: unknown[] };
        if ((body.processors?.length ?? 0) > 0 || (body.schemas?.length ?? 0) > 0) why = 'a processor or schema edit (processors are shared)';
      }
      if (why) { violations.push(`${method} ${path}: ${why}`); return route.abort(); }
      stack.created.add(wf![1]!);
      return route.continue();
    });
    await use(violations);
    expect(violations, 'writes the guard refused').toEqual([]);
    // no pre-existing workflow is left with unsaved work (one that loaded unsaved from a stored design aside)
    if (!page.isClosed() && await page.locator('.react-flow').count() > 0) {
      const unsaved = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.react-flow__node-workflow')]
        .filter((n) => n.querySelector('.unsaved-tag')).map((n) => (n.dataset.id ?? '').replace(/^wf:/, '').toLowerCase()));
      const allowed = new Set(stack.designed.map((id) => id.toLowerCase()));
      const bad = unsaved.filter((id) => stack.preIds.has(id) && !allowed.has(id));
      expect(bad, 'pre-existing workflows left unsaved').toEqual([]);
    }
  }, { auto: true }],
});

export { expect };
