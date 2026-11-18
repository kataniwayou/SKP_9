import { baseline, deleteE2eRows, isE2e, readAll, realDifferences, TABLES } from './stack';

/**
 * After every spec's own cleanup: every e2e- row still there is deleted through /model/apply, then the run fails loudly if
 * any remain or if any real row differs from the baseline in a field other than its location (boardX, boardY, updatedAt).
 */
export default async function globalTeardown() {
  const b = baseline();
  const gone = await deleteE2eRows();
  if (gone > 0) console.warn(`[acto e2e] teardown deleted ${gone} leftover e2e- rows`);
  const after = await readAll();
  const remain = TABLES.flatMap((t) => after[t].filter((r) => isE2e(r.name)).map((r) => `${t} ${r.name}`));
  const diffs = realDifferences(b.snapshot, after);
  const placed = TABLES.reduce((n, t) => n + after[t].filter((r) => !isE2e(r.name)).filter((r) => {
    const was = b.snapshot[t].find((x) => x.id === r.id);
    return was && (was.boardX !== r.boardX || was.boardY !== r.boardY);
  }).length, 0);
  console.log(`[acto e2e] teardown: ${TABLES.map((t) => `${after[t].length} ${t}`).join(', ')}; e2e- rows left: ${remain.length}; `
    + `real rows changed beyond location: ${diffs.length}; real rows whose location Acto wrote: ${placed}`);
  if (remain.length > 0 || diffs.length > 0) {
    throw new Error(`[acto e2e] the stack is not as the run found it:\n${[...remain.map((r) => `left behind: ${r}`), ...diffs].join('\n')}`);
  }
}
