# Next task: enrich the workflow read path

Pick this up after a context clear. Everything below is verified, and the tree is clean at
`46a4e4e`.

## The task

`WorkflowReadDto.EntryStepIds` and `.AssignmentIds` are always `null` on every read. Fix them the
same way `StepReadDto.NextStepIds` was just fixed in `46a4e4e`.

## Why they are null

`WorkflowEntity` has no property for either collection — they live in the junction tables
`workflow_entry_steps` and `workflow_assignments`. `WorkflowReadDto` is a positional record, so both
are *required* constructor parameters; the mapper has no source for them and cannot omit them, so
`WorkflowEntityMapper` hard-codes `null` via `[MapValue(...)]` just to compile. The mapper is not
discarding anything — it was never given the data.

## Why it matters

Not cosmetic. `BaseService` returns through the same `ToRead` on **Create and Update** as well as
Get and List, so a `POST /workflows` that supplies `assignmentIds` echoes back `null` for the field
it just persisted. That reads as the input having been dropped, and the natural response is to retry
— which duplicates the workflow, because `workflows` has no unique constraint on `name`. The live
database had **five** `v8-fanout-proof` rows sharing one graph before cleanup, which is what that
mistake looks like.

Update is also remove-and-replace, so read-modify-write is destructive while the read returns null.

## The pattern to copy

`46a4e4e` added `BaseService.EnrichReadAsync` — the read-side counterpart to the existing
`SyncJunctionsAsync` — applied at all four `ToRead` call sites, and running *after* `SaveChanges` on
the write verbs so it reports committed state rather than echoing the request.

Copy `StepService.EnrichReadAsync` (`src/BaseApi.Service/Features/Step/StepService.cs`) into
`WorkflowService`, with two junction queries instead of one:

- `WorkflowEntrySteps` → `EntryStepIds`
- `WorkflowAssignments` → `AssignmentIds`

Batch both by workflow id — one query each for the whole page, not per row. Return empty lists
rather than null for a workflow with none, matching the step decision: `null` used to mean "not
populated", so leaving it keeps the field ambiguous exactly where it becomes meaningful.

`WorkflowGraphLoader.LoadL1Async` Stage 4 already does this enrichment for the orchestration path
(`dto with { EntryStepIds = entry, AssignmentIds = asg }`) — same shape, different call site.

## Tests

Mirror `src/tests/BaseApi.Tests/Orchestration/StepReadEnrichmentTests.cs`. It uses
`Microsoft.EntityFrameworkCore.InMemory` (already referenced by the test project) with a real
`AppDbContext` and a real `WorkflowService`, no substitutes. The load-bearing test is the last one:
read a workflow, feed the response straight back into an update, and assert the bindings survive.
That is the regression this prevents — with `null` reads, that sequence silently deletes every
binding and returns 200.

Expect the tests to fail first; they did for the step change.

## Verifying on the cluster

The stack is deployed and healthy. After the change:

```bash
docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .
kind load docker-image baseapi-service:local --name desktop
kubectl -n skp rollout restart deploy/baseapi-service
kubectl -n skp rollout status deploy/baseapi-service
kubectl -n skp port-forward svc/baseapi-service 18080:8080 &
curl -s http://localhost:18080/api/v1.0/workflows
```

Expect `entryStepIds` with 1 id and `assignmentIds` with 10 on the single `v8-fanout-proof` row.
Cross-check against Postgres:

```bash
kubectl -n skp exec sts/postgres -- psql -U postgres -d stepsdb -t -A -c \
  "select (select count(*) from workflow_entry_steps), (select count(*) from workflow_assignments);"
```

Delete this file once the work is done.
