# Offline drop 2026-11-25: Acto, entry-step crons, cache items, Studio/Valence removed

Source: `feature/acto` at `f3483275` or later. Covers everything since `8e774346` (2026-11-23).
No third-party input changed, so the npm-offline folder, the NuGet packages and the base-image tars already on the
machine still apply.

**Ship:** Orchestrator, BaseApi, Processor.Analyst and Acto. Messaging.Contracts gets no image of its own: its repacked
nupkg is in the repo, and the other images build with it.
**Do not rebuild:** the other processors and core libraries. Only their lock-file hash changed.
**Remove:** WorkflowStudio and Valence (code, offline kits and manifests).

## Steps, in order

1. **Bring the tree over.** If it comes as a delta, delete the removed folders and files by hand:
   `src/WorkflowStudio`, `src/Valence`, `Studio-offline`, `Valence-offline`, `k8s/31-*` and `k8s/32-*`.
2. **Stop every running workflow, and note their ids.** Their schedule was saved at Start in the old single-cron
   format, which the new Orchestrator ignores without any error.
3. **Back up Postgres.** Two of the migrations copy data and then drop a column: `workflows.cron_expression`, and
   `caches.items` (now the `cache_items` table).
4. **Build the four images.** For Acto, use the `Acto-offline` kit.
5. **Deploy the Orchestrator first.** An old Orchestrator next to a new BaseApi would silently ignore the entry crons.
6. **Deploy BaseApi.** Its three migrations run when it starts:
   - add a cron to each entry step;
   - copy each workflow's cron onto its entry steps, then drop the workflow cron;
   - move the cache items into rows.

   Check the log for errors. Check that `/caches` returns items as `[{key,value}]` and that workflows show `entryCrons`.
7. **Deploy the Analyst.** Its SourceHash changed, so first update the existing `analyst` row's `source_hash` (never
   create a new row), then roll it out. Its log should show the new hash.
8. **Deploy Acto.** It needs BaseApi from the same commit: Save returns 404 against an older BaseApi.
9. **Delete the `workflow-studio` and `valence` Deployments and Services.** `kubectl apply -k` does not remove them.
10. **Start the workflows again.**
    - Each entry step now has its workflow's old cron.
    - An entry step with no cron never fires: give it one in Acto first.
    - A freeze (Never) takes effect at the next Start.
11. **Verify in Kibana** over a few ticks:
    - each entry step is dispatched on its own cron;
    - frozen entry steps are logged as skipped;
    - nothing runs after a Stop.

**Rollback:** roll back the Orchestrator, BaseApi and the Analyst together, and restore the Postgres backup.
