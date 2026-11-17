import { API, baseline, THROWAWAY_NAME } from './stack';

/**
 * The safety net after every spec's own cleanup: a workflow that was not there when the run began, carries a throwaway
 * name and was created during the run is deleted (a 404 is fine). Pre-existing workflows are never touched. Then the
 * run says, on the console, whether the stack is back as it was.
 */
export default async function globalTeardown() {
  const b = baseline();
  const before = new Set(b.workflows.map((w) => w.id));
  const list = await fetch(`${API}/workflows`);
  if (!list.ok) { console.warn(`[acto e2e] teardown could not list workflows (${list.status})`); return; }
  const now = (await list.json()) as { id: string; name: string; createdAt?: string }[];
  for (const w of now) {
    if (before.has(w.id) || !THROWAWAY_NAME.test(w.name) || (w.createdAt && w.createdAt < b.startedAt)) continue;
    const r = await fetch(`${API}/workflows/${w.id}/delete`, { method: 'POST' });
    console.warn(`[acto e2e] teardown deleted leftover throwaway ${w.name} (${w.id}): ${r.status}`);
  }
  const after = (await (await fetch(`${API}/workflows`)).json()) as { id: string; name: string }[];
  const extra = after.filter((w) => !before.has(w.id));
  const missing = b.workflows.filter((w) => !after.some((a) => a.id === w.id));
  const designed: string[] = [];
  for (const w of after) {
    const g = await fetch(`${API}/workflows/${w.id}/graph`);
    if (g.ok && ((await g.json()) as { design?: unknown }).design != null) designed.push(w.name);
  }
  console.log(`[acto e2e] after the run: ${after.length} workflows (${after.map((w) => w.name).join(', ')}); `
    + `extra: ${extra.length === 0 ? 'none' : extra.map((w) => w.name).join(', ')}; missing: ${missing.length === 0 ? 'none' : missing.map((w) => w.name).join(', ')}; `
    + `with a stored design: ${designed.length === 0 ? 'none' : designed.join(', ')}`);
}
