# Offline drop: the StepRole change set (run edges)

`RunPosition` is gone; `StepRole` marks only the two **edges** of a workflow run: `entry` on each
"dispatched an entry step" record, and `terminal` on the branch-ends outcome record at the run's
**exit edge**: a Completed outcome no successor accepts, or any outcome of a step with **no
successors** in the workflow's graph (the second half alone until `6a492b5`, 2026-10-02). There is
no `intermediate` and there are no role keys.
Spec: `docs/superpowers/specs/2026-10-02-step-role-edges-design.md` (it supersedes the role model of
`2026-10-02-step-role-design.md`). Commits `0688b06..dc4fa54` (the first StepRole model) and
`c105f8a..ad5311b` (the edges model) on `feature/path-importer`; an offline tree that never received
the first model takes both in one drop. Every command below was run on dev on 2026-10-02.

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

- `src/Messaging.Contracts` (`StepRoles.cs` -- `entry`/`terminal` only, `OutcomeTemplates.cs`,
  `Projections/L2ProjectionKeys.cs` -- the role key and field are gone) and its repacked
  `nugets/1.0.0/*.nupkg`; also repacked: `BaseApi.Core`, `BaseConsole.Core`, `BaseProcessor.Core`,
  `Messaging.Transport`. Every project's `packages.lock.json` moved with them.
- `src/BaseApi.Service` (`L2ProjectionWriter`: writes no role keys).
- `src/Orchestrator` (`WorkflowActivator`, `WorkflowFireJob` -- stamps `entry` after a successful
  send; `StepOutcomeHandler` -- stamps `terminal` from the result and the L1 graph it already holds).
- `src/Processor.Analyst` (`PanelRegistry`, `ContractPrompt`, `ElasticPanelSource`, `RehearsalPanels`; for the operator role also the config and finding contracts, the run context and the `failure-causes` panel).
- `kibana/kibana-export.ndjson` (the run-edges pie), `k8s/43-processor-analyst.yaml` (adds
  `Analyst__Bit__Mode`).
- **Deleted** (the delta reports them as `D`; removals are never applied without `-PruneRemoved`, so
  delete them on the offline tree or the old types linger): `src/Messaging.Contracts/RunPositions.cs`,
  `src/BaseApi.Service/Features/Orchestration/Projection/StepRoleClassifier.cs`,
  `src/BaseConsole.Core/Naming/IStepRoleSource.cs`, `RedisStepRoleSource.cs`, `StepRoleResolver.cs`.

Changed **outside** the scope (the delta will not list them):

- `tools/analyst-prompt-v14.txt` (v13 until the operator role; v12 before the exit-edge rule). It is not a file the offline side needs to run: the prompt
  travels inside the `analyst-monitor-cfg` assignment payload (section 4;
  `docs/rebuild-analyst-monitor-workflow.md` §6.1 names the file and carries the payload). Carry the
  file by hand if you want to generate the payload rather than trust the escaping.
- `docs/` (this note, the runbook, the spec, `kibana-panels-through-the-graph.md`) and
  `tools/verify-kibana-dashboard.py`. Reference only; carry whichever you want read offline.

Functionally, three images change: BaseApi (stops writing role keys), the orchestrator (stamps both
edges) and the Analyst (its SourceHash moves). The other processors' lock files changed because the
packages were repacked; their code did not.

## 2. Deploy order

**Analyst operator role (2026-10-03) adds two schema rows and changes the Analyst's order.** A schema
definition is frozen once a processor references it, so the new contract is two NEW rows and a
repoint, never an edit. On a stack that has `analyst-config` 1.0.0 and `analyst-finding` 3.0.0, do
this in order (the analyst steps below come after BaseApi and the orchestrator):

1. **Schema rows** -- `POST /api/v1/schemas` for `analyst-config` **2.0.0** (adds the optional
   `expectations` object) and `analyst-finding` **4.0.0** (per-insight `classification`, `domain`,
   `severity`, `onset`, `evidenceKinds`; severity tied to classification). Send the `definition`
   from `src/tests/BaseApi.Tests/Schemas/analyst-config.json` / `analyst-finding.json`
   (runbook §2.1/§2.2). Dev ids: config `4a203429-8379-42fb-a674-c4242bb37619`, finding
   `ebc7e9d3-b02c-4e62-bb02-fb86464793d9` -- yours will differ. Record both.
2. **Processor PUT** -- `PUT /api/v1/processors/<analyst id>` with every field resent, changing only
   `sourceHash` (the new hash below), `outputSchemaId` (the 4.0.0 id) and `configSchemaId` (the
   2.0.0 id). This replaces the psql repoint in step 3 below for this release, because the schema
   ids change too.
3. **Image** -- `docker build`, load it into the cluster.
4. **Rollout** -- `rollout restart` and `rollout status`; both pods log
   `resolving identity for source hash <hash>` and `all schema definitions resolved; ... output=<4.0.0 id> config=<2.0.0 id>`.
5. **Assignment** -- only now `PUT` `analyst-monitor-cfg` (§4): prompt v14, `failure-causes`
   appended to `panelSet`, and the `expectations` object. Do it last: a v14 payload against the
   old config schema is refused (`additionalProperties: false`, unknown panel), and the old payload
   is accepted by the new one. Leave `analyst-monitor` stopped.

Dev 2026-10-03: SourceHash `5bc08070360770437ab1850df75d6759a5944253ef7c1ae5cfa5c6959f3d3f5b`
(operator role, prompt v14, BIT rehearsal wall clock 1200; was `87e91aad...`, before that
`45f49c4e...`), valid only if the Analyst source is identical. The v14 payload carries
`wallClockSeconds: 1200`.

**Order no longer matters for roles.** BaseApi writes no role keys and nothing reads them: the
orchestrator decides both edges itself, `entry` when it dispatches and `terminal` from the workflow's
L1 graph, which it loads at start like every other step fact. Rebuild, load and restart each of:

1. **BaseApi** (`baseapi-service`).
2. **Orchestrator** (`orchestrator`, the StatefulSet).
3. **Analyst** (`processor-analyst`): rebuild the image and load it, then do these **before** rolling
   out, so the pod never sits unready on a hash no row holds. Never create a new `analyst` row: the
   hash is unique and the assignment edges point at the existing row's id.

   ```powershell
   # pwsh, NOT powershell.exe (5.1 cannot load a .NET 8 assembly)
   dotnet build src/Processor.Analyst/Processor.Analyst.csproj
   $asm  = [Reflection.Assembly]::LoadFrom((Resolve-Path "src/Processor.Analyst/bin/Debug/net8.0/Processor.Analyst.dll"))
   $hash = ($asm.GetCustomAttributes([Reflection.AssemblyMetadataAttribute], $false) | Where-Object { $_.Key -eq 'SourceHash' }).Value
   $hash   # dev 2026-10-02 (exit-edge rule, v13): 45f49c4ede1ec334aee3bbe87276b372c0eedfd419725a910ecc8d3d80067e82 (only if the source is identical)
   ```

   Repoint the existing row (expect `UPDATE 1`):

   ```bash
   kubectl -n skp exec postgres-0 -- sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"UPDATE processors SET source_hash='<hash>', updated_at=now() AT TIME ZONE 'utc' WHERE name='analyst';\""
   ```

   Then apply the manifest (section 4: it carries the BIT mode env var; a `rollout restart` alone does
   not re-read the yaml) and roll: `kubectl -n skp rollout restart deploy/processor-analyst`, then
   `kubectl -n skp rollout status deploy/processor-analyst`. The log should show
   `resolving identity for source hash <hash>`.

**No workflow restart is needed for StepRole.** A running workflow's next fire after the orchestrator
rollout already carries both edges (dev: the first fire after the rollout, 17:54:00Z, wrote `entry`
on its dispatch). The orchestrator restart reloads L1 from the start-time projection, which is all the
`terminal` test needs. (Restart a workflow only for what always needed it, such as an assignment edit.)

### One-time cleanup of the old role keys

A stack that ran the first StepRole model holds `skp:wf:{workflowId}:step:{stepId}` hashes (field
`role`) that nothing reads any more. Remove them once, after the rollout. **List first** and delete
only if every key has exactly that shape:

```bash
kubectl -n skp exec redis-0 -- redis-cli --scan --pattern 'skp:wf:*:step:*'
kubectl -n skp exec redis-0 -- sh -c "redis-cli --scan --pattern 'skp:wf:*:step:*' | xargs -r redis-cli DEL"
kubectl -n skp exec redis-0 -- redis-cli --scan --pattern 'skp:wf:*:step:*'   # expect nothing
```

Dev 2026-10-02: ten keys, all `skp:wf:1a56b3ca-...:step:<guid>` (the 10-step chain), `(integer) 10`,
then nothing. If the listing holds anything that is not `skp:wf:<guid>:step:<guid>`, stop: the
pattern has matched something else. Use the offline Redis exec/port for your stack. A stack that
never ran the first model has no such keys and skips this.

## 3. Kibana

1. **Before** importing, pin the Workflow control for this stack (the export's pinned value is
   per-environment). Run from the tree root: it rewrites `kibana/kibana-export.ndjson` in place.
   Defaults are dev's offset ports, so pass the offline ones:

   ```bash
   python tools/offline/pin-workflow-control.py --workflow <name_version>      --api-url http://<baseapi-host>:<port> --redis-host <redis-host> --redis-port <redis-port>
   ```

   (`--workflow-id <id>` skips the BaseApi lookup. Defaults: `--api-url http://localhost:18080`,
   `--redis-host localhost`, `--redis-port 6380`. See `kibana/README.md`.)
2. Import `kibana/kibana-export.ndjson` with `overwrite=true` (Stack Management, Saved Objects,
   Import, tick overwrite; or `POST <kibana>/api/saved_objects/_import?overwrite=true` with header
   `kbn-xsrf: true`, multipart field `file`). Dev: `success: true`, 7 objects, every one `overwrite: true`.
3. The run-edges pie **replaces the run-boundaries panel in place**: same saved-object id
   `skp-runposition-pie` (title "Run edges — entry dispatches and terminal outcomes"), so nothing is
   orphaned. The id name is historical.
4. On a stack that never indexed a StepRole record, the pie shows an
   `Unknown column [attributes.StepRole]` error until the first one is indexed. Expected, not a broken
   import. Once records exist, refresh the field list: Stack Management, Data Views, `skp-logs`,
   Refresh. (Dev already had the field from the first model; no refresh was needed.)
5. The dashboard's **Step** and **Outcome** controls do not apply to the pie (they would filter out
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
- Prompt v14 goes into `analyst-monitor-cfg` (v13 before the operator role, v12 before the exit-edge rule; a v12 Analyst reads the
  new `terminal` rows under the old meaning, so ship v13 with the orchestrator): `GET /api/v1/assignments/<id>`, then `PUT` it back
  with **every field resent** (`name`, `version`, `description`, `stepId`, `payload`), changing the
  `prompt` inside `payload`, appending `failure-causes` to `panelSet` and adding `expectations`
  (`{"maxFailedShare": 0.65, "maxCancelledShare": 0.25, "reason": "dev endless feed: 3 of every 5 files are built to fail, 1 to be cancelled"}` on dev -- size it to your own feed or omit it). The `targetWorkflowId` and the other payload fields stay as they
  were. Dev: GET showed v11, PUT returned 200, read-back matched v12 with every other field equal; 2026-10-03 the same procedure took v13 to v14, read-back equal in every other field.
  Payload and escaping: `docs/rebuild-analyst-monitor-workflow.md` §6.1.
- Leave `analyst-monitor` **stopped** (it spends money on every fire) until the BIT is deliberately
  re-enabled (`Analyst__Bit__Mode=Full`; read Appendix D of that runbook first). If it is running when
  the payload changes, it needs a stop/start to read the new prompt.

## 5. What the edges mean (the pie and the run-boundaries panel)

- **`entry`** counts dispatches: one record per entry step a fire sent work to, written only after a
  successful send. With one entry step it equals fires. A drained (empty) poll is still a fire and
  still has its `entry` record.
- **`terminal`** counts outcome records at the run's **exit edge**, by its position in the graph: a
  **Completed** outcome that no successor accepts, or **any** outcome of a step with **no
  successors**. A Failed or Cancelled outcome that ends its branch at a step *with* successors writes
  no `terminal` record. **On the filefetcher-archiveexpander chain the exit edges are split-exporter
  and export-outcome**: good items end at split-exporter with Completed (its only successor accepts
  Failed) -- two terminal records per good item, because the sample normalizer forks -- and failed
  items end at export-outcome via record-outcome. Cancellations at sk-normalizer-sample and empty
  polls at split-importer are not terminal.
- **A missing `terminal` alone is not a stall.** A window whose items are all cancelled has no
  `terminal`. A stall is judged from `step-outcomes` (completed/failed/cancelled totals) and
  `step-failures` against `recordsImported` and the routing in the running graph, with `terminal` as
  one more count the routing must explain.
- Until `6a492b5` (deployed 2026-10-02 evening) `terminal` was stamped only on steps with no
  successors, so older records show failures only on this chain.
- The pie (inner ring by StepRole, outer ring by step, metric `records`) counts every StepRole record
  of the fires that entered in the selected range. The Analyst's `run-boundaries` value is
  `{totalWorkflowRecords, fires, importerPolls, pollsThatImported, drainedPolls, recordsImported,
  byStep:[{role, step, records}]}`; `roleRecords` and `intermediate` are gone.

Dev verification window `endless-feed-edges`, 2026-10-02T17:58:45Z to 18:13:45Z (the first window
after the edges rollout; feed `--start-serial 232 --cycles 30`): 15 fires, 15 polls, 125 records
imported (25 cycles). Edges: `entry` **15** (split-importer), `terminal` **75** (export-outcome, 3 per
cycle). Both were written down from the feed and the graph before the data was read, and both
matched. Without StepRole the same window shows 25 Cancelled branch-ends at sk-normalizer-sample and
50 Completed branch-ends at split-exporter, neither stamped. Totals 750 = 650 Completed + 75 Failed
+ 25 Cancelled. On orchestrator records StepRole appeared only on "dispatched an entry step"
(`entry`) and on export-outcome's branch-ends (`terminal`).

## 6. Known deferred items you may trip on

- `tools/verify-kibana-dashboard.py` checks 4 and 7 fail whenever the window holds empty polls (no
  empty-poll term in its per-cycle model). Checks 9 and 13 need a second running workflow with
  records or traffic on the `simple-step*` steps.
- A fresh baseapi pod has no queue-wait points yet, so a capture or panel read right after the
  rollout can report queue-wait as not fully covered.
- Records written before the edges rollout (on dev, the older model ran until the 2026-10-02 17:52Z
  rollout) carry the old values: `entry` sat on the importer's OUTCOME records (one per record
  imported plus one per empty poll), not on dispatches; `intermediate` sat on every other step's
  outcome records, record-outcome included; `terminal` sat on export-outcome's outcomes; and roles
  also appeared on "advanced ..." lines. So `entry` changes meaning across the rollout (125 vs 15 in
  comparable windows: records imported vs dispatches). A range that spans the rollout mixes the two
  models; read the pie and the panel only for windows after it.
- One fire may be skipped while the orchestrator StatefulSet rolls ("the projection store is
  unusable; this fire dispatches nothing"). That is a rollout artifact, not a fault.
