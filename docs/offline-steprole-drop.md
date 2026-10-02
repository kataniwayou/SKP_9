# Offline drop: the StepRole change set

`RunPosition` is gone; `StepRole` (a step's per-workflow graph role: `entry` / `intermediate` /
`terminal`) replaces it. Commits `0688b06..dc4fa54` on `feature/path-importer`. Spec:
`docs/superpowers/specs/2026-10-02-step-role-design.md`. Every command below was run on dev on
2026-10-02.

**This file is a note, not the drop.** No `ship/` baseline exists in the checkout this was written
from, so the delta was never computed. Whoever makes the drop does section 1 first.

## 1. Build the drop

`ship/` is the offline machine's last-received copy (gitignored). It is the only thing the delta is
computed against.

```powershell
pwsh tools/ship-delta.ps1          # list A/M/D, change nothing
pwsh tools/ship-delta.ps1 -Zip     # stage under drops/<timestamp>/ + MANIFEST.txt + .zip; carry the zip
pwsh tools/ship-delta.ps1 -Commit  # ONLY after the drop is applied offline; ship/ becomes the baseline
```

Shipped scope is `src`, `k8s`, `nugets`, `grafana/dashboards`, `kibana`, `tools/offline`, plus the
root files `Directory.Build.props`, `Directory.Packages.props`, `NuGet.config`, `SK_P.sln`,
`global.json`. StepRole-changed areas **inside** it, so the delta will list them:

- `src/Messaging.Contracts` (`StepRoles.cs`, `OutcomeTemplates.cs`, `Projections/L2ProjectionKeys.cs`) and its
  repacked `nugets/1.0.0/*.nupkg`; also repacked: `BaseApi.Core`, `BaseConsole.Core`,
  `BaseProcessor.Core`, `Messaging.Transport`. Every project's `packages.lock.json` moved with them.
- `src/BaseConsole.Core` (`StepRoleResolver`, `RedisStepRoleSource`, `IStepRoleSource`).
- `src/BaseApi.Service` (`StepRoleClassifier`, `L2ProjectionWriter`).
- `src/Orchestrator` (`WorkflowActivator`, `WorkflowFireJob`, `StepOutcomeHandler`).
- `src/Processor.Analyst` (`PanelRegistry`, `ContractPrompt`, `LivePanelReader`, `ElasticPanelSource`,
  `GraphRenderer`, `RehearsalPanels`).
- `kibana/kibana-export.ndjson`, `k8s/43-processor-analyst.yaml` (adds `Analyst__Bit__Mode`).
- `src/Messaging.Contracts/RunPositions.cs` is **deleted**. The delta reports it as `D`; removals are
  never applied without `-PruneRemoved`. Delete it on the offline tree, or the old type lingers.

Changed **outside** the scope (the delta will not list them):

- `tools/analyst-prompt-v11.txt`. It is not a file the offline side needs to run: the prompt
  travels inside the `analyst-monitor-cfg` assignment payload (section 4;
  `docs/rebuild-analyst-monitor-workflow.md` §6.1 names the file and carries the payload). Carry the
  file by hand if you want to generate the payload rather than trust the escaping.
- `docs/` (this note, the runbook, the spec, `kibana-panels-through-the-graph.md`) and
  `tools/verify-kibana-dashboard.py`. Reference only; carry whichever you want read offline.

Only the Analyst processor changes functionally (its SourceHash moves). The other processors' lock
files changed because the packages were repacked; their code did not.

## 2. Deploy order

Every step is needed. BaseApi must be first, since it is what writes the role keys.

1. **BaseApi** (`baseapi-service`): rebuild image, load it, restart. It writes
   `skp:wf:{workflowId}:step:{stepId}` (a HASH, field `role`) at each workflow start.
2. **Orchestrator** (`orchestrator`, the StatefulSet): rebuild, load, restart. It reads those keys to
   stamp StepRole on each step outcome record (the dispatch record carries none).
3. **Analyst** (`processor-analyst`): rebuild the image and load it, then do these **before** rolling
   out, so the pod never sits unready on a hash no row holds. Never create a new `analyst` row: the
   hash is unique and the assignment edges point at the existing row's id.

   ```powershell
   # pwsh, NOT powershell.exe (5.1 cannot load a .NET 8 assembly)
   dotnet build src/Processor.Analyst/Processor.Analyst.csproj
   $asm  = [Reflection.Assembly]::LoadFrom((Resolve-Path "src/Processor.Analyst/bin/Debug/net8.0/Processor.Analyst.dll"))
   $hash = ($asm.GetCustomAttributes([Reflection.AssemblyMetadataAttribute], $false) | Where-Object { $_.Key -eq 'SourceHash' }).Value
   $hash   # dev 2026-10-02: 3d5d5b59f670c5bb867ed885bb302acef9bfb2ca644a0479a69b586915c453c6 (only if the source is identical)
   ```

   Repoint the existing row (expect `UPDATE 1`):

   ```bash
   kubectl -n skp exec postgres-0 -- sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"UPDATE processors SET source_hash='<hash>', updated_at=now() AT TIME ZONE 'utc' WHERE name='analyst';\""
   ```

   Then apply the manifest (section 4: it carries the BIT mode env var; a `rollout restart` alone does
   not re-read the yaml) and roll: `kubectl -n skp rollout restart deploy/processor-analyst`, then
   `kubectl -n skp rollout status deploy/processor-analyst`. The log should show
   `resolving identity for source hash <hash>`.
4. **Restart every running workflow**, stop then start:

   ```
   POST /api/v1/orchestration/stop     body: "<workflow-id>"
   POST /api/v1/orchestration/start    body: "<workflow-id>"      (202 / 202)
   ```

   The body is the bare workflow id as a JSON string. BaseApi writes role keys only at start. A
   workflow that is not restarted has no roles: its records carry no StepRole, the Kibana funnel
   omits it, and the Analyst's run-boundaries panel reads `roleRecords 0`, which is *not
   distinguishable* (unreadable, not "not firing").

Check the keys after the restart, per workflow:

```bash
kubectl -n skp exec redis-0 -- redis-cli --scan --pattern "skp:wf:<id>:step:*"
kubectl -n skp exec redis-0 -- redis-cli HGET "skp:wf:<id>:step:<stepId>" role
```

Expect one key per step: the importer `entry`, the final step `terminal`, the rest `intermediate`.
(Dev: 10 keys for the 10-step chain.) A step dropped from a workflow loses its key at the next start.

## 3. Kibana

1. Import `kibana/kibana-export.ndjson` with `overwrite=true` (Stack Management, Saved Objects,
   Import, tick overwrite; or `POST <kibana>/api/saved_objects/_import?overwrite=true` with header
   `kbn-xsrf: true`, multipart field `file`). Dev: `success: true`, 7 objects.
2. The funnel **replaces the run-boundaries panel in place**: same saved-object id
   `skp-runposition-pie`, so nothing is orphaned. The id name is historical.
3. **Before** importing, pin the Workflow control for this stack (the export's pinned value is
   per-environment). Run from the tree root: it rewrites `kibana/kibana-export.ndjson` in place.
   Defaults are dev's offset ports, so pass the offline ones:

   ```bash
   python tools/offline/pin-workflow-control.py --workflow <name_version>      --api-url http://<baseapi-host>:<port> --redis-host <redis-host> --redis-port <redis-port>
   ```

   (`--workflow-id <id>` skips the BaseApi lookup. Defaults: `--api-url http://localhost:18080`,
   `--redis-host localhost`, `--redis-port 6380`. See `kibana/README.md`.) Do this before step 1.
4. Until the first StepRole record is indexed the funnel panel shows an
   `Unknown column [attributes.StepRole]` error. Expected, not a broken import. Once records exist,
   refresh the field list: Stack Management, Data Views, `skp-logs`, Refresh.
5. The dashboard's **Step** and **Outcome** controls do not apply to the funnel (they would filter out
   the entry record). The **Workflow** control scopes it.

## 4. Analyst

- `Analyst__Bit__Mode=StructureOnly` is in `k8s/43-processor-analyst.yaml` (container
  `processor-analyst`, Deployment `processor-analyst`, namespace `skp`). A rollout restart does not
  read the yaml, so apply it, then confirm the variable is on the pod template:

  ```bash
  kubectl apply -f k8s/43-processor-analyst.yaml
  kubectl -n skp get deploy processor-analyst -o jsonpath='{.spec.template.spec.containers[0].env}'
  ```

  (Without the manifest: `kubectl -n skp set env deploy/processor-analyst Analyst__Bit__Mode=StructureOnly`.)
  The BIT then checks the prompt's structure only; nothing is spent on the fitness gate. Apply
  before the rollout in section 2 step 3, or roll once more after it.
- Prompt v11 goes into `analyst-monitor-cfg`: `GET /api/v1/assignments/<id>`, then `PUT` it back
  with **every field resent** (`name`, `version`, `description`, `stepId`, `payload`), changing only
  the `prompt` inside `payload`. The `targetWorkflowId` and the other payload fields stay as they
  were. Dev: GET showed v9, PUT returned 200, read-back matched. Payload and escaping:
  `docs/rebuild-analyst-monitor-workflow.md` §6.1.
- Leave `analyst-monitor` **stopped** (it spends money on every fire) until the BIT is deliberately
  re-enabled (`Analyst__Bit__Mode=Full`; read Appendix D of that runbook first).

## 5. What the funnel's entry slice means

The entry slice is **records imported, plus one Cancelled record per empty poll**. It is not fires.
The split importer writes one outcome record per record it imported; a drained poll writes one.
`fires` (distinct entry correlation ids) is reported separately by the panel.

Dev verification window `endless-feed-steprole`, 2026-10-02T12:57:45Z to 13:12:45Z: 15 fires, entry
**125** (25 cycles x 5 records), intermediate 550, terminal 75, total 750 = 650 Completed + 75 Failed
+ 25 Cancelled. Graph-order step counts 125 / 125 / 100 / 75 / 25 / 50 / 50 / 50 / 75 / 75 matched the
hand-derived expectations (entry was predicted as 15 and revised once the data was read).

## 6. Known deferred items you may trip on

- `tools/verify-kibana-dashboard.py` checks 4 and 7 fail whenever the window holds empty polls (no
  empty-poll term in its per-cycle model). Checks 9 and 13 need a second running workflow with
  records or traffic on the `simple-step*` steps. Check 14 (the funnel) is the one that matters here.
- The Analyst's run-boundaries panel description and the v11 primer do not yet say the entry row
  counts items, not fires. The model may read entry as fires until the next Analyst rebuild
  (it moves the SourceHash); `fires` is reported separately.
- StepRole also appears on a third orchestrator template, the failure-routing "advancing ... their
  entry conditions accept it" record, so `roleRecords` exceeds dispatch plus outcome records. Funnel
  counts are unaffected (it selects by template).
- A fresh baseapi pod has no queue-wait points yet, so a capture or panel read right after the
  rollout can report queue-wait as not fully covered.
- Role read racing a restart can cache the pre-restart role for a moment; store faults log only at
  Debug. If a restarted workflow still shows no StepRole, check the keys (section 2) before anything else.
