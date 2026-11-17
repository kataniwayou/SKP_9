import { API, type Baseline } from './stack';

/**
 * Before any spec: what the shared stack holds (the pre-existing workflows, and which of them have a stored design), and
 * when the run began. The specs and global-teardown.ts read it from the environment (workers inherit it).
 */
export default async function globalSetup() {
  const list = await fetch(`${API}/workflows`);
  if (!list.ok) throw new Error(`BaseAPI is not reachable at ${API} (GET /workflows answered ${list.status}); port-forward it first`);
  const workflows = (await list.json()) as { id: string; name: string }[];
  const designed: string[] = [];
  for (const w of workflows) {
    const g = await fetch(`${API}/workflows/${w.id}/graph`);
    if (g.ok && ((await g.json()) as { design?: unknown }).design != null) designed.push(w.id);
  }
  const baseline: Baseline = { startedAt: new Date().toISOString(), workflows: workflows.map((w) => ({ id: w.id, name: w.name })), designed };
  process.env.ACTO_E2E_BASELINE = JSON.stringify(baseline);
}
