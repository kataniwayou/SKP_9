# Offline drop 2026-11-25: Acto, entry-step crons, cache items, Studio/Valence removed

**For Claude Code on the offline machine.** Follow it in order. Every command runs **from the repo root**. Stop at any
**Expect** that does not match, and report it. Do not skip the backup in step 2.

- **Source:** branch `feature/acto` at `045d32d3` (or later). The changes covered start at `8e774346` (2026-11-23).
- **Namespace:** `skp`. Workload names are the repo's: `baseapi-service` (Deployment), `orchestrator` (StatefulSet),
  `processor-analyst` (Deployment), `acto` (Deployment).
- **No third-party input changed.** `src/Acto/package-lock.json`, `Acto-offline/npm-offline/`, `nugets/` (except the
  repacked `Messaging.Contracts` nupkg, which is in the repo), `vendor/` and `Directory.Packages.props` all stay as they
  were. The base-image tars already on the machine (`Acto-offline/images/*.tar`) still apply.

## 0. What changes, and what does not

### Rebuild and redeploy (4 images)

| # | Project | Image / workload | What changed |
|---|---|---|---|
| 1 | `src/Orchestrator` | `orchestrator:local` / StatefulSet `orchestrator` | It schedules one Quartz job group for each **entry cron**. A fire dispatches only that group's entry steps. An entry step whose condition is **Never** is skipped. Stop clears every group. |
| 2 | `src/BaseApi.Service` | `baseapi-service:local` / Deployment `baseapi-service` | Each entry step can carry its own cron, and the workflow's own cron is removed. Cache items are rows in `cache_items`, sent as `[{key,value}]` (a key is at most 256 characters, with no `:`). The endpoints only Studio and Valence called are removed. **Three migrations** (step 2). |
| 3 | `src/Processor.Analyst` | `processor-analyst:local` / Deployment `processor-analyst` | Reads the entry crons from L2. The graph names entry steps that have their own cron. **Its SourceHash changes**, so the processor row must be repointed (step 5). |
| 4 | `src/Acto` | `acto:local` / Deployment `acto` | Entry crons, the "not scheduled" and "frozen" entry styles, Discard, health hearts, ghosts (made only by a delete), wires coloured by their target's condition, drag and drop (lifted card, push-aside), the Kibana diagram. It needs BaseApi from **the same commit** (an older one answers 404 on Save). |

`src/Messaging.Contracts` is not deployed by itself. `WorkflowL1` loses `Cron` and gains `EntryCrons`, and there are a
new `EntrySchedule` and a changed `WorkflowStoreProjection`. Its repacked `nugets/1.0.0/Messaging.Contracts.1.0.0.nupkg`
is in the repo, and the three .NET images above pick it up when they build.

### What is unaffected

- **Every other processor**, and `BaseProcessor.Core`, `BaseConsole.Core`, `BaseApi.Core` and `Messaging.Transport`: only
  the package hash in `packages.lock.json` moved, because of the repack. None uses the changed types. Do not rebuild
  them for this drop.
- **What processors get for caches:** `CacheL1` (root plus a dictionary of strings) and the `RefreshCache` message are
  unchanged. BaseApi converts the rows back into that dictionary. No processor reads `/caches`.

### Removed

- **WorkflowStudio** and **Valence**: `src/WorkflowStudio`, `src/Valence`, `Studio-offline/`, `Valence-offline/`,
  `k8s/31-workflow-studio.yaml` and `k8s/32-valence.yaml` are all deleted, and `k8s/kustomization.yaml` no longer lists
  them. Their workloads come off the cluster in step 7.
- If the tree arrives as a **delta** (`tools/ship-delta.ps1`), deletions are not applied unless you pass
  `-PruneRemoved`. Delete those folders and files on the offline tree by hand. Otherwise `SK_P.sln` and the deleted
  manifests linger.

### Carried along (nothing to deploy)

`kibana/publish-diagram.py`, `kibana/README.md`, `k8s/README.md`, `k8s/port-forward-realstack.ps1` (no Studio or
Valence ports), `Acto-offline/README.md`, `tools/simulate-approved-feed.py`, `tools/copy-object-chain.py`,
`tools/analyst-fire-once.sh` and `tools/vendor-npm.mjs`.

## 1. Check the tree, and stop the running workflows

```
git log --oneline -1
```

**Expect:** `045d32d3` or a later commit. Then check that the removed projects are gone:

```
ls src/WorkflowStudio src/Valence Studio-offline Valence-offline k8s/31-workflow-studio.yaml k8s/32-valence.yaml
```

**Expect:** "not found" for each one. Delete any that exist.

**Stop every running workflow before any rollout.** Use Acto's Stop, or `POST /api/v1/orchestration/stop` with body `"<workflowId>"` (a JSON string)
for each live one; `GET /api/v1/orchestration/live` lists them. **Record their ids**, because step 8 starts them again.

The reason: a workflow's schedule is projected at **Start** in the old shape (a single workflow cron). The new
Orchestrator reads the per-entry crons, finds none in an old projection, and schedules nothing, with no error.

## 2. Back up the database (mandatory)

Two migrations **drop a column after copying its data**: `workflows.cron_expression` and `caches.items`. Back up first.

```bash
kubectl -n skp exec postgres-0 -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > skp-before-2026-11-25.dump
```

**Expect:** a non-empty file. Keep it until step 8 is verified.

What BaseApi runs at startup (in this order):

| Migration | Does | Down |
|---|---|---|
| `20261124120000_AddEntryStepCron` | adds a nullable cron column to the workflow's entry-step link | drops it |
| `20261124180000_RemoveWorkflowCron` | copies each workflow's cron onto **every** entry step of that workflow (a blank cron is not copied), then drops `workflows.cron_expression` | restores the column |
| `20261125120000_CacheItemsTable` | creates `cache_items`, copies every key of `caches.items` into rows (`jsonb_each_text`), then drops `caches.items` | rebuilds `caches.items` from the rows (`jsonb_object_agg`) |

## 3. Build the four images

```
docker build -f src/Orchestrator/Dockerfile        -t orchestrator:local .
docker build -f src/BaseApi.Service/Dockerfile     -t baseapi-service:local .
docker build -f src/Processor.Analyst/Dockerfile   -t processor-analyst:local .
docker build --network=none -f src/Acto/Dockerfile -t acto:local .
```

**Expect:** each ends by naming its tag, with no `ERROR`. For Acto, follow `Acto-offline/README.md` steps 1–3 if its
base images are not loaded yet (`docker load -i Acto-offline/images/node-24-alpine.tar` and `.../nginx-1.29-alpine.tar`).
If the .NET builds need your offline NuGet feed or registry base images, use the same arguments as your last .NET drop.

Then get the images to the cluster, the same way as before: `kind load docker-image <tag> --name <cluster>`, or
tag and push to your registry. `Acto-offline/README.md` step 5 shows both.

## 4. Orchestrator first, then BaseApi

The **Orchestrator goes first.** An old Orchestrator next to a new BaseApi would ignore the entry crons, with no error.

```
kubectl -n skp rollout restart statefulset/orchestrator
kubectl -n skp rollout status  statefulset/orchestrator
kubectl -n skp rollout restart deploy/baseapi-service
kubectl -n skp rollout status  deploy/baseapi-service
kubectl -n skp logs deploy/baseapi-service | grep -iE "migrat|error" | tail -20
```

**Expect:** both rollouts succeed, and BaseApi's log shows the three migrations applied with no error. Then check
the data carried over:

```bash
kubectl -n skp exec postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM cache_items;" -c "SELECT version FROM \"__EFMigrationsHistory\" ORDER BY 1 DESC LIMIT 3;"'
```

**Expect:** `cache_items` holds as many rows as the caches had keys in total, and the three new migration ids are listed.

API check (port-forward `svc/baseapi-service 18080:8080` first):

- `GET http://localhost:18080/api/v1/caches` returns items as `[{"key":..,"value":..}]`.
- `GET http://localhost:18080/api/v1/workflows` returns `entryCrons` on each workflow, and no `cronExpression`.

## 5. The Analyst (repoint its SourceHash before it rolls)

The Analyst's source changed, so its **SourceHash changes**. The pod resolves its identity by that hash. Repoint the
existing `analyst` row **before** rolling out. **Never create a new row**: the assignment edges point at the existing id.

```powershell
# pwsh, not powershell.exe (5.1 cannot load a .NET 8 assembly)
dotnet build src/Processor.Analyst/Processor.Analyst.csproj
$asm  = [Reflection.Assembly]::LoadFrom((Resolve-Path "src/Processor.Analyst/bin/Debug/net8.0/Processor.Analyst.dll"))
$hash = ($asm.GetCustomAttributes([Reflection.AssemblyMetadataAttribute], $false) | Where-Object { $_.Key -eq 'SourceHash' }).Value
$hash
```

```bash
kubectl -n skp exec postgres-0 -- sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"UPDATE processors SET source_hash='<hash>', updated_at=now() AT TIME ZONE 'utc' WHERE name='analyst';\""
```

**Expect:** `UPDATE 1`. Then:

```
kubectl -n skp apply -f k8s/43-processor-analyst.yaml
kubectl -n skp rollout restart deploy/processor-analyst
kubectl -n skp rollout status  deploy/processor-analyst
kubectl -n skp logs deploy/processor-analyst | grep "resolving identity for source hash"
```

**Expect:** the log names the same `<hash>`. Before applying `k8s/43-processor-analyst.yaml`, check that its
`Analyst__Model__*` settings are your offline ones, and that no real key is in the file.

## 6. Acto

Follow `Acto-offline/README.md` steps 6–8 (settings in `k8s/47-acto.yaml`, then apply and roll out). Short form:

```
kubectl apply -f k8s/47-acto.yaml
kubectl -n skp rollout restart deploy/acto
kubectl -n skp rollout status  deploy/acto
```

**Expect** (port-forward `svc/acto 18083:8080`, then open `http://localhost:18083/`):

- The board loads. Each entry step shows its cron, and an entry with no cron shows `⏱ not scheduled`.
- Save and Discard sit side by side.
- Health is shown as hearts.
- Saving a small edit succeeds. A 404 here means BaseApi is from an older commit.

## 7. Remove Studio and Valence from the cluster

```
kubectl -n skp delete deployment workflow-studio valence --ignore-not-found
kubectl -n skp delete service    workflow-studio valence --ignore-not-found
kubectl -n skp get all | grep -iE "studio|valence"
```

**Expect:** the last command prints nothing. Use `k8s/port-forward-realstack.ps1` from the new tree, since it no longer
forwards their ports. If you deploy with `kubectl apply -k k8s`, the kustomization no longer lists them, but `apply -k`
does not delete them: the commands above still do that.

## 8. Start the workflows again, and verify

Start each workflow recorded in step 1, from Acto or with `POST /api/v1/orchestration/start` with body `"<workflowId>"`.

- **Each entry step now carries its workflow's old cron**, copied by the migration. A workflow that had no cron has
  entry steps with no cron, and **those never fire** (Acto shows `⏱ not scheduled`). Give them a cron in Acto and
  Save before you start them, if they should run.
- Entry steps that share a cron fire together, under one correlation id per tick. An entry step with its own cron fires
  on that cron alone.
- An entry step set to **Never** (frozen) is skipped on every fire. A freeze or unfreeze takes effect at the
  **next Start**, not at Save.

Verify in Kibana (`logs-*`) over a few cron ticks: each entry step is dispatched on its own cron's marks, and frozen
ones are logged as skipped. Nothing runs for a workflow after its Stop.

## 9. Rollback

Roll back only all three together: BaseApi, the Orchestrator and the Analyst. Contracts and data changed shape, so a
mixed set does not work. Restore the database from `skp-before-2026-11-25.dump` with
`pg_restore --clean -d "$POSTGRES_DB"`, then redeploy the previous images and start the workflows. The `Down`
migrations also exist, but the dump is simpler and exact.
