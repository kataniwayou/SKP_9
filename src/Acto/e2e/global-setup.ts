import { API, deleteE2eRows, isE2e, readAll, writeBaseline, type Snapshot } from './stack';

/**
 * Before any spec: leftovers of an earlier run (e2e- rows) are deleted, then every real workflow, step, cache and assignment
 * is snapshotted, all fields, to test-results/e2e-baseline.json. global-teardown.ts compares against it.
 */
export default async function globalSetup() {
  const ping = await fetch(`${API}/workflows`).catch(() => null);
  if (!ping?.ok) throw new Error(`BaseAPI is not reachable at ${API}; port-forward it first (kubectl -n skp port-forward svc/baseapi-service 18080:8080)`);
  const left = await deleteE2eRows();
  if (left > 0) console.warn(`[acto e2e] setup deleted ${left} e2e- rows left by an earlier run`);
  const all = await readAll();
  const snapshot = Object.fromEntries(Object.entries(all).map(([t, rows]) => [t, rows.filter((r) => !isE2e(r.name))])) as Snapshot;
  writeBaseline({ startedAt: new Date().toISOString(), snapshot, workflows: snapshot.workflows.map((w) => ({ id: w.id, name: w.name })) });
  const n = Object.values(snapshot).reduce((a, r) => a + r.length, 0);
  console.log(`[acto e2e] baseline: ${snapshot.workflows.length} workflows, ${snapshot.steps.length} steps, ${snapshot.caches.length} caches, ${snapshot.assignments.length} assignments (${n} real rows)`);
}
