# SKP Studio plan 8: design on virtual entities, save by store + dry run + align Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The studio designs offline on virtual copies of a workflow's entities (GETs only, no validate, no write while designing); **Save** sends the whole design to a new `PUT /workflows/{id}/design`, which always stores it on the workflow row, then dry-runs it through ordered stages in one transaction collecting every error, and aligns the real entities only when there is none. Wires may be dropped anywhere: cycles are allowed, and a wire released where it attaches to nothing becomes a grey dashed **loose wire** with an open end, kept in the layout.

**Architecture:** BaseApi gains a nullable jsonb `Design` column (returned by `GET /graph`) and `Features/Workflow/Design/`: request/outcome DTOs, a field applier that reuses the CRUD update DTOs, validators and mappers, a store seam (`ExecuteUpdateAsync`, its own commit, no audit stamp) and a transaction seam (one transaction, one savepoint per entity), and `WorkflowDesignSyncer`, which runs seven stage classes in order. The studio's design is the plan 4 `Draft` (canvas, undo history; gains loose wires) plus `EntityEdits` (Inspector edits, assignment operations, schema copies). The base document comes from GETs; the stored design is parsed from `graph.design` and the layout; the session keeps unsaved edits; `applyDesign` lays it all over the base. `app/saveDesign.ts` builds the request, sends it, reloads with GETs and fills Problems and Output.

**Tech Stack:** .NET 8, EF Core 8 (Npgsql 8, jsonb), FluentValidation, Riok.Mapperly, xUnit v3 on Microsoft.Testing.Platform, EF InMemory (hermetic) and the kind RealStack (Postgres, over HTTP); React 19, @xyflow/react 12, TypeScript 5.9, Vitest + Testing Library (jsdom), Playwright (Chromium). Studio in `src/WorkflowStudio`.

**Spec:** `docs/superpowers/specs/2026-10-07-skp-studio-08-virtual-design-design.md` (read it first; it wins over this plan on behaviour). Parents where it refers to them: `2026-10-05-skp-studio-design.md` §4, §6.1, §7.1; `2026-10-07-skp-studio-04-canvas-designer-design.md` §3.5, §4.4-§4.6, §5; `2026-10-07-skp-studio-07-junctions-design.md` §4, §6.1a.

## Decisions made in this plan

The spec leaves these open; each is decided here and should be shown to the user.

1. **Request shape.** `PUT /workflows/{id}/design` takes `{ workflow, steps, processors, caches, schemas, assignments, layout }`. Every entity carries a `fields` map of only the changed fields, keyed by the CRUD DTO's camelCase name (`name`, `cronExpression`, `entryCondition`, …) with a JSON value (text, number or null). Owned entities carry `updatedAt` (the loaded stamp). `workflow` also carries `entryStepIds` / `cacheIds` (null: unchanged); a step carries `nextStepIds` (null: unchanged); a processor carries `slots: { input|output|config: copyId }` (the re-points); `schemas` are the copies (`id, name, version, description, definition`); an assignment is `{ op: create|update|delete, id, stepId, updatedAt, fields }` with a studio-made id on create. The answer is `{ applied, errors: [{ kind, id, stage, field, message }] }`.
2. **What `Design` holds.** The body **without** its layout (the layout goes to `Layout`), serialized camelCase with nulls omitted. Null when the real entities hold the design.
3. **Store.** `ExecuteUpdateAsync` on `Design` and `Layout`: its own commit, no conflict check, and it never moves the workflow's `updatedAt` (the audit interceptor does not see it), so the workflow stage's conflict check still compares against what the designer loaded. Behind `IDesignStore`; the hermetic harness writes through a second InMemory context with no interceptor.
4. **Dry run.** One `BeginTransactionAsync`; every entity is one unit: savepoint, load, conflict check, apply `fields` over the update DTO built from the entity, the CRUD validator, map, one `SaveChangesAsync`, release; a validation or conflict failure rolls back to the savepoint without saving, a `DbUpdateException` is caught there and described with `PostgresExceptionMapper`. The change tracker is cleared after every unit. Any error: roll back, answer the errors; none: empty `Design` inside the transaction, commit. Behind `IDesignTransactions`; the hermetic harness passes through (InMemory has no transactions), and the Postgres live tests prove the rollback.
5. **Conflicts once per owned entity.** Stage 4 checks every step in the body (also wiring-only ones); stage 5 never re-checks (stage 4 moved the stamp). The workflow is checked in stage 7. A missing stamp on an owned entity is a conflict. A step that failed stage 4 has its wires skipped with their own error. Assignment update and delete check their stamp.
6. **400 vs entity errors.** A malformed body (layout missing / not an object / too big, duplicate or empty ids, two assignment operations for one step, an unknown op, an unknown slot, a slot naming a copy the body does not carry) is a 400 before anything is stored. An unknown field name or a value of the wrong type is an error on that entity.
7. **Studio design model.** `Design = { draft: Draft; edits: EntityEdits }`. The `Draft` keeps the plan 4 undo history and gains `loose`; `EntityEdits` (workflow, steps, processors, caches: `{ updatedAt, fields }`; assignments by step: one op; schema copies by `processorId:slot`) is outside the undo history. The **base document** carries no wire shapes: the layout's `routes` and `loose` belong to the **stored design**, so Reset route on a stored shape works. The stored design is `storedDesignOf(graph.design, graph.layout)`; dirty = the design differs from it (canonical JSON); **Save is enabled** when dirty or when the stored design still holds graph changes not yet applied.
8. **Layout `parked` lists every step on the canvas.** `GET /graph` returns only steps reachable in the real graph; after a stored-but-not-applied design wires steps in or out, every canvas step must still be found, so the studio writes all step ids there (the loader skips the reachable ones as today). Unwired steps keep their internal name `parkedIds` but no longer look parked.
9. **After every Save answer the document reloads with GETs** (applied or not): the canvas then shows the stored design exactly as reopening would; a reload that fails keeps the sent design as the stored one and says so in Output.
10. **Inspector.** No per-entity Save and no navigation guard (edits live in the design, so moving away loses nothing); Revert drops the shown entity's edits; **＋ Create** makes a virtual assignment at once (name `{step}-assignment`, `1.0.0`, payload `{}`) and drills into it; **Remove** needs no dialog and checks no other workflow; an empty schema slot offers **＋ Define** (a copy named `<processor>-<slot>`, `1.0.0`, definition `{}`). The capsule's single dirty mark is "● design draft"; closing a dirty document asks **Save / Discard / Cancel**.
11. **Loose wires.** `{ source, end }` by a new id in `draft.loose`; routed from the source's port to the open end; drawn by `CableEdge` as edge `loose:{id}` (grey dashed, a ring at the source, an open circle at the end; the hub gains a hidden `loose` target handle). The open circle is always draggable: onto a step it may wire to it becomes an ordinary wire, anywhere else its end moves, back on its own source it snaps back. A loose wire is picked by a click and removed by Delete. **A released tail never becomes loose**: it snaps back (see the spec gap below). Over a line, a new wire or a loose end ignores lines.
12. **Drop verdicts.** `canWire` → `ok | self | loose` (no cycle check; a duplicate, a cache, the hub as a target → `loose`); `canJoin` → `ok | sameWire | loose` (another colour or a host loop → `loose`). Labels: `self` "same step", `sameWire` "same wire", `loose` "loose wire" (grey), `start` "start stays on a block". The labels "would make a loop", "other colour", "already wired", "not a step" and "drop on a step" are gone.
13. **API types are regenerated** with `npm run gen:api` (the offline Swashbuckle CLI, as plan 1/1b did); `src/api/types.ts` adds aliases.
14. **Output** is a per-page log in the store (not kept in the session): one line per Save answer or failed Save.

## Global Constraints

- **Nothing is written while designing.** Opening a workflow is GETs only (`/workflows/{id}/graph`, `/steps/{id}`, `/processors/{id}`, `/schemas/{id}`); no `POST /validate` anywhere in the studio. The live polls (`GET /orchestration/live`, `GET /processors/liveness`) stay (superseded 2026-10-10: pushed by the liveness hub, polled only as the fallback; studio spec §6.4). The only write the studio sends is `PUT /workflows/{id}/design`, on Save.
- **`PUT /workflows/{id}/graph` and `POST /workflows/{id}/validate` stay as they are** in BaseApi (nothing in this plan changes them).
- **Stage order** (exact names, used in `errors[].stage`): `schemas`, `processors`, `caches`, `steps`, `wires`, `assignments`, `workflow`. Error `kind` values: `schema`, `processor`, `cache`, `step`, `assignment`, `workflow`.
- **Only the CRUD field rules decide a failure** (the existing validators: `SchemaCreateDtoValidator`, `ProcessorUpdateDtoValidator`, `CacheUpdateDtoValidator`, `StepUpdateDtoValidator`, `AssignmentCreateDtoValidator`, `AssignmentUpdateDtoValidator`, `WorkflowUpdateDtoValidator` incl. "at least one entry step"), plus database constraints. No cycle, schema-edge, payload or liveness check. No validator changes.
- **Owned** (workflow, steps, assignments): conflict message exactly `changed by someone else since you opened it`. **Shared** (processors, caches): no conflict check.
- **Schema copy** keeps the original's name and version (no patch bump); an empty slot's copy is `<processor>-<slot>` / `1.0.0`.
- **Answer:** `200 { applied, errors }` (`applied` exactly when `errors` is empty); malformed body `400`; unknown workflow `404`.
- **Mapperly diagnostics are errors:** a new `WorkflowEntity` property needs ignores on `ToEntity`, `Update` and `ToRead`. Private fields are `_camelCase`. `BaseApi.Core` (a NuGet package) is not modified.
- **BaseApi test commands** (from the repo root, PowerShell; **never `dotnet test`**, it hides which tests failed): build `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`; one class `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "<FQN>"` (fully qualified: a bare name matches zero tests and exits 0); hermetic suite `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"`. Live tests need `$env:SKP_REALSTACK='1'` and `./k8s/port-forward-realstack.ps1` running (BaseApi on `localhost:18080`).
- **Studio commands** (PowerShell in `src/WorkflowStudio`): `npx vitest run <path>`, `npx tsc -b` (then delete `tsconfig.tsbuildinfo`), `npx playwright test <spec>`. Run npm scripts from PowerShell (Git Bash `npm run` prints nothing).
- **Deploying restarts the shared dev cluster: ask the user first** (BaseApi in Task 7, the studio in Task 16). The kind cluster is named `desktop`.
- **Every user-visible behaviour is verified with Playwright using a real mouse and keyboard**, on the dev server and on the deployed studio (memory `verify-studio-ui-with-playwright`). Save tests write only to a throwaway workflow they create and delete through BaseApi's CRUD (spec §8).
- **A refresh keeps everything** (memory `studio-refresh-keeps-everything`): unsaved design edits, Inspector trail, documents and dock come back.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Failure modes the spec implies but none of its listed tests catch; each is pinned by a test in the owning task.

1. **The store step moving the workflow's `updatedAt`.** A tracked update would let the audit interceptor stamp the row, and every later workflow stage would fail its own conflict check. Pinned in Task 3 (`StoringDoesNotMoveTheWorkflowsUpdatedAt`) and Task 6 (`AWorkflowChangeWithTheLoadedStampAppliesAfterTheStore`).
2. **A step whose fields and wiring both change conflicting with itself.** Stage 4 moves the step's stamp; a second check in stage 5 would refuse it. Pinned in Task 5 (`FieldsAndWiringOnTheSameStepApplyWithoutConflictingWithThemselves`).
3. **A refresh losing unsaved edits to the stored design.** The session restores the design before the graph arrives; `loaded` must keep it instead of replacing it with the stored one. Pinned in Task 11 (`a restored document keeps its session design when it loads`).
4. **Discard design going back to the real entities instead of the stored design.** Discard must return to what was last saved (spec §3.2), not to an empty design. Pinned in Task 11 (`Discard design returns to the stored design, not to nothing`).
5. **A loose wire reaching the graph.** A loose wire must never appear in any step's `nextStepIds` or the entry list sent on Save (spec §6.4), and must come back from the layout. Pinned in Task 13 (`never sends a loose wire as a next step, and keeps it in the layout`).

---

## File structure

**BaseApi** (`src/BaseApi.Service/`)
- `Features/Workflow/WorkflowEntity.cs`, `WorkflowEntityMapper.cs`, `Persistence/Configurations/WorkflowEntityConfiguration.cs`, `Persistence/Migrations/<stamp>_AddWorkflowDesign.cs` (+ Designer, snapshot) — the `Design` column.
- `Features/Workflow/Graph/WorkflowGraphDtos.cs`, `WorkflowGraphReader.cs` — `GET /graph` returns `design`.
- `Features/Workflow/Design/` (new):
  - `WorkflowDesignDtos.cs` — request, outcome, error DTOs.
  - `DesignFields.cs` — `FieldError`, field appliers over the CRUD update DTOs, `UpdateOf(entity)`, `FieldOf(name)`.
  - `DesignShape.cs` — the 400 checks.
  - `DesignPersistence.cs` — `IDesignStore` + `RelationalDesignStore`, `IDesignTransactions` / `IDesignTransaction` + `RelationalDesignTransactions`.
  - `DesignRun.cs` — one save's state, `UnitAsync` (savepoint per entity), `IDesignStage`.
  - `IWorkflowDesignSyncer.cs`, `WorkflowDesignSyncer.cs` — store, then the stages.
  - `SharedStages.cs` — `SchemaStage`, `ProcessorStage`, `CacheStage`.
  - `StepStages.cs` — `StepStage`, `WireStage`.
  - `OwnedStages.cs` — `AssignmentStage`, `WorkflowStage`.
  - `DesignStages.cs` — the ordered list for DI.
- `Features/Workflow/WorkflowController.cs` — `PUT {id}/design`; `WorkflowServiceCollectionExtensions.cs` — registrations.

**BaseApi tests** (`src/tests/BaseApi.Tests/`)
- `WorkflowGraph/GraphHarness.cs` (shared InMemory root, `Syncer`, `CacheAsync`), `WorkflowGraph/DesignBody.cs`, `WorkflowGraph/WorkflowDesignColumnTests.cs`, `DesignFieldsTests.cs`, `DesignShapeTests.cs`, `WorkflowDesignSyncerTests.cs`, `DesignSharedStagesTests.cs`, `DesignStepStagesTests.cs`, `DesignOwnedStagesTests.cs`; `WorkflowGraphControllerTests.cs`, `WorkflowLayoutTests.cs` (constructor); `Live/WorkflowDesignLiveTests.cs`.

**Studio** (`src/WorkflowStudio/`)
- `openapi/baseapi.v1.json`, `src/api/schema.d.ts` (regenerated), `src/api/types.ts`, `src/api/client.ts` (`saveDesign`, no `validate`), `src/api/toModel.ts`, `src/model/graph.ts` (`Graph.design`, `Assignment.updatedAt`, `DesignError`; no `WorkflowProblem`).
- `src/design/ids.ts` (new) — `newId`.
- `src/design/design.ts` (new) — `EntityEdits`, `Design`, edit operations, `storedDesignOf`, `sameDesign`, `hasGraphChanges`, `parseEdits`.
- `src/design/layoutDesign.ts` (new) — `layoutOf` (the layout Save writes).
- `src/design/draft.ts` — `loose`, `addLoose`, `moveLoose`, `removeLoose`, `attachLoose`, `loosen`, `LOOSE_PREFIX`.
- `src/design/apply.ts` — `applyEdits`, `applyDesign`; loose routes.
- `src/layout/wires.ts` — `LooseWire`, `LooseRoute`, `routeLoose`.
- `src/app/document.ts` (no `problems`; `loose`), `src/app/loadDocument.ts` (no validate), `src/app/fixtures.ts`.
- `src/store/studioState.ts`, `src/store/inspector.ts`, `src/store/inspectorTarget.ts`, `src/store/errorTarget.ts` (new; replaces `problemTarget.ts`), `src/app/session.ts`.
- `src/app/inspectorService.ts` (reads + design edits), `src/panels/Inspector.tsx`, `src/panels/inspectorView.ts`.
- `src/app/saveDesign.ts` (new), `src/panels/Problems.tsx`, `src/panels/Output.tsx` (new), `src/panels/PaneNote.tsx`, `src/app/CapsuleToolbar.tsx`, `src/app/DocumentPanel.tsx`, `src/App.tsx`, `src/app/studioActions.ts`.
- `src/design/rules.ts`, `src/design/useWireGestures.ts`, `src/design/DesignContext.ts`, `src/design/DesignOverlay.tsx`, `src/design/useDesignKeys.ts`, `src/canvas/WorkflowCanvas.tsx`, `src/canvas/selection.ts`, `src/canvas/toFlow.ts`, `src/canvas/edges/CableEdge.tsx`, `src/canvas/Legend.tsx`, `src/canvas/nodes/StepNode.tsx`, `src/canvas/art.css`, `src/canvas/canvas.css`.
- `e2e/studio.ts`, `e2e/throwaway.ts`, `e2e/save.spec.ts` (new), `e2e/inspector.spec.ts`, `e2e/designer.spec.ts`.

---

### Task 1: The `Design` column, and `GET /graph` returns it

**Files:**
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowEntity.cs:65` (after `Layout`)
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowEntityMapper.cs:37,49,58`
- Modify: `src/BaseApi.Service/Persistence/Configurations/WorkflowEntityConfiguration.cs:30-33`
- Create: `src/BaseApi.Service/Persistence/Migrations/<stamp>_AddWorkflowDesign.cs` (EF-generated, with Designer and snapshot)
- Modify: `src/BaseApi.Service/Features/Workflow/Graph/WorkflowGraphDtos.cs:57-70`, `WorkflowGraphReader.cs:25-55`
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowDesignColumnTests.cs`

**Interfaces:**
- Produces: `WorkflowEntity.Design` (`string?`, column `design`, `jsonb`, nullable); `WorkflowGraphDto.Design` (`JsonElement?`, last parameter, after `Layout`).

- [ ] **Step 1: Write the failing tests** (`src/tests/BaseApi.Tests/WorkflowGraph/WorkflowDesignColumnTests.cs`)

```csharp
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8: the studio's stored design lives on the workflow row and comes back with the graph.</summary>
public sealed class WorkflowDesignColumnTests
{
    [Fact]
    public async Task DesignIsANullableJsonbColumn()
    {
        await using var h = new GraphHarness();
        var property = h.Db.Model.FindEntityType(typeof(WorkflowEntity))!.FindProperty(nameof(WorkflowEntity.Design))!;

        Assert.True(property.IsNullable);
        Assert.Equal("jsonb", property.GetColumnType());
    }

    [Fact]
    public void NoCrudDtoCarriesTheDesign()
    {
        Assert.DoesNotContain(typeof(WorkflowReadDto).GetProperties(), p => p.Name == nameof(WorkflowEntity.Design));
        Assert.DoesNotContain(typeof(WorkflowUpdateDto).GetProperties(), p => p.Name == nameof(WorkflowEntity.Design));
    }

    [Fact]
    public async Task TheGraphReadReturnsTheStoredDesignAndNullWhenThereIsNone()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        Assert.Null((await h.Reader.ReadAsync(wf, h.Ct)).Design);

        var row = await h.Db.Workflows.SingleAsync(w => w.Id == wf, h.Ct);
        row.Design = """{"steps":[]}""";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        Assert.Equal(0, graph.Design!.Value.GetProperty("steps").GetArrayLength());
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `'WorkflowEntity' does not contain a definition for 'Design'`.

- [ ] **Step 3: Add the property, the mapper ignores and the column type**

`WorkflowEntity.cs`, after the `Layout` property:

```csharp
    /// <summary>
    /// The SKP Studio's stored design (plan 8) as JSON, or null when the real entities hold the design.
    /// <para>
    /// It is the last <c>PUT /workflows/{id}/design</c> body without its layout (the layout goes to
    /// <see cref="Layout"/>), stored whether or not the design could be applied, and emptied in the same
    /// transaction that applies it. The server reads it only to return it; last write wins.
    /// </para>
    /// <para>Like <see cref="Layout"/>, it is absent from every DTO.</para>
    /// </summary>
    public string? Design { get; set; }
```

`WorkflowEntityMapper.cs`: under `[MapperIgnoreTarget(nameof(WorkflowEntity.Layout))]` on **both** `ToEntity` and `Update` add `[MapperIgnoreTarget(nameof(WorkflowEntity.Design))]`; under `[MapperIgnoreSource(nameof(WorkflowEntity.Layout))]` on `ToRead` add `[MapperIgnoreSource(nameof(WorkflowEntity.Design))]`.

`WorkflowEntityConfiguration.cs`, after the `Layout` block:

```csharp
        // jsonb like Layout: the stored design is a JSON object written by the design endpoint only.
        entity.Property(e => e.Design)
            .HasColumnType("jsonb");
```

- [ ] **Step 4: Generate the migration**

```powershell
dotnet ef migrations add AddWorkflowDesign --project src/BaseApi.Service/BaseApi.Service.csproj --output-dir Persistence/Migrations
dotnet ef migrations has-pending-model-changes --project src/BaseApi.Service/BaseApi.Service.csproj
```

Open `<stamp>_AddWorkflowDesign.cs` and confirm `Up` holds exactly one call, `migrationBuilder.AddColumn<string>(name: "design", table: "workflows", type: "jsonb", nullable: true);`, and `Down` drops it (mirrors `20261005143018_AddWorkflowLayout.cs`). Anything else means the model drifted: stop and investigate. The second command must print `No changes have been made to the model since the last migration.` (`dotnet-ef` is in `~/.dotnet/tools`.)

- [ ] **Step 5: Return the design with the graph**

`WorkflowGraphDtos.cs` — the `WorkflowGraphDto` record gains a last parameter (and its doc line):

```csharp
/// <param name="Design">The studio's stored design (plan 8), or null when the real entities hold it.</param>
public sealed record WorkflowGraphDto(
    WorkflowReadDto Workflow,
    List<StepReadDto> Steps,
    List<ProcessorReadDto> Processors,
    List<SchemaReadDto> Schemas,
    List<AssignmentReadDto> Assignments,
    List<CacheReadDto> Caches,
    JsonElement? Layout,
    JsonElement? Design);
```

`WorkflowGraphReader.cs` — replace lines 27-38 and the `return` (lines 47-54):

```csharp
        var row = await _db.Set<WorkflowEntity>().AsNoTracking()
            .Where(w => w.Id == workflowId)
            .Select(w => new { w.Layout, w.Design })
            .FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException(nameof(WorkflowEntity), workflowId);

        var layout = Json(row.Layout);
        var design = Json(row.Design);
```

```csharp
        return new WorkflowGraphDto(
            workflow,
            snapshot.Steps.Values.OrderBy(s => s.Name, StringComparer.Ordinal).ThenBy(s => s.Id).ToList(),
            snapshot.Processors.Values.OrderBy(p => p.Name, StringComparer.Ordinal).ThenBy(p => p.Id).ToList(),
            snapshot.Schemas.Values.OrderBy(s => s.Name, StringComparer.Ordinal).ThenBy(s => s.Id).ToList(),
            snapshot.Assignments.Values.OrderBy(a => a.StepId).ThenBy(a => a.Id).ToList(),
            snapshot.Caches.Values.OrderBy(c => c.Name, StringComparer.Ordinal).ThenBy(c => c.Id).ToList(),
            layout,
            design);
    }

    private static JsonElement? Json(string? text)
    {
        if (text is null) return null;
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }
```

- [ ] **Step 6: Run to verify they pass**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowDesignColumnTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-namespace "BaseApi.Tests.WorkflowGraph"
```

Expected: 3 passed; the whole `WorkflowGraph` namespace passes.

- [ ] **Step 7: Commit**

```powershell
git add src/BaseApi.Service/Features/Workflow src/BaseApi.Service/Persistence src/tests/BaseApi.Tests/WorkflowGraph/WorkflowDesignColumnTests.cs
git commit -m "feat(studio): nullable jsonb Design column on workflows, returned by GET /graph (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Design DTOs, the field appliers and the 400 checks

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/Design/WorkflowDesignDtos.cs`, `DesignFields.cs`, `DesignShape.cs`
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/DesignFieldsTests.cs`, `DesignShapeTests.cs`

**Interfaces:**
- Produces (namespace `BaseApi.Service.Features.Workflow.Design`):
  - `public sealed record DesignSaveRequest(DesignWorkflowDto? Workflow, List<DesignStepDto>? Steps, List<DesignProcessorDto>? Processors, List<DesignCacheDto>? Caches, List<DesignSchemaDto>? Schemas, List<DesignAssignmentDto>? Assignments, JsonElement? Layout)`
  - `DesignWorkflowDto(DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields, List<Guid>? EntryStepIds, List<Guid>? CacheIds)`, `DesignStepDto(Guid Id, DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields, List<Guid>? NextStepIds)`, `DesignProcessorDto(Guid Id, Dictionary<string, JsonElement>? Fields, Dictionary<string, Guid>? Slots)`, `DesignCacheDto(Guid Id, Dictionary<string, JsonElement>? Fields)`, `DesignSchemaDto(Guid Id, string Name, string Version, string? Description, string Definition)`, `DesignAssignmentDto(string Op, Guid Id, Guid StepId, DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields)`
  - `DesignOutcomeDto(bool Applied, List<DesignErrorDto> Errors)`, `DesignErrorDto(string Kind, Guid Id, string Stage, string? Field, string Message)`
  - `internal readonly record struct FieldError(string? Field, string Message)`
  - `internal static class DesignFields`: `Apply(WorkflowUpdateDto|StepUpdateDto|ProcessorUpdateDto|CacheUpdateDto|AssignmentUpdateDto, IReadOnlyDictionary<string, JsonElement>?, List<FieldError>)` (one overload each, returns the DTO), `UpdateOf(StepEntity|ProcessorEntity|CacheEntity|AssignmentEntity)`, `FieldOf(string)`, `Failures(ValidationResult)`.
  - `internal static class DesignShape`: `ThrowIfMalformed(Guid workflowId, DesignSaveRequest request)` (throws `FluentValidation.ValidationException`).

- [ ] **Step 1: Write the failing tests**

`src/tests/BaseApi.Tests/WorkflowGraph/DesignFieldsTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Design;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class DesignFieldsTests
{
    private static Dictionary<string, JsonElement> F(string json) => JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    [Fact]
    public void WorkflowFieldsReplaceOnlyWhatIsSentAndNullClearsANullableOne()
    {
        var errors = new List<FieldError>();
        var dto = DesignFields.Apply(new WorkflowUpdateDto("wf", "1.0.0", "d", [Guid.NewGuid()], null, null, "0 0 * * *"),
            F("""{"name":"orders","cronExpression":null}"""), errors);

        Assert.Empty(errors);
        Assert.Equal(("orders", "1.0.0", "d", (string?)null), (dto.Name, dto.Version, dto.Description, dto.CronExpression));
    }

    [Fact]
    public void AStepsEntryConditionIsAWholeNumber()
    {
        var errors = new List<FieldError>();
        var dto = DesignFields.Apply(new StepUpdateDto("s", "1.0.0", null, Guid.NewGuid(), null, StepEntryCondition.PreviousCompleted),
            F("""{"entryCondition":4,"description":"x"}"""), errors);

        Assert.Empty(errors);
        Assert.Equal((StepEntryCondition)4, dto.EntryCondition);
        Assert.Equal("x", dto.Description);
    }

    [Fact]
    public void AnUnknownFieldAndAValueOfTheWrongTypeAreErrorsOnThoseFields()
    {
        var errors = new List<FieldError>();
        DesignFields.Apply(new CacheUpdateDto("c", "1.0.0", null, "root", "{}"), F("""{"colour":"red","root":7}"""), errors);

        Assert.Equal(["colour", "root"], errors.Select(e => e.Field!).OrderBy(f => f, StringComparer.Ordinal));
    }

    [Theory]
    [InlineData("SourceHash", "sourceHash")]
    [InlineData("source_hash", "sourceHash")]
    [InlineData("EntryStepIds", "entryStepIds")]
    [InlineData("root", "root")]
    public void FieldNamesAreTheStudiosCamelCase(string from, string expected) => Assert.Equal(expected, DesignFields.FieldOf(from));
}
```

`src/tests/BaseApi.Tests/WorkflowGraph/DesignShapeTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Workflow.Design;
using FluentValidation;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Spec §4.3: only a body that is not a design at all is a 400.</summary>
public sealed class DesignShapeTests
{
    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();
    private static DesignSaveRequest Empty() => new(null, null, null, null, null, null, Json("{}"));

    [Fact]
    public void AnEmptyDesignWithALayoutIsWellFormed() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty());

    [Fact]
    public void AMissingLayoutOrOneThatIsNotAnObjectIsMalformed()
    {
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with { Layout = null }));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with { Layout = Json("[]") }));
    }

    [Fact]
    public void TheSameStepTwiceIsMalformed()
    {
        var id = Guid.NewGuid();
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Steps = [new DesignStepDto(id, null, null, null), new DesignStepDto(id, null, null, null)],
        }));
    }

    [Fact]
    public void AnUnknownOpAndTwoOpsForOneStepAreMalformed()
    {
        var step = Guid.NewGuid();
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Assignments = [new DesignAssignmentDto("rename", Guid.NewGuid(), step, null, null)],
        }));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Assignments = [new DesignAssignmentDto("delete", Guid.NewGuid(), step, null, null), new DesignAssignmentDto("create", Guid.NewGuid(), step, null, null)],
        }));
    }

    [Fact]
    public void ASlotThatIsNotOneOfTheThreeOrNamesACopyTheBodyDoesNotCarryIsMalformed()
    {
        var copy = Guid.NewGuid();
        var schemas = new List<DesignSchemaDto> { new(copy, "s", "1.0.0", null, "{}") };
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Schemas = schemas, Processors = [new DesignProcessorDto(Guid.NewGuid(), null, new() { ["side"] = copy })],
        }));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Processors = [new DesignProcessorDto(Guid.NewGuid(), null, new() { ["config"] = copy })],
        }));
        DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Schemas = schemas, Processors = [new DesignProcessorDto(Guid.NewGuid(), null, new() { ["config"] = copy })],
        });
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build errors (namespace `BaseApi.Service.Features.Workflow.Design` not found).

- [ ] **Step 3: Implement**

`src/BaseApi.Service/Features/Workflow/Design/WorkflowDesignDtos.cs`:

```csharp
using System.Text.Json;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// The body of <c>PUT /workflows/{id}/design</c> (plan 8 §4.2): every change of the studio's virtual
/// entities relative to the real ones. Each entity names only its changed fields, by the CRUD DTO's
/// camelCase name, with a JSON value; owned entities (the workflow, steps, assignments) carry the
/// <c>updatedAt</c> the designer loaded. Stored as it came (without <see cref="Layout"/>) whether or
/// not it can be applied.
/// </summary>
/// <param name="Workflow">The workflow's changes and loaded stamp; null when nothing of the workflow changed.</param>
/// <param name="Steps">Changed steps: fields and/or the whole next-step list.</param>
/// <param name="Processors">Changed processors: fields and slot re-points to schema copies.</param>
/// <param name="Caches">Changed caches.</param>
/// <param name="Schemas">Schema copies to insert (new ids).</param>
/// <param name="Assignments">At most one create, update or delete per step of this workflow.</param>
/// <param name="Layout">The canvas layout, loose wires included; required.</param>
public sealed record DesignSaveRequest(
    DesignWorkflowDto? Workflow,
    List<DesignStepDto>? Steps,
    List<DesignProcessorDto>? Processors,
    List<DesignCacheDto>? Caches,
    List<DesignSchemaDto>? Schemas,
    List<DesignAssignmentDto>? Assignments,
    JsonElement? Layout);

/// <param name="EntryStepIds">The whole entry list when it changed; null: unchanged.</param>
/// <param name="CacheIds">The whole cache list when it changed; null: unchanged.</param>
public sealed record DesignWorkflowDto(
    DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields, List<Guid>? EntryStepIds, List<Guid>? CacheIds);

/// <param name="NextStepIds">The whole next-step list when the step's wires changed; null: unchanged.</param>
public sealed record DesignStepDto(
    Guid Id, DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields, List<Guid>? NextStepIds);

/// <param name="Slots"><c>input</c>, <c>output</c> or <c>config</c> to the id of a copy in <see cref="DesignSaveRequest.Schemas"/>.</param>
public sealed record DesignProcessorDto(Guid Id, Dictionary<string, JsonElement>? Fields, Dictionary<string, Guid>? Slots);

public sealed record DesignCacheDto(Guid Id, Dictionary<string, JsonElement>? Fields);

/// <summary>A processor slot's background copy (spec §1.5): a new id, the original's name and version.</summary>
public sealed record DesignSchemaDto(Guid Id, string Name, string Version, string? Description, string Definition);

/// <param name="Op"><c>create</c> (a new row with this id, linked to the workflow), <c>update</c> or <c>delete</c>.</param>
public sealed record DesignAssignmentDto(
    string Op, Guid Id, Guid StepId, DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields);

/// <summary>The answer: applied exactly when there are no errors; the design is stored either way.</summary>
public sealed record DesignOutcomeDto(bool Applied, List<DesignErrorDto> Errors);

/// <param name="Kind"><c>schema</c>, <c>processor</c>, <c>cache</c>, <c>step</c>, <c>assignment</c> or <c>workflow</c>.</param>
/// <param name="Stage"><c>schemas</c>, <c>processors</c>, <c>caches</c>, <c>steps</c>, <c>wires</c>, <c>assignments</c> or <c>workflow</c>.</param>
/// <param name="Field">The camelCase field, or null when the error is about the whole entity.</param>
public sealed record DesignErrorDto(string Kind, Guid Id, string Stage, string? Field, string Message);
```

`src/BaseApi.Service/Features/Workflow/Design/DesignFields.cs`:

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Step;
using FluentValidation.Results;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>Why one entity failed: a camelCase field (null: the entity as a whole) and the message.</summary>
internal readonly record struct FieldError(string? Field, string Message);

/// <summary>
/// Lays a design's changed fields over the CRUD update DTO built from the stored row, so the CRUD
/// validators judge exactly what the entity would become (plan 8 §4.3: only their rules decide).
/// </summary>
internal static class DesignFields
{
    private static readonly Dictionary<string, JsonElement> None = new();

    public static WorkflowUpdateDto Apply(WorkflowUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "cronExpression" => dto with { CronExpression = Text(v, key, errors) },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    public static StepUpdateDto Apply(StepUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "entryCondition" => Number(v, key, errors) is { } n ? dto with { EntryCondition = (StepEntryCondition)n } : dto,
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    public static ProcessorUpdateDto Apply(ProcessorUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "sourceHash" => dto with { SourceHash = Text(v, key, errors) ?? "" },
                "instanceId" => dto with { InstanceId = Text(v, key, errors) },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    public static CacheUpdateDto Apply(CacheUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "root" => dto with { Root = Text(v, key, errors) ?? "" },
                "items" => dto with { Items = Text(v, key, errors) ?? "" },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    public static AssignmentUpdateDto Apply(AssignmentUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "payload" => dto with { Payload = Text(v, key, errors) ?? "" },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    /// <summary>The update DTO a step's PUT would send unchanged; next steps travel separately (stage 5).</summary>
    public static StepUpdateDto UpdateOf(StepEntity e) => new(e.Name, e.Version, e.Description, e.ProcessorId, null, e.EntryCondition);

    public static ProcessorUpdateDto UpdateOf(ProcessorEntity e) =>
        new(e.Name, e.Version, e.Description, e.SourceHash, e.InstanceId, e.InputSchemaId, e.OutputSchemaId, e.ConfigSchemaId);

    public static CacheUpdateDto UpdateOf(CacheEntity e) => new(e.Name, e.Version, e.Description, e.Root, e.Items);

    public static AssignmentUpdateDto UpdateOf(AssignmentEntity e) => new(e.Name, e.Version, e.Description, e.StepId, e.Payload);

    /// <summary>A validator's failures as field errors (<c>SourceHash</c> → <c>sourceHash</c>).</summary>
    public static List<FieldError> Failures(ValidationResult result) =>
        result.Errors.Select(e => new FieldError(FieldOf(e.PropertyName), e.ErrorMessage)).ToList();

    /// <summary>A C# property name or a snake_case column as the studio's camelCase field name.</summary>
    public static string FieldOf(string name)
    {
        var parts = name.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return name;
        var head = char.ToLowerInvariant(parts[0][0]) + parts[0][1..];
        return head + string.Concat(parts.Skip(1).Select(p => char.ToUpperInvariant(p[0]) + p[1..]));
    }

    private static string? Text(JsonElement v, string key, List<FieldError> errors)
    {
        switch (v.ValueKind)
        {
            case JsonValueKind.String: return v.GetString();
            case JsonValueKind.Null: return null;
            default: errors.Add(new FieldError(key, $"{key} must be text or null.")); return null;
        }
    }

    private static int? Number(JsonElement v, string key, List<FieldError> errors)
    {
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)) return n;
        errors.Add(new FieldError(key, $"{key} must be a whole number."));
        return null;
    }

    private static T Unknown<T>(T dto, string key, List<FieldError> errors)
    {
        errors.Add(new FieldError(key, $"Unknown field '{key}'."));
        return dto;
    }
}
```

`src/BaseApi.Service/Features/Workflow/Design/DesignShape.cs`:

```csharp
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using FluentValidation.Results;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// The only checks that make a design a 400 (plan 8 §4.3): a body that is not a design at all. They
/// run before anything is stored; everything else is an entity error reported by the stages.
/// </summary>
internal static class DesignShape
{
    private static readonly string[] Slots = ["input", "output", "config"];
    private static readonly string[] Ops = ["create", "update", "delete"];

    public static void ThrowIfMalformed(Guid workflowId, DesignSaveRequest r)
    {
        var failures = new List<ValidationFailure>();
        void Fail(string property, string message) => failures.Add(new ValidationFailure(property, message));

        if (workflowId == Guid.Empty) Fail("WorkflowId", "The workflow id must not be Guid.Empty.");
        if (r.Layout is not { } layout) Fail(nameof(DesignSaveRequest.Layout), "Layout is required.");
        else if (WorkflowLayout.Validate(layout) is { } error) Fail(nameof(DesignSaveRequest.Layout), error);

        Unique(r.Steps?.Select(s => s.Id), nameof(DesignSaveRequest.Steps), Fail);
        Unique(r.Processors?.Select(p => p.Id), nameof(DesignSaveRequest.Processors), Fail);
        Unique(r.Caches?.Select(c => c.Id), nameof(DesignSaveRequest.Caches), Fail);
        Unique(r.Schemas?.Select(s => s.Id), nameof(DesignSaveRequest.Schemas), Fail);
        Unique(r.Assignments?.Select(a => a.Id), nameof(DesignSaveRequest.Assignments), Fail);
        Unique(r.Assignments?.Select(a => a.StepId), "Assignments.StepId", Fail);

        var copies = (r.Schemas ?? []).Select(s => s.Id).ToHashSet();
        foreach (var p in r.Processors ?? [])
            foreach (var (slot, schemaId) in p.Slots ?? new Dictionary<string, Guid>())
            {
                if (!Slots.Contains(slot)) Fail($"Processors[{p.Id}].Slots", $"'{slot}' is not input, output or config.");
                else if (!copies.Contains(schemaId)) Fail($"Processors[{p.Id}].Slots", $"The {slot} slot names a schema this design does not carry.");
            }

        foreach (var a in r.Assignments ?? [])
            if (!Ops.Contains(a.Op)) Fail($"Assignments[{a.Id}].Op", "Op must be create, update or delete.");

        if (failures.Count > 0) throw new ValidationException(failures);
    }

    private static void Unique(IEnumerable<Guid>? ids, string property, Action<string, string> fail)
    {
        var list = ids?.ToList() ?? [];
        if (list.Any(id => id == Guid.Empty)) fail(property, "An id must not be Guid.Empty.");
        if (list.Distinct().Count() != list.Count) fail(property, "Each id may appear once.");
    }
}
```

- [ ] **Step 4: Run to verify they pass**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.DesignFieldsTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.DesignShapeTests"
```

Expected: 7 and 5 passed.

- [ ] **Step 5: Commit**

```powershell
git add src/BaseApi.Service/Features/Workflow/Design src/tests/BaseApi.Tests/WorkflowGraph/DesignFieldsTests.cs src/tests/BaseApi.Tests/WorkflowGraph/DesignShapeTests.cs
git commit -m "feat(studio): design request DTOs, field appliers over the CRUD update DTOs, and the 400 checks (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The syncer: store, then the stages in one transaction; `PUT /workflows/{id}/design`

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/Design/DesignPersistence.cs`, `DesignRun.cs`, `IWorkflowDesignSyncer.cs`, `WorkflowDesignSyncer.cs`, `DesignStages.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowController.cs:41-58` (field, constructor) and after `PutGraph` (line 222)
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowServiceCollectionExtensions.cs:23-31`
- Modify: `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs:29-54` (shared InMemory root, `Syncer`, `AllStages`, seams)
- Modify: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowGraphControllerTests.cs:15-19`, `WorkflowLayoutTests.cs:74`
- Create: `src/tests/BaseApi.Tests/WorkflowGraph/DesignBody.cs`
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowDesignSyncerTests.cs`

**Interfaces:**
- Consumes: Task 2's DTOs, `DesignShape`, `DesignFields`.
- Produces:
  - `public interface IWorkflowDesignSyncer { Task<DesignOutcomeDto> SaveAsync(Guid workflowId, DesignSaveRequest request, CancellationToken ct); }`
  - `internal interface IDesignStore { Task<bool> StoreAsync(Guid workflowId, string design, string layout, CancellationToken ct); Task ClearAsync(Guid workflowId, CancellationToken ct); }` + `RelationalDesignStore`
  - `internal interface IDesignTransactions { Task<IDesignTransaction> BeginAsync(CancellationToken ct); }`, `internal interface IDesignTransaction : IAsyncDisposable` (`SavepointAsync`, `RollbackToSavepointAsync`, `ReleaseSavepointAsync`, `CommitAsync`, `RollbackAsync`, each `(…, CancellationToken)`) + `RelationalDesignTransactions`
  - `internal interface IDesignStage { Task RunAsync(DesignRun run, CancellationToken ct); }`
  - `internal sealed class DesignRun`: `WorkflowId`, `Request`, `Errors`, `FailedSchemas`, `FailedSteps`, `CreatedAssignments`, `DeletedAssignments`, `Fail(kind, id, stage, field, message)`, `static IsStale(DateTime stored, DateTime? loaded)`, `const Conflict`, `Task<bool> UnitAsync(string kind, Guid id, string stage, Func<Task<List<FieldError>>> stageChange, CancellationToken ct)`
  - `internal sealed class WorkflowDesignSyncer(BaseDbContext, IDesignStore, IDesignTransactions, IReadOnlyList<IDesignStage>)`
  - `internal static class DesignStages { IReadOnlyList<IDesignStage> Ordered(IServiceProvider sp); }`
  - `WorkflowsController.PutDesign(Guid id, DesignSaveRequest request, CancellationToken ct)` at `PUT /api/v1/workflows/{id}/design`
  - Tests: `GraphHarness.Root`, `GraphHarness.Syncer(IReadOnlyList<IDesignStage>? stages = null)`, `GraphHarness.AllStages()`; `DesignBody.Layout(json)`, `DesignBody.F(json)`, `DesignBody.Of(workflow, steps, processors, caches, schemas, assignments, layout)`.

- [ ] **Step 1: Give the harness the seams**

`GraphHarness.cs` — add `using BaseApi.Service.Features.Workflow.Design;` and `using Microsoft.EntityFrameworkCore.Storage;`; replace the field block and the context creation (lines 29-40) with:

```csharp
    private readonly string _name = $"graph-{Guid.NewGuid():N}";

    /// <summary>Shared by every context of this harness, so a second context (the design store's) sees the same rows.</summary>
    public InMemoryDatabaseRoot Root { get; } = new();

    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 10, 5, 12, 0, 0, TimeSpan.Zero));
    public AppDbContext Db { get; }
    public IWorkflowGraphReader Reader { get; }
    public IWorkflowGraphSaver Saver { get; }
    public IWorkflowGraphLoader Loader { get; }

    public GraphHarness()
    {
        Db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(_name, Root)
            .AddInterceptors(new AuditInterceptor(new HttpContextAccessor(), Clock))
            .Options);
```

(the rest of the constructor unchanged). Before `public ValueTask DisposeAsync()` add:

```csharp
    /// <summary>
    /// The design syncer over this harness. InMemory has no transactions, so the stages' writes are not
    /// rolled back here: these tests assert the answer and what an applied design wrote;
    /// WorkflowDesignLiveTests proves the rollback on Postgres.
    /// </summary>
    public IWorkflowDesignSyncer Syncer(IReadOnlyList<IDesignStage>? stages = null) =>
        new WorkflowDesignSyncer(Db, new HarnessDesignStore(Root, _name), new PassThroughDesignTransactions(), stages ?? AllStages());

    /// <summary>Every stage, in the spec's order (plan 8 §4.3); each stage task adds its own.</summary>
    public IReadOnlyList<IDesignStage> AllStages() => [];

    /// <summary>The store through a second context with no audit interceptor, as ExecuteUpdate bypasses it in production.</summary>
    private sealed class HarnessDesignStore(InMemoryDatabaseRoot root, string name) : IDesignStore
    {
        private AppDbContext Plain() => new(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase(name, root).Options);

        public async Task<bool> StoreAsync(Guid workflowId, string design, string layout, CancellationToken ct)
        {
            await using var db = Plain();
            var row = await db.Workflows.FirstOrDefaultAsync(w => w.Id == workflowId, ct);
            if (row is null) return false;
            row.Design = design;
            row.Layout = layout;
            await db.SaveChangesAsync(ct);
            return true;
        }

        public async Task ClearAsync(Guid workflowId, CancellationToken ct)
        {
            await using var db = Plain();
            var row = await db.Workflows.FirstAsync(w => w.Id == workflowId, ct);
            row.Design = null;
            await db.SaveChangesAsync(ct);
        }
    }

    private sealed class PassThroughDesignTransactions : IDesignTransactions
    {
        public Task<IDesignTransaction> BeginAsync(CancellationToken ct) => Task.FromResult<IDesignTransaction>(new Nothing());

        private sealed class Nothing : IDesignTransaction
        {
            public Task SavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task RollbackToSavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task ReleaseSavepointAsync(string name, CancellationToken ct) => Task.CompletedTask;
            public Task CommitAsync(CancellationToken ct) => Task.CompletedTask;
            public Task RollbackAsync(CancellationToken ct) => Task.CompletedTask;
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
```

Create `src/tests/BaseApi.Tests/WorkflowGraph/DesignBody.cs`:

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Workflow.Design;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Builders for design bodies, so a test states only the changes it cares about.</summary>
internal static class DesignBody
{
    public static JsonElement Layout(string json = """{"v":1}""") => JsonDocument.Parse(json).RootElement.Clone();

    public static Dictionary<string, JsonElement> F(string json) => JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    public static DesignSaveRequest Of(
        DesignWorkflowDto? workflow = null, DesignStepDto[]? steps = null, DesignProcessorDto[]? processors = null,
        DesignCacheDto[]? caches = null, DesignSchemaDto[]? schemas = null, DesignAssignmentDto[]? assignments = null,
        string layout = """{"v":1}""") =>
        new(workflow, steps?.ToList(), processors?.ToList(), caches?.ToList(), schemas?.ToList(), assignments?.ToList(), Layout(layout));
}
```

- [ ] **Step 2: Write the failing tests** (`src/tests/BaseApi.Tests/WorkflowGraph/WorkflowDesignSyncerTests.cs`)

```csharp
using BaseApi.Core.Exceptions;
using BaseApi.Service.Features.Workflow.Design;
using FluentValidation;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8 §4.3, first part: the design is stored whatever the stages find; no error empties it.</summary>
public sealed class WorkflowDesignSyncerTests
{
    /// <summary>Refuses everything, so a test can see the store without any stage applying a change.</summary>
    private sealed class RefusingStage : IDesignStage
    {
        public Task RunAsync(DesignRun run, CancellationToken ct)
        {
            run.Fail("step", Guid.Empty, "steps", "name", "refused by the test");
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task ADesignWithErrorsIsStoredWithItsLayoutAndAnsweredNotApplied()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        var outcome = await h.Syncer([new RefusingStage()]).SaveAsync(wf,
            DesignBody.Of(steps: [new DesignStepDto(step, null, null, [])], layout: """{"v":1,"parked":["x"]}"""), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Equal("refused by the test", Assert.Single(outcome.Errors).Message);
        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        Assert.Equal(step, graph.Design!.Value.GetProperty("steps")[0].GetProperty("id").GetGuid());
        Assert.False(graph.Design.Value.TryGetProperty("layout", out _));
        Assert.Equal("x", graph.Layout!.Value.GetProperty("parked")[0].GetString());
    }

    [Fact]
    public async Task StoringDoesNotMoveTheWorkflowsUpdatedAt()
    {
        // Review Focus 1: a stamped store would make every later workflow stage conflict with itself.
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        var before = (await h.Reader.ReadAsync(wf, h.Ct)).Workflow.UpdatedAt;

        h.Tick();
        await h.Syncer([new RefusingStage()]).SaveAsync(wf, DesignBody.Of(), h.Ct);

        Assert.Equal(before, (await h.Reader.ReadAsync(wf, h.Ct)).Workflow.UpdatedAt);
    }

    [Fact]
    public async Task TheStoredDesignIsLastWriteWins()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var b = await h.StepAsync(proc, "b");
        var wf = await h.WorkflowAsync("wf", [a]);
        var syncer = h.Syncer([new RefusingStage()]);

        await syncer.SaveAsync(wf, DesignBody.Of(steps: [new DesignStepDto(a, null, null, [a])]), h.Ct);
        await syncer.SaveAsync(wf, DesignBody.Of(steps: [new DesignStepDto(b, null, null, [])]), h.Ct);

        var design = (await h.Reader.ReadAsync(wf, h.Ct)).Design!.Value;
        Assert.Equal(b, design.GetProperty("steps")[0].GetProperty("id").GetGuid());
        Assert.Equal(1, design.GetProperty("steps").GetArrayLength());
    }

    [Fact]
    public async Task ADesignWithNoErrorsEmptiesTheStoredDesignAndKeepsTheLayout()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        await h.Syncer([new RefusingStage()]).SaveAsync(wf, DesignBody.Of(layout: """{"v":1,"parked":["a"]}"""), h.Ct);
        Assert.NotNull((await h.Reader.ReadAsync(wf, h.Ct)).Design);

        var outcome = await h.Syncer([]).SaveAsync(wf, DesignBody.Of(layout: """{"v":1,"parked":["b"]}"""), h.Ct);

        Assert.True(outcome.Applied);
        Assert.Empty(outcome.Errors);
        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        Assert.Null(graph.Design);
        Assert.Equal("b", graph.Layout!.Value.GetProperty("parked")[0].GetString());
    }

    [Fact]
    public async Task AMalformedDesignIsAValidationFailureAndStoresNothing()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        await Assert.ThrowsAsync<ValidationException>(() => h.Syncer().SaveAsync(wf, DesignBody.Of(layout: "[]"), h.Ct));

        Assert.Null((await h.Reader.ReadAsync(wf, h.Ct)).Design);
    }

    [Fact]
    public async Task AnUnknownWorkflowIsNotFound()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<NotFoundException>(() => h.Syncer().SaveAsync(Guid.NewGuid(), DesignBody.Of(), h.Ct));
    }
}
```

Append to `WorkflowGraphControllerTests.cs` (add `using BaseApi.Service.Features.Workflow.Design;`):

```csharp
    [Fact]
    public async Task PutDesignAnswersTheOutcome()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        var ok = Assert.IsType<OkObjectResult>(await Controller(h).PutDesign(wf, DesignBody.Of(), h.Ct));

        Assert.True(Assert.IsType<DesignOutcomeDto>(ok.Value).Applied);
    }
```

- [ ] **Step 3: Run to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build errors (`IDesignStore`, `WorkflowDesignSyncer`, `PutDesign` not found).

- [ ] **Step 4: Implement the seams, the run and the syncer**

`src/BaseApi.Service/Features/Workflow/Design/DesignPersistence.cs`:

```csharp
using BaseApi.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>Writes and empties the stored design (plan 8 §4.3, first step).</summary>
internal interface IDesignStore
{
    /// <summary>Stores the design and the layout on the workflow row and commits; false when the workflow does not exist.</summary>
    Task<bool> StoreAsync(Guid workflowId, string design, string layout, CancellationToken ct);

    /// <summary>Empties the stored design, inside whatever transaction the context has open.</summary>
    Task ClearAsync(Guid workflowId, CancellationToken ct);
}

/// <summary>
/// One UPDATE each, never through the change tracker: the audit interceptor does not see it, so the
/// workflow's <c>UpdatedAt</c> stays what the designer loaded (the workflow stage checks against it),
/// and no concurrency token is involved (last write wins, spec §1.6).
/// </summary>
internal sealed class RelationalDesignStore : IDesignStore
{
    private readonly BaseDbContext _db;

    public RelationalDesignStore(BaseDbContext db) => _db = db;

    public async Task<bool> StoreAsync(Guid workflowId, string design, string layout, CancellationToken ct) =>
        await _db.Set<WorkflowEntity>().Where(w => w.Id == workflowId)
            .ExecuteUpdateAsync(s => s.SetProperty(w => w.Design, design).SetProperty(w => w.Layout, layout), ct) > 0;

    public Task ClearAsync(Guid workflowId, CancellationToken ct) =>
        _db.Set<WorkflowEntity>().Where(w => w.Id == workflowId)
            .ExecuteUpdateAsync(s => s.SetProperty(w => w.Design, (string?)null), ct);
}

/// <summary>The dry run's one transaction, with a savepoint per entity.</summary>
internal interface IDesignTransaction : IAsyncDisposable
{
    Task SavepointAsync(string name, CancellationToken ct);
    Task RollbackToSavepointAsync(string name, CancellationToken ct);
    Task ReleaseSavepointAsync(string name, CancellationToken ct);
    Task CommitAsync(CancellationToken ct);
    Task RollbackAsync(CancellationToken ct);
}

internal interface IDesignTransactions
{
    Task<IDesignTransaction> BeginAsync(CancellationToken ct);
}

/// <summary>
/// EF Core's own transaction and savepoints on the scoped context. Legal because the context has no
/// retrying execution strategy (as <c>RelationalGraphDryRun</c> notes). Disposing without a commit
/// rolls back, so an exception never leaves part of a design behind.
/// </summary>
internal sealed class RelationalDesignTransactions : IDesignTransactions
{
    private readonly BaseDbContext _db;

    public RelationalDesignTransactions(BaseDbContext db) => _db = db;

    public async Task<IDesignTransaction> BeginAsync(CancellationToken ct) =>
        new Relational(await _db.Database.BeginTransactionAsync(ct));

    private sealed class Relational : IDesignTransaction
    {
        private readonly IDbContextTransaction _tx;

        public Relational(IDbContextTransaction tx) => _tx = tx;

        public Task SavepointAsync(string name, CancellationToken ct) => _tx.CreateSavepointAsync(name, ct);
        public Task RollbackToSavepointAsync(string name, CancellationToken ct) => _tx.RollbackToSavepointAsync(name, ct);
        public Task ReleaseSavepointAsync(string name, CancellationToken ct) => _tx.ReleaseSavepointAsync(name, ct);
        public Task CommitAsync(CancellationToken ct) => _tx.CommitAsync(ct);
        public Task RollbackAsync(CancellationToken ct) => _tx.RollbackAsync(ct);
        public ValueTask DisposeAsync() => _tx.DisposeAsync();
    }
}
```

`src/BaseApi.Service/Features/Workflow/Design/DesignRun.cs`:

```csharp
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Exceptions;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>One stage of the dry run (plan 8 §4.3), run in order by <see cref="WorkflowDesignSyncer"/>.</summary>
internal interface IDesignStage
{
    Task RunAsync(DesignRun run, CancellationToken ct);
}

/// <summary>
/// One design save's state while the stages run: the request, every error so far, and what later stages
/// depend on (failed copies and steps, created and deleted assignments).
/// </summary>
internal sealed class DesignRun
{
    /// <summary>The owned-entity conflict message (spec §4.3), exactly.</summary>
    public const string Conflict = "changed by someone else since you opened it";

    private readonly BaseDbContext _db;
    private readonly IDesignTransaction _tx;
    private int _units;

    public DesignRun(Guid workflowId, DesignSaveRequest request, BaseDbContext db, IDesignTransaction tx)
    {
        WorkflowId = workflowId;
        Request = request;
        _db = db;
        _tx = tx;
    }

    public Guid WorkflowId { get; }
    public DesignSaveRequest Request { get; }
    public List<DesignErrorDto> Errors { get; } = [];
    public HashSet<Guid> FailedSchemas { get; } = [];
    public HashSet<Guid> FailedSteps { get; } = [];
    public List<Guid> CreatedAssignments { get; } = [];
    public List<Guid> DeletedAssignments { get; } = [];

    public void Fail(string kind, Guid id, string stage, string? field, string message) =>
        Errors.Add(new DesignErrorDto(kind, id, stage, field, message));

    /// <summary>Stale when the stored row is newer than what the designer loaded, or no stamp was sent.</summary>
    public static bool IsStale(DateTime stored, DateTime? loaded) => loaded is null || stored > loaded.Value;

    /// <summary>
    /// One entity's change inside its own savepoint (spec §4.3): <paramref name="stageChange"/> loads, checks
    /// and stages the change, returning why it may not happen; with no reason it is saved. A reason, or a
    /// database error at the save, rolls back to the savepoint and becomes this entity's error, and the
    /// stages go on. The tracker is cleared either way, so nothing of a failed entity reaches the next save.
    /// True when the change was applied.
    /// </summary>
    public async Task<bool> UnitAsync(string kind, Guid id, string stage, Func<Task<List<FieldError>>> stageChange, CancellationToken ct)
    {
        var savepoint = $"design_unit_{++_units}";
        await _tx.SavepointAsync(savepoint, ct);
        try
        {
            var problems = await stageChange();
            if (problems.Count > 0)
            {
                foreach (var p in problems) Fail(kind, id, stage, p.Field, p.Message);
                await _tx.RollbackToSavepointAsync(savepoint, ct);
                return false;
            }
            await _db.SaveChangesAsync(ct);
            await _tx.ReleaseSavepointAsync(savepoint, ct);
            return true;
        }
        catch (DbUpdateException ex)
        {
            // not the request's token: a cancelled request must still leave the transaction usable for its rollback
            await _tx.RollbackToSavepointAsync(savepoint, CancellationToken.None);
            var (field, message) = Describe(ex);
            Fail(kind, id, stage, field, message);
            return false;
        }
        finally
        {
            _db.ChangeTracker.Clear();
        }
    }

    private static (string? Field, string Message) Describe(DbUpdateException ex)
    {
        if (ex is DbUpdateConcurrencyException) return (null, Conflict);
        if (PostgresExceptionMapper.TryMap(ex, out _, out var detail, out var column))
            return (column is null ? null : DesignFields.FieldOf(column), detail);
        return (null, "The database refused this change.");
    }
}
```

`src/BaseApi.Service/Features/Workflow/Design/IWorkflowDesignSyncer.cs`:

```csharp
namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>Saves the SKP Studio's design of one workflow (plan 8 §4.2-§4.3).</summary>
public interface IWorkflowDesignSyncer
{
    /// <summary>
    /// Stores the design on the workflow (always), then dry-runs it and, only when it finds no errors,
    /// aligns the real entities with it in one transaction. <see cref="FluentValidation.ValidationException"/>
    /// for a body that is not a design; <see cref="BaseApi.Core.Exceptions.NotFoundException"/> for an unknown workflow.
    /// </summary>
    Task<DesignOutcomeDto> SaveAsync(Guid workflowId, DesignSaveRequest request, CancellationToken ct);
}
```

`src/BaseApi.Service/Features/Workflow/Design/WorkflowDesignSyncer.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Store, dry run, then align (plan 8 §4.3). The design is stored on its own commit with no conflict
/// check (last write wins). Then one transaction runs every stage in order; each entity is a savepoint,
/// so one save reports every error at once. Any error: roll back (the real entities never hold part of
/// a design; the stored design stays). None: empty the stored design and commit.
/// <para>
/// <b>Nothing here judges the design.</b> No cycle, schema-edge, payload or liveness check: those are
/// start checks. The stages run only the field rules the CRUD endpoints already enforce.
/// </para>
/// </summary>
internal sealed class WorkflowDesignSyncer : IWorkflowDesignSyncer
{
    private static readonly JsonSerializerOptions StoredJson = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly BaseDbContext _db;
    private readonly IDesignStore _store;
    private readonly IDesignTransactions _transactions;
    private readonly IReadOnlyList<IDesignStage> _stages;

    public WorkflowDesignSyncer(BaseDbContext db, IDesignStore store, IDesignTransactions transactions, IReadOnlyList<IDesignStage> stages)
    {
        _db = db;
        _store = store;
        _transactions = transactions;
        _stages = stages;
    }

    public async Task<DesignOutcomeDto> SaveAsync(Guid workflowId, DesignSaveRequest request, CancellationToken ct)
    {
        DesignShape.ThrowIfMalformed(workflowId, request);

        // ---- 1. Store: always, on its own commit; the layout goes to Layout, the rest to Design. ----
        var design = JsonSerializer.Serialize(request with { Layout = null }, StoredJson);
        if (!await _store.StoreAsync(workflowId, design, request.Layout!.Value.GetRawText(), ct))
            throw new NotFoundException(nameof(WorkflowEntity), workflowId);
        _db.ChangeTracker.Clear();

        // ---- 2. The stages, in one transaction, collecting every error. ----------------------------
        await using var tx = await _transactions.BeginAsync(ct);
        var run = new DesignRun(workflowId, request, _db, tx);
        try
        {
            foreach (var stage in _stages)
                await stage.RunAsync(run, ct);

            if (run.Errors.Count > 0)
            {
                await tx.RollbackAsync(CancellationToken.None);
                return new DesignOutcomeDto(false, run.Errors);
            }

            // ---- 3. Aligned: the real entities now hold the design, so the stored one goes. --------
            await _store.ClearAsync(workflowId, ct);
            await tx.CommitAsync(ct);
            return new DesignOutcomeDto(true, []);
        }
        finally
        {
            _db.ChangeTracker.Clear();
        }
    }
}
```

`src/BaseApi.Service/Features/Workflow/Design/DesignStages.cs`:

```csharp
namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>The dry run's stages in the spec's order (plan 8 §4.3): schemas, processors, caches, steps, wires, assignments, workflow.</summary>
internal static class DesignStages
{
    public static IReadOnlyList<IDesignStage> Ordered(IServiceProvider sp) => [];
}
```

- [ ] **Step 5: The endpoint and the registrations**

`WorkflowController.cs` — add `using BaseApi.Service.Features.Workflow.Design;`, a field `private readonly IWorkflowDesignSyncer _designSyncer;`, a last constructor parameter `IWorkflowDesignSyncer designSyncer` assigned to it, and after `PutGraph`:

```csharp
    /// <summary>
    /// Stores the studio's design on the workflow, then dry-runs it and aligns the real entities only when
    /// it finds no errors (plan 8 §4.2). The answer is the outcome either way: <c>applied</c>, and every
    /// error with its entity, stage and field. Only a body that is not a design is a 400.
    /// </summary>
    [HttpPut("{id:guid}/design")]
    [ProducesResponseType(typeof(DesignOutcomeDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> PutDesign(Guid id, [FromBody] DesignSaveRequest request, CancellationToken ct)
        => Ok(await _designSyncer.SaveAsync(id, request, ct));
```

`WorkflowServiceCollectionExtensions.cs` — add `using BaseApi.Core.Persistence;` and `using BaseApi.Service.Features.Workflow.Design;`; before `AddExceptionHandler`:

```csharp
        // Plan 8: the design save (store, then the stages in one transaction).
        services.AddScoped<IDesignStore, RelationalDesignStore>();
        services.AddScoped<IDesignTransactions, RelationalDesignTransactions>();
        services.AddScoped<IWorkflowDesignSyncer>(sp => new WorkflowDesignSyncer(
            sp.GetRequiredService<BaseDbContext>(), sp.GetRequiredService<IDesignStore>(),
            sp.GetRequiredService<IDesignTransactions>(), DesignStages.Ordered(sp)));
```

`WorkflowGraphControllerTests.cs` — the `Controller(h)` factory passes `h.Syncer()` as the last constructor argument. `WorkflowLayoutTests.cs:74` — add `, designSyncer: null!` to the named arguments.

- [ ] **Step 6: Run to verify they pass**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowDesignSyncerTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-namespace "BaseApi.Tests.WorkflowGraph"
```

Expected: 6 passed; the namespace passes (the controller test included).

- [ ] **Step 7: Commit**

```powershell
git add src/BaseApi.Service/Features/Workflow src/tests/BaseApi.Tests/WorkflowGraph
git commit -m "feat(studio): PUT /workflows/{id}/design stores the design, then runs the stages in one transaction (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Stages 1-3: schema copies, processors (re-points), caches

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/Design/SharedStages.cs`
- Modify: `DesignStages.cs`, `WorkflowServiceCollectionExtensions.cs`
- Modify: `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs` (`AllStages`, `ProcessorAsync` hash, `CacheAsync`)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/DesignSharedStagesTests.cs`

**Interfaces:**
- Consumes: `DesignRun.UnitAsync`, `DesignFields.Apply/UpdateOf/Failures`.
- Produces: `SchemaStage(BaseDbContext, IValidator<SchemaCreateDto>, IEntityMapper<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto>)`, `ProcessorStage(BaseDbContext, IValidator<ProcessorUpdateDto>, IEntityMapper<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto>)`, `CacheStage(BaseDbContext, IValidator<CacheUpdateDto>, IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>)`; `GraphHarness.CacheAsync(string root)`.

- [ ] **Step 1: Write the failing tests** (`src/tests/BaseApi.Tests/WorkflowGraph/DesignSharedStagesTests.cs`)

```csharp
using BaseApi.Service.Features.Workflow.Design;
using Microsoft.EntityFrameworkCore;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8 §4.3 stages 1-3: shared entities, last write wins.</summary>
public sealed class DesignSharedStagesTests
{
    private static string Describe(DesignOutcomeDto o) => string.Join("; ", o.Errors.Select(e => $"{e.Kind}/{e.Stage}/{e.Field}: {e.Message}"));

    [Fact]
    public async Task ASchemaCopyKeepsTheOriginalsNameAndVersionAndTheSlotPointsAtIt()
    {
        await using var h = new GraphHarness();
        var original = await h.SchemaAsync("cfg", "1.2.3");
        var proc = await h.ProcessorAsync(config: original);
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc)]);
        var copy = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            processors: [new DesignProcessorDto(proc, null, new() { ["config"] = copy })],
            schemas: [new DesignSchemaDto(copy, "cfg", "1.2.3", null, """{"type":"string"}""")]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        Assert.Equal(copy, (await h.Db.Processors.SingleAsync(p => p.Id == proc, h.Ct)).ConfigSchemaId);
        var row = await h.Db.Schemas.SingleAsync(s => s.Id == copy, h.Ct);
        Assert.Equal(("cfg", "1.2.3"), (row.Name, row.Version));
        Assert.True(await h.Db.Schemas.AnyAsync(s => s.Id == original, h.Ct), "other processors keep the original");
    }

    [Fact]
    public async Task AFailedCopyIsAnErrorAndItsRepointIsSkippedWithAnErrorOfItsOwn()
    {
        await using var h = new GraphHarness();
        var original = await h.SchemaAsync("cfg");
        var proc = await h.ProcessorAsync(config: original);
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc)]);
        var copy = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            processors: [new DesignProcessorDto(proc, null, new() { ["config"] = copy })],
            schemas: [new DesignSchemaDto(copy, "cfg", "1.0.0", null, "not json")]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("schema", copy, "schemas", "definition"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("processor", proc, "processors", "configSchemaId"));
        h.Forget();
        Assert.Equal(original, (await h.Db.Processors.SingleAsync(p => p.Id == proc, h.Ct)).ConfigSchemaId);
    }

    [Fact]
    public async Task AProcessorIsLastWriteWins()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc)]);
        // someone else changes the processor after the designer opened the workflow
        h.Tick();
        var row = await h.Db.Processors.SingleAsync(p => p.Id == proc, h.Ct);
        row.Description = "elsewhere";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(processors: [new DesignProcessorDto(proc, F("""{"name":"renamed"}"""), null)]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var after = await h.Db.Processors.SingleAsync(p => p.Id == proc, h.Ct);
        Assert.Equal(("renamed", "elsewhere"), (after.Name, after.Description));
    }

    [Fact]
    public async Task ACacheChangeBreakingACrudRuleIsAnErrorOnItsField()
    {
        await using var h = new GraphHarness();
        var cache = await h.CacheAsync("root-a");
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(await h.ProcessorAsync())]);

        var outcome = await h.Syncer().SaveAsync(wf, Of(caches: [new DesignCacheDto(cache, F("""{"root":"has:colon"}"""))]), h.Ct);

        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("cache", cache, "caches", "root"), (error.Kind, error.Id, error.Stage, error.Field));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.DesignSharedStagesTests"
```

Expected: build error `GraphHarness does not contain a definition for 'CacheAsync'`; after Step 3's harness part only, the four tests FAIL (no stage applies anything: copy not inserted, no errors).

- [ ] **Step 3: Implement**

`GraphHarness.cs`:
- `ProcessorAsync`: `SourceHash = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"),` (64 lowercase hex: the processor CRUD rule the stage now runs).
- add after `AssignmentAsync`:

```csharp
    public async Task<Guid> CacheAsync(string root)
    {
        var c = new CacheEntity { Id = Guid.NewGuid(), Name = "cache", Version = "1.0.0", Root = root, Items = "{}" };
        Db.Add(c);
        await Db.SaveChangesAsync(Ct);
        return c.Id;
    }
```

- `AllStages()` becomes:

```csharp
    public IReadOnlyList<IDesignStage> AllStages() =>
    [
        new SchemaStage(Db, new SchemaCreateDtoValidator(), new SchemaEntityMapper()),
        new ProcessorStage(Db, new ProcessorUpdateDtoValidator(), new ProcessorEntityMapper()),
        new CacheStage(Db, new CacheUpdateDtoValidator(), new CacheEntityMapper()),
    ];
```

`src/BaseApi.Service/Features/Workflow/Design/SharedStages.cs`:

```csharp
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>Stage 1: insert each schema copy (new id, the original's name and version), judged by the schema CRUD's rules.</summary>
internal sealed class SchemaStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<SchemaCreateDto> _validator;
    private readonly IEntityMapper<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto> _mapper;

    public SchemaStage(BaseDbContext db, IValidator<SchemaCreateDto> validator,
        IEntityMapper<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        foreach (var s in run.Request.Schemas ?? [])
        {
            var applied = await run.UnitAsync("schema", s.Id, "schemas", async () =>
            {
                var dto = new SchemaCreateDto(s.Name, s.Version, s.Description, s.Definition);
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                var entity = _mapper.ToEntity(dto);
                entity.Id = s.Id;
                _db.Add(entity);
                return problems;
            }, ct);
            if (!applied) run.FailedSchemas.Add(s.Id);
        }
    }
}

/// <summary>
/// Stage 2: a processor's fields, and its slots re-pointed to their copies. Shared, so no conflict check
/// (last write wins). A re-point to a copy that failed in stage 1 is skipped, with an error of its own.
/// </summary>
internal sealed class ProcessorStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<ProcessorUpdateDto> _validator;
    private readonly IEntityMapper<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto> _mapper;

    public ProcessorStage(BaseDbContext db, IValidator<ProcessorUpdateDto> validator,
        IEntityMapper<ProcessorEntity, ProcessorCreateDto, ProcessorUpdateDto, ProcessorReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        foreach (var p in run.Request.Processors ?? [])
        {
            var slots = p.Slots ?? new Dictionary<string, Guid>();
            foreach (var (slot, _) in slots.Where(kv => run.FailedSchemas.Contains(kv.Value)))
                run.Fail("processor", p.Id, "processors", $"{slot}SchemaId", $"Not re-pointed: the {slot} schema copy failed.");

            await run.UnitAsync("processor", p.Id, "processors", async () =>
            {
                var entity = await _db.Set<ProcessorEntity>().FirstOrDefaultAsync(x => x.Id == p.Id, ct);
                if (entity is null) return [new FieldError(null, "This processor no longer exists.")];
                var errors = new List<FieldError>();
                var dto = DesignFields.Apply(DesignFields.UpdateOf(entity), p.Fields, errors);
                foreach (var (slot, schemaId) in slots.Where(kv => !run.FailedSchemas.Contains(kv.Value)))
                    dto = slot switch
                    {
                        "input" => dto with { InputSchemaId = schemaId },
                        "output" => dto with { OutputSchemaId = schemaId },
                        _ => dto with { ConfigSchemaId = schemaId },
                    };
                if (errors.Count > 0) return errors;
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                _mapper.Update(dto, entity);
                return problems;
            }, ct);
        }
    }
}

/// <summary>Stage 3: a cache's fields. Shared, so no conflict check (last write wins).</summary>
internal sealed class CacheStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<CacheUpdateDto> _validator;
    private readonly IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> _mapper;

    public CacheStage(BaseDbContext db, IValidator<CacheUpdateDto> validator,
        IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        foreach (var c in run.Request.Caches ?? [])
            await run.UnitAsync("cache", c.Id, "caches", async () =>
            {
                var entity = await _db.Set<CacheEntity>().FirstOrDefaultAsync(x => x.Id == c.Id, ct);
                if (entity is null) return [new FieldError(null, "This cache no longer exists.")];
                var errors = new List<FieldError>();
                var dto = DesignFields.Apply(DesignFields.UpdateOf(entity), c.Fields, errors);
                if (errors.Count > 0) return errors;
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                _mapper.Update(dto, entity);
                return problems;
            }, ct);
    }
}
```

`DesignStages.Ordered` becomes:

```csharp
    public static IReadOnlyList<IDesignStage> Ordered(IServiceProvider sp) =>
    [
        sp.GetRequiredService<SchemaStage>(),
        sp.GetRequiredService<ProcessorStage>(),
        sp.GetRequiredService<CacheStage>(),
    ];
```

(add `using Microsoft.Extensions.DependencyInjection;`). `WorkflowServiceCollectionExtensions.cs`, before the syncer registration:

```csharp
        services.AddScoped<SchemaStage>();
        services.AddScoped<ProcessorStage>();
        services.AddScoped<CacheStage>();
```

- [ ] **Step 4: Run to verify they pass**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.DesignSharedStagesTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-namespace "BaseApi.Tests.WorkflowGraph"
```

Expected: 4 passed; the namespace passes.

- [ ] **Step 5: Commit**

```powershell
git add src/BaseApi.Service/Features/Workflow src/tests/BaseApi.Tests/WorkflowGraph
git commit -m "feat(studio): design stages 1-3: schema copies keep name and version, processors re-point, caches; last write wins (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Stages 4-5: step fields with the conflict check, then wires

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/Design/StepStages.cs`
- Modify: `DesignStages.cs`, `WorkflowServiceCollectionExtensions.cs`, `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs` (`AllStages`)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/DesignStepStagesTests.cs`

**Interfaces:**
- Produces: `StepStage(BaseDbContext, IValidator<StepUpdateDto>, IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto>)` (checks the stamp of **every** step in the body, applies its fields, records failures in `run.FailedSteps`), `WireStage(BaseDbContext, IValidator<StepUpdateDto>)` (replaces `nextStepIds` with `StepJunctions.SyncNextStepsAsync(replaceExisting: true)`; never re-checks the stamp).

- [ ] **Step 1: Write the failing tests** (`src/tests/BaseApi.Tests/WorkflowGraph/DesignStepStagesTests.cs`)

```csharp
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow.Design;
using Microsoft.EntityFrameworkCore;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8 §4.3 stages 4-5: steps are owned, so they keep the conflict check; any wiring is allowed.</summary>
public sealed class DesignStepStagesTests
{
    private static string Describe(DesignOutcomeDto o) => string.Join("; ", o.Errors.Select(e => $"{e.Kind}/{e.Stage}/{e.Field}: {e.Message}"));

    private static async Task<(Guid Wf, Guid A, Guid B, DateTime StampA, DateTime StampB)> TwoSteps(GraphHarness h)
    {
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        return (wf, a, b, graph.Steps.Single(s => s.Id == a).UpdatedAt, graph.Steps.Single(s => s.Id == b).UpdatedAt);
    }

    private static async Task<List<Guid>> NextOf(GraphHarness h, Guid step)
    {
        h.Forget();
        return await h.Db.StepNextSteps.Where(j => j.StepId == step).Select(j => j.NextStepId).ToListAsync(h.Ct);
    }

    [Fact]
    public async Task AStepChangeBreakingACrudRuleIsAnErrorNamingItsField()
    {
        await using var h = new GraphHarness();
        var (wf, a, _, stampA, _) = await TwoSteps(h);

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, stampA, F("""{"version":"abc"}"""), null)]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("step", a, "steps", "version"));
    }

    [Fact]
    public async Task AStepChangedSinceItWasOpenedFailsWithTheConflict()
    {
        await using var h = new GraphHarness();
        var (wf, a, _, stampA, _) = await TwoSteps(h);
        h.Tick();
        var row = await h.Db.Steps.SingleAsync(s => s.Id == a, h.Ct);
        row.Description = "someone else";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, stampA, F("""{"name":"mine"}"""), null)]), h.Ct);

        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("step", a, "steps", DesignRun.Conflict), (error.Kind, error.Id, error.Stage, error.Message));
    }

    [Fact]
    public async Task FieldsAndWiringOnTheSameStepApplyWithoutConflictingWithThemselves()
    {
        // Review Focus 2: stage 4 moves the step's stamp; stage 5 must not check it again.
        await using var h = new GraphHarness();
        var (wf, a, b, stampA, _) = await TwoSteps(h);
        h.Tick();

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, stampA, F("""{"description":"rewired"}"""), [])]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        Assert.Empty(await NextOf(h, a));
        Assert.Equal("rewired", (await h.Db.Steps.SingleAsync(s => s.Id == a, h.Ct)).Description);
        Assert.True(await h.Db.Steps.AnyAsync(s => s.Id == b, h.Ct), "unwiring never deletes a step");
    }

    [Fact]
    public async Task ALoopIsWritten()
    {
        await using var h = new GraphHarness();
        var (wf, a, b, _, stampB) = await TwoSteps(h);

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(b, stampB, null, [a])]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        Assert.Equal([a], await NextOf(h, b));
    }

    [Fact]
    public async Task AFailedStepsWiresAreSkippedWithAnErrorOfTheirOwn()
    {
        await using var h = new GraphHarness();
        var (wf, a, _, stampA, _) = await TwoSteps(h);

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, stampA, F("""{"version":"abc"}"""), [])]), h.Ct);

        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage) == ("step", a, "steps"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("step", a, "wires", "nextStepIds"));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.DesignStepStagesTests"
```

Expected: FAIL (no step stage: no errors, nothing rewired).

- [ ] **Step 3: Implement** (`src/BaseApi.Service/Features/Workflow/Design/StepStages.cs`)

```csharp
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Step;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Stage 4: every step the design names. Steps are owned, so each is checked against the stamp the
/// designer loaded, here and only here (stage 5 would see the stamp this stage moved); then its fields,
/// judged by the step CRUD's rules. A step that fails here is remembered, so stage 5 skips its wires.
/// </summary>
internal sealed class StepStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<StepUpdateDto> _validator;
    private readonly IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> _mapper;

    public StepStage(BaseDbContext db, IValidator<StepUpdateDto> validator,
        IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        foreach (var s in run.Request.Steps ?? [])
        {
            var applied = await run.UnitAsync("step", s.Id, "steps", async () =>
            {
                var entity = await _db.Set<StepEntity>().FirstOrDefaultAsync(x => x.Id == s.Id, ct);
                if (entity is null) return [new FieldError(null, "This step no longer exists.")];
                if (DesignRun.IsStale(entity.UpdatedAt, s.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
                if (s.Fields is not { Count: > 0 }) return [];
                var errors = new List<FieldError>();
                var dto = DesignFields.Apply(DesignFields.UpdateOf(entity), s.Fields, errors);
                if (errors.Count > 0) return errors;
                var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
                if (problems.Count > 0) return problems;
                _mapper.Update(dto, entity);
                return problems;
            }, ct);
            if (!applied) run.FailedSteps.Add(s.Id);
        }
    }
}

/// <summary>
/// Stage 5: replaces each changed step's next steps. No cycle check: a design may be anything, and starting
/// is when cycles are judged (spec §5). A missing next step is a foreign-key error on that step.
/// </summary>
internal sealed class WireStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<StepUpdateDto> _validator;

    public WireStage(BaseDbContext db, IValidator<StepUpdateDto> validator)
    {
        _db = db;
        _validator = validator;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        foreach (var s in (run.Request.Steps ?? []).Where(x => x.NextStepIds is not null))
        {
            if (run.FailedSteps.Contains(s.Id))
            {
                run.Fail("step", s.Id, "wires", "nextStepIds", "Not rewired: the step itself failed.");
                continue;
            }
            await run.UnitAsync("step", s.Id, "wires", async () =>
            {
                var entity = await _db.Set<StepEntity>().FirstOrDefaultAsync(x => x.Id == s.Id, ct);
                if (entity is null) return [new FieldError(null, "This step no longer exists.")];
                var problems = DesignFields.Failures(await _validator.ValidateAsync(DesignFields.UpdateOf(entity) with { NextStepIds = s.NextStepIds }, ct));
                if (problems.Count > 0) return problems;
                // wires live only in StepNextSteps: force the stamp, as the graph saver does, so the next stale save conflicts
                _db.Entry(entity).Property(e => e.UpdatedAt).IsModified = true;
                await StepJunctions.SyncNextStepsAsync(_db, s.Id, s.NextStepIds, replaceExisting: true, ct);
                return problems;
            }, ct);
        }
    }
}
```

`DesignStages.Ordered` appends `sp.GetRequiredService<StepStage>(), sp.GetRequiredService<WireStage>(),`; `WorkflowServiceCollectionExtensions.cs` adds `services.AddScoped<StepStage>(); services.AddScoped<WireStage>();`; `GraphHarness.AllStages()` appends:

```csharp
        new StepStage(Db, new StepUpdateDtoValidator(), new StepEntityMapper()),
        new WireStage(Db, new StepUpdateDtoValidator()),
```

- [ ] **Step 4: Run to verify they pass**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.DesignStepStagesTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-namespace "BaseApi.Tests.WorkflowGraph"
```

Expected: 5 passed; the namespace passes.

- [ ] **Step 5: Commit**

```powershell
git add src/BaseApi.Service/Features/Workflow src/tests/BaseApi.Tests/WorkflowGraph
git commit -m "feat(studio): design stages 4-5: step fields with the per-step conflict check, then wires; loops allowed (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Stages 6-7: assignments created, updated and deleted; the workflow and its links

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/Design/OwnedStages.cs`
- Modify: `DesignStages.cs`, `WorkflowServiceCollectionExtensions.cs`, `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs` (`AllStages`)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/DesignOwnedStagesTests.cs`

**Interfaces:**
- Produces: `AssignmentStage(BaseDbContext, IValidator<AssignmentCreateDto>, IValidator<AssignmentUpdateDto>, IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto>)` (fills `run.CreatedAssignments` / `run.DeletedAssignments`), `WorkflowStage(BaseDbContext, IValidator<WorkflowUpdateDto>, IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto>)` (runs when the workflow has fields, entry or cache lists, or the assignment links changed).

- [ ] **Step 1: Write the failing tests** (`src/tests/BaseApi.Tests/WorkflowGraph/DesignOwnedStagesTests.cs`)

```csharp
using BaseApi.Service.Features.Workflow.Design;
using Microsoft.EntityFrameworkCore;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Plan 8 §4.3 stages 6-7, and the whole run: every error at once, or everything applied.</summary>
public sealed class DesignOwnedStagesTests
{
    private static string Describe(DesignOutcomeDto o) => string.Join("; ", o.Errors.Select(e => $"{e.Kind}/{e.Stage}/{e.Field}: {e.Message}"));

    [Fact]
    public async Task AssignmentsAreCreatedUpdatedAndDeletedAndTheWorkflowLinksFollow()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var (s1, s2, s3) = (await h.StepAsync(proc, "s1"), await h.StepAsync(proc, "s2"), await h.StepAsync(proc, "s3"));
        var x = await h.AssignmentAsync(s2);
        var y = await h.AssignmentAsync(s3);
        var wf = await h.WorkflowAsync("wf", [s1, s2, s3], [x, y]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stamp = (Guid id) => loaded.Assignments.Single(a => a.Id == id).UpdatedAt;
        var made = Guid.NewGuid();
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, null, null),
            assignments:
            [
                new DesignAssignmentDto("create", made, s1, null, F("""{"name":"s1-assignment","version":"1.0.0","payload":"{\"a\":1}"}""")),
                new DesignAssignmentDto("update", x, s2, stamp(x), F("""{"payload":"{\"b\":2}"}""")),
                new DesignAssignmentDto("delete", y, s3, stamp(y), null),
            ]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var links = await h.Db.WorkflowAssignments.Where(j => j.WorkflowId == wf).Select(j => j.AssignmentId).ToListAsync(h.Ct);
        Assert.Equal(new[] { made, x }.OrderBy(g => g), links.OrderBy(g => g));
        Assert.Equal("""{"b":2}""", (await h.Db.Assignments.SingleAsync(a => a.Id == x, h.Ct)).Payload);
        Assert.False(await h.Db.Assignments.AnyAsync(a => a.Id == y, h.Ct));
        Assert.Equal(s1, (await h.Db.Assignments.SingleAsync(a => a.Id == made, h.Ct)).StepId);
    }

    [Fact]
    public async Task ACreatedAssignmentBreakingACrudRuleIsAnErrorOnItsField()
    {
        await using var h = new GraphHarness();
        var s1 = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [s1]);
        var made = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(assignments:
            [new DesignAssignmentDto("create", made, s1, null, F("""{"name":"n","version":"1.0.0","payload":"not json"}"""))]), h.Ct);

        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("assignment", made, "assignments", "payload"));
    }

    [Fact]
    public async Task NoEntryStepIsAWorkflowError()
    {
        await using var h = new GraphHarness();
        var s1 = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [s1]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);

        var outcome = await h.Syncer().SaveAsync(wf, Of(workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, [], null)), h.Ct);

        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("workflow", wf, "workflow", "entryStepIds"), (error.Kind, error.Id, error.Stage, error.Field));
        Assert.Contains("at least one", error.Message);
    }

    [Fact]
    public async Task EveryErrorIsReportedNotOnlyTheFirst()
    {
        await using var h = new GraphHarness();
        var s1 = await h.StepAsync(await h.ProcessorAsync());
        var cache = await h.CacheAsync("root-a");
        var wf = await h.WorkflowAsync("wf", [s1]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, F("""{"cronExpression":"not a cron"}"""), null, null),
            steps: [new DesignStepDto(s1, loaded.Steps.Single().UpdatedAt, F("""{"version":"abc"}"""), null)],
            caches: [new DesignCacheDto(cache, F("""{"root":"a:b"}"""))]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Stage, e.Field) == ("cache", "caches", "root"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Stage, e.Field) == ("step", "steps", "version"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Stage, e.Field) == ("workflow", "workflow", "cronExpression"));
        // in stage order
        Assert.Equal(["caches", "steps", "workflow"], outcome.Errors.Select(e => e.Stage).Distinct());
    }

    [Fact]
    public async Task AValidDesignAlignsTheRealEntitiesInFullAndEmptiesTheStoredDesign()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, F("""{"description":"designed"}"""), [a, b], null),
            steps: [new DesignStepDto(a, loaded.Steps.Single(s => s.Id == a).UpdatedAt, F("""{"name":"renamed"}"""), [])],
            layout: """{"v":1,"parked":["a","b"]}"""), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        var graph = await h.Reader.ReadAsync(wf, h.Ct);
        Assert.Null(graph.Design);
        Assert.Equal("designed", graph.Workflow.Description);
        Assert.Equal(new[] { a, b }.OrderBy(g => g), graph.Workflow.EntryStepIds!.OrderBy(g => g));
        Assert.Equal("renamed", graph.Steps.Single(s => s.Id == a).Name);
        Assert.Empty(graph.Steps.Single(s => s.Id == a).NextStepIds!);
    }

    [Fact]
    public async Task ANotStartableDesignIsWritten()
    {
        // spec §6.7: a loop and an unwired step are start problems, not design errors
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var c = await h.StepAsync(proc, "c");
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            steps: [new DesignStepDto(b, loaded.Steps.Single(s => s.Id == b).UpdatedAt, null, [a])],
            layout: $$"""{"v":1,"parked":["{{c}}"]}"""), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        Assert.Equal([a], (await h.Reader.ReadAsync(wf, h.Ct)).Steps.Single(s => s.Id == b).NextStepIds!);
    }

    [Fact]
    public async Task AWorkflowChangeWithTheLoadedStampAppliesAfterTheStore()
    {
        // Review Focus 1: the store before the stages must not make the workflow stage conflict.
        await using var h = new GraphHarness();
        var s1 = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [s1]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Tick();

        var outcome = await h.Syncer().SaveAsync(wf, Of(workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, F("""{"description":"d"}"""), null, null)), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.DesignOwnedStagesTests"
```

Expected: FAIL (assignments and workflow untouched; no workflow errors).

- [ ] **Step 3: Implement** (`src/BaseApi.Service/Features/Workflow/Design/OwnedStages.cs`)

```csharp
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Stage 6: this workflow's assignments (owned: the studio gives every new one a new id). Create inserts
/// a row with the design's id (stage 7 links it); update changes it in place after the conflict check;
/// delete unlinks it from this workflow and deletes the row in one save (an assignment another workflow
/// still lists is refused by its restrict foreign key, and that is this assignment's error).
/// </summary>
internal sealed class AssignmentStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<AssignmentCreateDto> _createValidator;
    private readonly IValidator<AssignmentUpdateDto> _updateValidator;
    private readonly IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto> _mapper;

    public AssignmentStage(BaseDbContext db, IValidator<AssignmentCreateDto> createValidator, IValidator<AssignmentUpdateDto> updateValidator,
        IEntityMapper<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto> mapper)
    {
        _db = db;
        _createValidator = createValidator;
        _updateValidator = updateValidator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        foreach (var a in run.Request.Assignments ?? [])
        {
            switch (a.Op)
            {
                case "create":
                    if (await run.UnitAsync("assignment", a.Id, "assignments", () => CreateAsync(a, ct), ct))
                        run.CreatedAssignments.Add(a.Id);
                    break;
                case "update":
                    await run.UnitAsync("assignment", a.Id, "assignments", () => UpdateAsync(a, ct), ct);
                    break;
                default:
                    if (await run.UnitAsync("assignment", a.Id, "assignments", () => DeleteAsync(run.WorkflowId, a, ct), ct))
                        run.DeletedAssignments.Add(a.Id);
                    break;
            }
        }
    }

    private async Task<List<FieldError>> CreateAsync(DesignAssignmentDto a, CancellationToken ct)
    {
        var errors = new List<FieldError>();
        var fields = DesignFields.Apply(new AssignmentUpdateDto("", "", null, a.StepId, ""), a.Fields, errors);
        if (errors.Count > 0) return errors;
        var dto = new AssignmentCreateDto(fields.Name, fields.Version, fields.Description, a.StepId, fields.Payload);
        var problems = DesignFields.Failures(await _createValidator.ValidateAsync(dto, ct));
        if (problems.Count > 0) return problems;
        var entity = _mapper.ToEntity(dto);
        entity.Id = a.Id;
        _db.Add(entity);
        return problems;
    }

    private async Task<List<FieldError>> UpdateAsync(DesignAssignmentDto a, CancellationToken ct)
    {
        var entity = await _db.Set<AssignmentEntity>().FirstOrDefaultAsync(x => x.Id == a.Id, ct);
        if (entity is null) return [new FieldError(null, "This assignment no longer exists.")];
        if (DesignRun.IsStale(entity.UpdatedAt, a.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
        var errors = new List<FieldError>();
        // the step an assignment belongs to is never edited here
        var dto = DesignFields.Apply(DesignFields.UpdateOf(entity), a.Fields, errors) with { StepId = entity.StepId };
        if (errors.Count > 0) return errors;
        var problems = DesignFields.Failures(await _updateValidator.ValidateAsync(dto, ct));
        if (problems.Count > 0) return problems;
        _mapper.Update(dto, entity);
        return problems;
    }

    private async Task<List<FieldError>> DeleteAsync(Guid workflowId, DesignAssignmentDto a, CancellationToken ct)
    {
        var entity = await _db.Set<AssignmentEntity>().FirstOrDefaultAsync(x => x.Id == a.Id, ct);
        if (entity is null) return []; // already gone: what was asked
        if (DesignRun.IsStale(entity.UpdatedAt, a.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];
        // unlink, then delete the row: one save, ordered by EF from the foreign keys
        var links = await _db.Set<WorkflowAssignments>().Where(j => j.WorkflowId == workflowId && j.AssignmentId == a.Id).ToListAsync(ct);
        _db.RemoveRange(links);
        _db.Remove(entity);
        return [];
    }
}

/// <summary>
/// Stage 7: the workflow's fields, entry steps and caches, and the assignment links stage 6 produced.
/// Owned: checked against the stamp the designer loaded. "At least one entry step" is the workflow
/// CRUD's own rule. Runs only when something of the workflow changed.
/// </summary>
internal sealed class WorkflowStage : IDesignStage
{
    private readonly BaseDbContext _db;
    private readonly IValidator<WorkflowUpdateDto> _validator;
    private readonly IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> _mapper;

    public WorkflowStage(BaseDbContext db, IValidator<WorkflowUpdateDto> validator,
        IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> mapper)
    {
        _db = db;
        _validator = validator;
        _mapper = mapper;
    }

    public async Task RunAsync(DesignRun run, CancellationToken ct)
    {
        var w = run.Request.Workflow;
        var linksChanged = run.CreatedAssignments.Count > 0 || run.DeletedAssignments.Count > 0;
        var changed = w is not null && (w.Fields is { Count: > 0 } || w.EntryStepIds is not null || w.CacheIds is not null);
        if (!changed && !linksChanged) return;

        await run.UnitAsync("workflow", run.WorkflowId, "workflow", async () =>
        {
            var entity = await _db.Set<WorkflowEntity>().FirstOrDefaultAsync(x => x.Id == run.WorkflowId, ct);
            if (entity is null) return [new FieldError(null, "This workflow no longer exists.")];
            if (DesignRun.IsStale(entity.UpdatedAt, w?.UpdatedAt)) return [new FieldError(null, DesignRun.Conflict)];

            var entry = w?.EntryStepIds ?? await _db.Set<WorkflowEntrySteps>()
                .Where(j => j.WorkflowId == run.WorkflowId).Select(j => j.StepId).ToListAsync(ct);
            var caches = w?.CacheIds ?? await _db.Set<WorkflowCaches>()
                .Where(j => j.WorkflowId == run.WorkflowId).Select(j => j.CacheId).ToListAsync(ct);
            var linked = await _db.Set<WorkflowAssignments>()
                .Where(j => j.WorkflowId == run.WorkflowId).Select(j => j.AssignmentId).ToListAsync(ct);
            var assignments = linked.Where(id => !run.DeletedAssignments.Contains(id))
                .Concat(run.CreatedAssignments.Where(id => !linked.Contains(id))).ToList();

            var errors = new List<FieldError>();
            var dto = DesignFields.Apply(
                new WorkflowUpdateDto(entity.Name, entity.Version, entity.Description, entry, assignments, caches, entity.CronExpression),
                w?.Fields, errors);
            if (errors.Count > 0) return errors;
            var problems = DesignFields.Failures(await _validator.ValidateAsync(dto, ct));
            if (problems.Count > 0) return problems;
            _mapper.Update(dto, entity);
            // entry, cache and assignment changes are junction-only: force the stamp, as the graph saver does
            _db.Entry(entity).Property(e => e.UpdatedAt).IsModified = true;
            await WorkflowJunctions.SyncAsync(_db, run.WorkflowId, dto.EntryStepIds, dto.AssignmentIds, dto.CacheIds, replaceExisting: true, ct);
            return problems;
        }, ct);
    }
}
```

`DesignStages.Ordered` appends `sp.GetRequiredService<AssignmentStage>(), sp.GetRequiredService<WorkflowStage>(),`; `WorkflowServiceCollectionExtensions.cs` adds `services.AddScoped<AssignmentStage>(); services.AddScoped<WorkflowStage>();`; `GraphHarness.AllStages()` appends:

```csharp
        new AssignmentStage(Db, new AssignmentCreateDtoValidator(), new AssignmentUpdateDtoValidator(), new AssignmentEntityMapper()),
        new WorkflowStage(Db, new WorkflowUpdateDtoValidator(), new WorkflowEntityMapper()),
```

- [ ] **Step 4: Run to verify they pass, then the whole hermetic suite**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.DesignOwnedStagesTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 7 passed; the hermetic suite has 0 failures (it was 1950+ green before this plan).

- [ ] **Step 5: Commit**

```powershell
git add src/BaseApi.Service/Features/Workflow src/tests/BaseApi.Tests/WorkflowGraph
git commit -m "feat(studio): design stages 6-7: assignments created, updated and deleted; the workflow and its links (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Postgres integration tests; deploy BaseApi

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/WorkflowDesignLiveTests.cs`

**Interfaces:**
- Consumes: the deployed `PUT /api/v1/workflows/{id}/design` and the CRUD endpoints, over HTTP (as `WorkflowGraphLiveTests` does).

- [ ] **Step 1: Write the live tests** (`src/tests/BaseApi.Tests/Live/WorkflowDesignLiveTests.cs`)

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Plan 8's design save against the real Postgres (spec §8): what InMemory cannot show, the rollback,
/// the savepoints, foreign keys and unique constraints. Each test builds its own rows through the CRUD
/// endpoints and removes them afterwards.
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class WorkflowDesignLiveTests : IAsyncLifetime
{
    private const string Conflict = "changed by someone else since you opened it";

    private readonly HttpClient _http = new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(30) };
    private readonly List<Guid> _workflows = [], _steps = [], _caches = [], _schemas = [];
    private Guid _processor;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static string Tag() => $"design-live-{Guid.NewGuid():N}"[..24];
    private static string Hash() => Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled) return;
        _processor = await PostAsync("processors", new { name = Tag(), version = "1.0.0", sourceHash = Hash() });
    }

    public async ValueTask DisposeAsync()
    {
        // FK order: workflows (they cascade their links), their steps' assignments, unwired steps, steps,
        // caches; then the processor's slots cleared so the schemas can go, then the processor.
        foreach (var w in _workflows) await TryAsync(() => _http.DeleteAsync($"/api/v1/workflows/{w}"));
        await TryAsync(async () =>
        {
            var all = JsonDocument.Parse(await _http.GetStringAsync("/api/v1/assignments")).RootElement;
            foreach (var a in all.EnumerateArray().Where(a => _steps.Contains(a.GetProperty("stepId").GetGuid())))
                await _http.DeleteAsync($"/api/v1/assignments/{a.GetProperty("id").GetGuid()}");
        });
        foreach (var s in _steps) await TryAsync(() => PutStepAsync(s, next: []));
        foreach (var s in _steps) await TryAsync(() => _http.DeleteAsync($"/api/v1/steps/{s}"));
        foreach (var c in _caches) await TryAsync(() => _http.DeleteAsync($"/api/v1/caches/{c}"));
        if (_processor != Guid.Empty)
        {
            await TryAsync(() => PutProcessorAsync(clearSlots: true));
            foreach (var s in _schemas) await TryAsync(() => _http.DeleteAsync($"/api/v1/schemas/{s}"));
            await TryAsync(() => _http.DeleteAsync($"/api/v1/processors/{_processor}"));
        }
        _http.Dispose();
    }

    private static async Task TryAsync(Func<Task> work)
    {
        try { await work(); } catch (Exception) { }
    }

    private async Task<Guid> PostAsync(string resource, object body)
    {
        using var response = await _http.PostAsJsonAsync($"/api/v1/{resource}", body, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.IsSuccessStatusCode, $"POST {resource} -> {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.GetProperty("id").GetGuid();
    }

    private async Task<JsonElement> GetAsync(string path) =>
        JsonDocument.Parse(await _http.GetStringAsync($"/api/v1/{path}", Ct)).RootElement.Clone();

    private static string? Text(JsonElement e, string name) => e.GetProperty(name).ValueKind == JsonValueKind.Null ? null : e.GetProperty(name).GetString();
    private static string Stamp(JsonElement dto) => dto.GetProperty("updatedAt").GetString()!;

    private async Task<Guid> StepAsync(params Guid[] next)
    {
        var id = await PostAsync("steps", new { name = Tag(), version = "1.0.0", description = (string?)null, processorId = _processor, nextStepIds = next, entryCondition = 1 });
        _steps.Add(id);
        return id;
    }

    private async Task<Guid> WorkflowAsync(Guid[] entry, Guid[]? assignments = null)
    {
        var id = await PostAsync("workflows", new { name = Tag(), version = "1.0.0", entryStepIds = entry, assignmentIds = assignments ?? [], cacheIds = Array.Empty<Guid>() });
        _workflows.Add(id);
        return id;
    }

    private async Task<Guid> CacheAsync()
    {
        var id = await PostAsync("caches", new { name = Tag(), version = "1.0.0", root = Tag(), items = "{}" });
        _caches.Add(id);
        return id;
    }

    private async Task PutStepAsync(Guid id, Guid[]? next = null, string? description = null)
    {
        var s = await GetAsync($"steps/{id}");
        using var r = await _http.PutAsJsonAsync($"/api/v1/steps/{id}", new
        {
            name = Text(s, "name"), version = Text(s, "version"), description = description ?? Text(s, "description"),
            processorId = s.GetProperty("processorId").GetGuid(),
            nextStepIds = next ?? s.GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()).ToArray(),
            entryCondition = s.GetProperty("entryCondition").GetInt32(),
        });
    }

    private async Task PutProcessorAsync(string? description = null, Guid? configSchemaId = null, bool clearSlots = false)
    {
        var p = await GetAsync($"processors/{_processor}");
        Guid? Slot(string name) => clearSlots ? null : p.GetProperty(name).ValueKind == JsonValueKind.Null ? null : p.GetProperty(name).GetGuid();
        using var r = await _http.PutAsJsonAsync($"/api/v1/processors/{_processor}", new
        {
            name = Text(p, "name"), version = Text(p, "version"), description = description ?? Text(p, "description"),
            sourceHash = Text(p, "sourceHash"), instanceId = Text(p, "instanceId"),
            inputSchemaId = Slot("inputSchemaId"), outputSchemaId = Slot("outputSchemaId"), configSchemaId = configSchemaId ?? Slot("configSchemaId"),
        });
        Assert.True(r.IsSuccessStatusCode, $"PUT processor -> {(int)r.StatusCode}");
    }

    private static object Body(object? workflow = null, object[]? steps = null, object[]? processors = null,
        object[]? caches = null, object[]? schemas = null, object[]? assignments = null) =>
        new { workflow, steps, processors, caches, schemas, assignments, layout = new { v = 1 } };

    private async Task<(bool Applied, JsonElement[] Errors)> PutDesignAsync(Guid wf, object body)
    {
        using var r = await _http.PutAsJsonAsync($"/api/v1/workflows/{wf}/design", body, Ct);
        var text = await r.Content.ReadAsStringAsync(Ct);
        Assert.True(r.StatusCode == HttpStatusCode.OK, $"PUT design -> {(int)r.StatusCode}: {text}");
        var json = JsonDocument.Parse(text).RootElement;
        return (json.GetProperty("applied").GetBoolean(), json.GetProperty("errors").EnumerateArray().Select(e => e.Clone()).ToArray());
    }

    private static string Describe(JsonElement[] errors) => string.Join("; ", errors.Select(e => e.GetRawText()));

    private static bool Is(JsonElement e, string kind, Guid id, string? field) =>
        e.GetProperty("kind").GetString() == kind && e.GetProperty("id").GetGuid() == id && Text(e, "field") == field;

    private async Task<string> StepStampAsync(Guid id) => Stamp(await GetAsync($"steps/{id}"));

    [Fact]
    public async Task ADesignWithAnInvalidStepIsStoredLeavesTheRealEntitiesUntouchedAndReportsEveryError()
    {
        RealStack.SkipUnlessEnabled();
        var b = await StepAsync();
        var a = await StepAsync(b);
        var wf = await WorkflowAsync([a]);
        var workflowStamp = Stamp(await GetAsync($"workflows/{wf}"));

        var (applied, errors) = await PutDesignAsync(wf, Body(
            workflow: new { updatedAt = workflowStamp, fields = new { cronExpression = "not a cron" } },
            steps: [new { id = a, updatedAt = await StepStampAsync(a), fields = new { description = "applied?" } },
                    new { id = b, updatedAt = await StepStampAsync(b), fields = new { version = "abc" } }]));

        Assert.False(applied);
        Assert.Contains(errors, e => Is(e, "step", b, "version"));
        Assert.Contains(errors, e => Is(e, "workflow", wf, "cronExpression"));
        // rolled back: a's valid change is not there either; the store moved no stamp; the design is stored
        Assert.Null(Text(await GetAsync($"steps/{a}"), "description"));
        Assert.Equal(workflowStamp, Stamp(await GetAsync($"workflows/{wf}")));
        Assert.Equal(JsonValueKind.Object, (await GetAsync($"workflows/{wf}/graph")).GetProperty("design").ValueKind);
    }

    [Fact]
    public async Task TheStoredDesignComesBackWithTheGraphAndIsLastWriteWins()
    {
        RealStack.SkipUnlessEnabled();
        var a = await StepAsync();
        var wf = await WorkflowAsync([a]);

        await PutDesignAsync(wf, Body(steps: [new { id = a, updatedAt = (string?)null, fields = new { version = "first" } }]));
        await PutDesignAsync(wf, Body(steps: [new { id = a, updatedAt = (string?)null, fields = new { version = "second" } }]));

        var design = (await GetAsync($"workflows/{wf}/graph")).GetProperty("design");
        Assert.Equal("second", design.GetProperty("steps")[0].GetProperty("fields").GetProperty("version").GetString());
    }

    [Fact]
    public async Task AValidDesignAlignsTheRealEntitiesInFullAndEmptiesTheStoredDesign()
    {
        RealStack.SkipUnlessEnabled();
        var c = await StepAsync();
        var b = await StepAsync();
        var a = await StepAsync(b);
        var wf = await WorkflowAsync([a]);

        var (applied, errors) = await PutDesignAsync(wf, Body(
            workflow: new { updatedAt = Stamp(await GetAsync($"workflows/{wf}")), fields = new { description = "designed" } },
            steps: [new { id = a, updatedAt = await StepStampAsync(a), fields = new { name = "renamed-" + Tag() }, nextStepIds = new[] { c } }]));

        Assert.True(applied, Describe(errors));
        var step = await GetAsync($"steps/{a}");
        Assert.StartsWith("renamed-", Text(step, "name"));
        Assert.Equal([c], step.GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Equal("designed", Text(await GetAsync($"workflows/{wf}"), "description"));
        Assert.Equal(JsonValueKind.Null, (await GetAsync($"workflows/{wf}/graph")).GetProperty("design").ValueKind);
    }

    [Fact]
    public async Task AStepChangedSinceItWasOpenedFailsWithTheConflict()
    {
        RealStack.SkipUnlessEnabled();
        var a = await StepAsync();
        var wf = await WorkflowAsync([a]);
        var loaded = await StepStampAsync(a);
        await PutStepAsync(a, description: "someone else");

        var (applied, errors) = await PutDesignAsync(wf, Body(steps: [new { id = a, updatedAt = loaded, fields = new { name = "mine" } }]));

        Assert.False(applied);
        Assert.Equal(Conflict, Assert.Single(errors).GetProperty("message").GetString());
        Assert.Equal("someone else", Text(await GetAsync($"steps/{a}"), "description"));
    }

    [Fact]
    public async Task AProcessorIsLastWriteWins()
    {
        RealStack.SkipUnlessEnabled();
        var a = await StepAsync();
        var wf = await WorkflowAsync([a]);
        await PutProcessorAsync(description: "someone else");

        var (applied, errors) = await PutDesignAsync(wf, Body(processors: [new { id = _processor, fields = new { version = "2.0.0" } }]));

        Assert.True(applied, Describe(errors));
        var p = await GetAsync($"processors/{_processor}");
        Assert.Equal(("2.0.0", "someone else"), (Text(p, "version"), Text(p, "description")));
    }

    [Fact]
    public async Task ASchemaCopyKeepsTheNameAndVersionAndTheSlotIsRepointed()
    {
        RealStack.SkipUnlessEnabled();
        var name = "cfg-" + Tag();
        var original = await PostAsync("schemas", new { name, version = "1.2.3", description = (string?)null, definition = """{"type":"object"}""" });
        _schemas.Add(original);
        await PutProcessorAsync(configSchemaId: original);
        var wf = await WorkflowAsync([await StepAsync()]);
        var copy = Guid.NewGuid();
        _schemas.Add(copy);

        var (applied, errors) = await PutDesignAsync(wf, Body(
            processors: [new { id = _processor, slots = new { config = copy } }],
            schemas: [new { id = copy, name, version = "1.2.3", description = (string?)null, definition = """{"type":"string"}""" }]));

        Assert.True(applied, Describe(errors));
        Assert.Equal(copy, (await GetAsync($"processors/{_processor}")).GetProperty("configSchemaId").GetGuid());
        var s = await GetAsync($"schemas/{copy}");
        Assert.Equal((name, "1.2.3"), (Text(s, "name")!, Text(s, "version")!));
        Assert.Equal(HttpStatusCode.OK, (await _http.GetAsync($"/api/v1/schemas/{original}", Ct)).StatusCode);
    }

    [Fact]
    public async Task AFailedSchemaCopySkipsItsRepointAndNothingIsWritten()
    {
        RealStack.SkipUnlessEnabled();
        var original = await PostAsync("schemas", new { name = "cfg-" + Tag(), version = "1.0.0", description = (string?)null, definition = """{"type":"object"}""" });
        _schemas.Add(original);
        await PutProcessorAsync(configSchemaId: original);
        var wf = await WorkflowAsync([await StepAsync()]);
        var copy = Guid.NewGuid();

        var (applied, errors) = await PutDesignAsync(wf, Body(
            processors: [new { id = _processor, slots = new { config = copy } }],
            schemas: [new { id = copy, name = "cfg", version = "1.0.0", description = (string?)null, definition = "not json" }]));

        Assert.False(applied);
        Assert.Contains(errors, e => Is(e, "schema", copy, "definition"));
        Assert.Contains(errors, e => Is(e, "processor", _processor, "configSchemaId"));
        Assert.Equal(original, (await GetAsync($"processors/{_processor}")).GetProperty("configSchemaId").GetGuid());
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/schemas/{copy}", Ct)).StatusCode);
    }

    [Fact]
    public async Task AssignmentsAreCreatedUpdatedAndDeleted()
    {
        RealStack.SkipUnlessEnabled();
        var (s1, s2, s3) = (await StepAsync(), await StepAsync(), await StepAsync());
        var x = await PostAsync("assignments", new { name = Tag(), version = "1.0.0", stepId = s2, payload = "{}" });
        var y = await PostAsync("assignments", new { name = Tag(), version = "1.0.0", stepId = s3, payload = "{}" });
        var wf = await WorkflowAsync([s1, s2, s3], [x, y]);
        var made = Guid.NewGuid();

        var (applied, errors) = await PutDesignAsync(wf, Body(
            workflow: new { updatedAt = Stamp(await GetAsync($"workflows/{wf}")) },
            assignments:
            [
                new { op = "create", id = made, stepId = s1, updatedAt = (string?)null, fields = new { name = Tag(), version = "1.0.0", payload = """{"a":1}""" } },
                new { op = "update", id = x, stepId = s2, updatedAt = Stamp(await GetAsync($"assignments/{x}")), fields = new { payload = """{"b":2}""" } },
                new { op = "delete", id = y, stepId = s3, updatedAt = Stamp(await GetAsync($"assignments/{y}")), fields = (object?)null },
            ]));

        Assert.True(applied, Describe(errors));
        var linked = (await GetAsync($"workflows/{wf}")).GetProperty("assignmentIds").EnumerateArray().Select(e => e.GetGuid()).OrderBy(g => g);
        Assert.Equal(new[] { made, x }.OrderBy(g => g), linked);
        Assert.Contains("\"b\"", Text(await GetAsync($"assignments/{x}"), "payload"));
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/assignments/{y}", Ct)).StatusCode);
    }

    [Fact]
    public async Task ADatabaseErrorOnOneEntityIsReportedAndTheOthersStillReportTheirs()
    {
        RealStack.SkipUnlessEnabled();
        var (c1, c2) = (await CacheAsync(), await CacheAsync());
        var takenRoot = Text(await GetAsync($"caches/{c1}"), "root");
        var c2Root = Text(await GetAsync($"caches/{c2}"), "root");
        var a = await StepAsync();
        var wf = await WorkflowAsync([a]);

        var (applied, errors) = await PutDesignAsync(wf, Body(
            caches: [new { id = c2, fields = new { root = takenRoot } }],
            steps: [new { id = a, updatedAt = await StepStampAsync(a), fields = new { version = "abc" } }]));

        Assert.False(applied);
        Assert.Contains(errors, e => Is(e, "cache", c2, "root"));   // uq_cache_root, caught at its savepoint
        Assert.Contains(errors, e => Is(e, "step", a, "version"));  // the stages went on after it
        Assert.Equal(c2Root, Text(await GetAsync($"caches/{c2}"), "root"));
    }

    [Fact]
    public async Task ANotStartableDesignIsWritten()
    {
        RealStack.SkipUnlessEnabled();
        await StepAsync(); // an unwired step, as a designer leaves one on the canvas
        var b = await StepAsync();
        var a = await StepAsync(b);
        var wf = await WorkflowAsync([a]);

        var (applied, errors) = await PutDesignAsync(wf, Body(
            steps: [new { id = b, updatedAt = await StepStampAsync(b), fields = (object?)null, nextStepIds = new[] { a } }]));

        Assert.True(applied, Describe(errors));
        Assert.Equal([a], (await GetAsync($"steps/{b}")).GetProperty("nextStepIds").EnumerateArray().Select(x => x.GetGuid()));
    }
}
```

- [ ] **Step 2: Build; the live class skips without the stack**

```powershell
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.WorkflowDesignLiveTests"
```

Expected: build clean; 10 skipped (no `SKP_REALSTACK`).

- [ ] **Step 3: Commit**

```powershell
git add src/tests/BaseApi.Tests/Live/WorkflowDesignLiveTests.cs
git commit -m "test(studio): Postgres tests for the design save: rollback, every error, conflicts, last write wins, copies, assignments (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Deploy BaseApi (ask the user first: it restarts the shared dev BaseApi)**

```powershell
docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .
kind load docker-image baseapi-service:local --name desktop
kubectl -n skp rollout restart deploy/baseapi-service
kubectl -n skp rollout status deploy/baseapi-service --timeout=180s
./k8s/port-forward-realstack.ps1 -Status
```

Expected: the rollout completes (the migration `AddWorkflowDesign` runs at start-up, as `AddWorkflowLayout` did); the port-forward reports BaseApi on `localhost:18080` (start it with `./k8s/port-forward-realstack.ps1` if it is down).

- [ ] **Step 5: Run the Postgres tests against the deployed BaseApi**

```powershell
$env:SKP_REALSTACK='1'
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.WorkflowDesignLiveTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.WorkflowGraphLiveTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.WorkflowValidationLiveTests"
Remove-Item Env:SKP_REALSTACK
```

Expected: 10 passed; the graph and validate live classes still pass (unchanged endpoints). A failure here is fixed at its root (superpowers:systematic-debugging) with a hermetic test that shows it where possible, committed as a new `fix(studio): …` commit, and BaseApi is redeployed (Step 4) before running Step 5 again.

---

### Task 8: The studio's design model: entity edits, assignment operations, schema copies, loose wires, the layout Save writes

**Files:**
- Modify: `src/WorkflowStudio/src/layout/wires.ts` (types after `Joint`, line ~34)
- Modify: `src/WorkflowStudio/src/design/draft.ts` (`Draft`, `EMPTY_DRAFT`, `isEmptyDraft`, `parseDraft`; new loose functions)
- Create: `src/WorkflowStudio/src/design/ids.ts`, `src/WorkflowStudio/src/design/design.ts`, `src/WorkflowStudio/src/design/layoutDesign.ts`
- Test: `src/WorkflowStudio/src/design/design.test.ts`, `src/WorkflowStudio/src/design/layoutDesign.test.ts`, `src/WorkflowStudio/src/design/draft.test.ts`

**Interfaces:**
- Produces:
  - `layout/wires.ts`: `interface LooseWire { source: SourceId; end: Point }`, `interface LooseRoute { id: string; source: SourceId; points: Pt[] }`
  - `design/draft.ts`: `Draft.loose: Record<string, LooseWire>`; `LOOSE_PREFIX = 'loose:'`; `addLoose(draft, id, source, end)`, `moveLoose(draft, id, end)`, `removeLoose(draft, ids)`, `attachLoose(draft, saved, id, target)`, `loosen(draft, saved, wireId, looseId, end)`
  - `design/ids.ts`: `newId(): string` (a v4 GUID)
  - `design/design.ts`: `FieldValue`, `EntityEdit`, `AssignmentOp`, `SchemaCopy`, `EntityEdits`, `EMPTY_EDITS`, `Design`, `EMPTY_DESIGN`, `EditTarget`, `slotKey`, `valueText`, `fieldsOf`, `setField`, `revertEntity`, `createAssignment`, `removeAssignment`, `hasGraphChanges`, `isEmptyEdits`, `sameDesign`, `parseEdits`, `storedDesignOf(stored: unknown, layout: unknown): Design`
  - `design/layoutDesign.ts`: `interface SavedLayout`, `layoutOf(shown: StudioDocument, draft: Draft): SavedLayout`

- [ ] **Step 1: Write the failing tests**

`src/WorkflowStudio/src/design/design.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assignmentDto, processorDto, schemaDto, stepDto } from '../api/fixtures';
import {
  createAssignment, EMPTY_DESIGN, EMPTY_EDITS, fieldsOf, hasGraphChanges, parseEdits, removeAssignment, revertEntity,
  sameDesign, setField, storedDesignOf,
} from './design';
import { EMPTY_DRAFT } from './draft';

/** Hands out the given ids, then `id1`, `id2`, … */
const ids = (...list: string[]) => { let i = 0; return () => list[i++] ?? `id${i}`; };

describe('entity edits (plan 8 §3.2)', () => {
  it('keeps only fields that differ from the base, with an owned entity\'s loaded stamp', () => {
    const base = stepDto('s1', { updatedAt: '2026-10-07T10:00:00Z' });
    let e = setField(EMPTY_EDITS, { kind: 'step', id: 's1' }, base, 'description', 'new', ids());
    expect(e.steps['s1']).toEqual({ updatedAt: '2026-10-07T10:00:00Z', fields: { description: 'new' } });
    e = setField(e, { kind: 'step', id: 's1' }, base, 'description', null, ids());
    expect(e.steps['s1']).toBeUndefined();
  });

  it('gives a shared entity no stamp', () => {
    const e = setField(EMPTY_EDITS, { kind: 'processor', id: 'p1' }, processorDto('p1'), 'name', 'renamed', ids());
    expect(e.processors['p1']).toEqual({ updatedAt: null, fields: { name: 'renamed' } });
  });

  it('keeps a stamp older than the base (from the stored design) even when the fields go back', () => {
    const stored = { ...EMPTY_EDITS, steps: { s1: { updatedAt: '2026-10-01T00:00:00Z', fields: { name: 'x' } } } };
    const e = setField(stored, { kind: 'step', id: 's1' }, stepDto('s1', { name: 'step-s1' }), 'name', 'step-s1', ids());
    expect(e.steps['s1']).toEqual({ updatedAt: '2026-10-01T00:00:00Z', fields: {} });
  });

  it('edits a schema through a background copy: a new id, the original\'s name and version (spec §1.5)', () => {
    const base = schemaDto('sc1', { name: 'cfg', version: '1.2.3', definition: '{"type":"object"}' });
    const target = { kind: 'schema', processorId: 'p1', slot: 'config' } as const;
    const e = setField(EMPTY_EDITS, target, base, 'definition', '{"type":"string"}', ids('copy1'));
    expect(e.schemas['p1:config']).toEqual({ id: 'copy1', name: 'cfg', version: '1.2.3', description: null, definition: '{"type":"string"}' });
    expect(fieldsOf(e, target)).toMatchObject({ name: 'cfg', version: '1.2.3', definition: '{"type":"string"}' });
    // a second edit changes the same copy
    expect(setField(e, target, base, 'description', 'd', ids('copy2')).schemas['p1:config']!.id).toBe('copy1');
    expect(revertEntity(e, target).schemas['p1:config']).toBeUndefined();
  });

  it('creates, updates and deletes a step\'s assignment: one operation per step', () => {
    let e = createAssignment(EMPTY_EDITS, 's1', 'fetch', 'n1');
    expect(e.assignments['s1']).toEqual({ op: 'create', id: 'n1', fields: { name: 'fetch-assignment', version: '1.0.0', description: null, payload: '{}' } });
    e = setField(e, { kind: 'assignment', id: 'n1', stepId: 's1' }, assignmentDto('n1', { stepId: 's1' }), 'payload', '{"a":1}', ids());
    expect(e.assignments['s1']).toMatchObject({ op: 'create', fields: { payload: '{"a":1}' } });
    expect(removeAssignment(e, 's1', undefined).assignments['s1']).toBeUndefined();

    const base = { id: 'a2', updatedAt: '2026-10-07T10:00:00Z' };
    let f = setField(EMPTY_EDITS, { kind: 'assignment', id: 'a2', stepId: 's2' }, assignmentDto('a2', { stepId: 's2', updatedAt: base.updatedAt }), 'payload', '{"b":2}', ids());
    expect(f.assignments['s2']).toEqual({ op: 'update', id: 'a2', updatedAt: base.updatedAt, fields: { payload: '{"b":2}' } });
    f = removeAssignment(f, 's2', base);
    expect(f.assignments['s2']).toEqual({ op: 'delete', id: 'a2', updatedAt: base.updatedAt });
    // created again after a remove: the step's own row is updated to the new values instead
    expect(createAssignment(f, 's2', 'store', 'n2').assignments['s2']).toMatchObject({ op: 'update', id: 'a2', fields: { name: 'store-assignment' } });
  });

  it('tells a design with graph changes from one with only shapes and stamps', () => {
    expect(hasGraphChanges(EMPTY_DESIGN)).toBe(false);
    expect(hasGraphChanges({
      draft: { ...EMPTY_DRAFT, routes: { 'a->b': { bends: null, landing: 40 } }, loose: { l1: { source: 'a', end: { x: 0, y: 0 } } } },
      edits: { ...EMPTY_EDITS, steps: { s1: { updatedAt: 't', fields: {} } } },
    })).toBe(false);
    expect(hasGraphChanges({ draft: { ...EMPTY_DRAFT, next: { s1: [] } }, edits: EMPTY_EDITS })).toBe(true);
    expect(hasGraphChanges({ draft: EMPTY_DRAFT, edits: createAssignment(EMPTY_EDITS, 's1', 'x', 'n') })).toBe(true);
  });

  it('compares designs whatever the order of their keys', () => {
    const a = { draft: { ...EMPTY_DRAFT, next: { s1: ['s2'], s2: [] } }, edits: EMPTY_EDITS };
    const b = { draft: { ...EMPTY_DRAFT, next: { s2: [], s1: ['s2'] } }, edits: EMPTY_EDITS };
    expect(sameDesign(a, b)).toBe(true);
    expect(sameDesign(a, EMPTY_DESIGN)).toBe(false);
  });

  it('reads a session\'s edits back and drops what is malformed', () => {
    const e = parseEdits({
      workflow: { updatedAt: 't', fields: { name: 'x', bad: {} } },
      steps: { s1: 7 },
      assignments: { s1: { op: 'rename', id: 'a' }, s2: { op: 'delete', id: 'a2', updatedAt: 't' } },
      schemas: { 'p1:config': { id: 'c', name: 'n', version: 'v', description: null, definition: '{}' } },
    })!;
    expect(e.workflow).toEqual({ updatedAt: 't', fields: { name: 'x' } });
    expect(e.steps).toEqual({});
    expect(Object.keys(e.assignments)).toEqual(['s2']);
    expect(e.schemas['p1:config']!.id).toBe('c');
    expect(parseEdits('nope')).toBeNull();
  });
});

describe('the stored design (plan 8 §3.1)', () => {
  it('is the server\'s body read back, with wire shapes and loose wires from the layout', () => {
    const d = storedDesignOf({
      workflow: { updatedAt: 'w0', fields: { description: 'd' }, entryStepIds: ['s2'] },
      steps: [{ id: 's1', updatedAt: 's0', fields: {}, nextStepIds: ['s1'] }],
      processors: [{ id: 'p1', fields: { name: 'p' }, slots: { config: 'c1' } }],
      schemas: [{ id: 'c1', name: 'cfg', version: '1.0.0', definition: '{}' }],
      caches: [{ id: 'k1', fields: { root: 'r' } }],
      assignments: [{ op: 'delete', id: 'a1', stepId: 's1', updatedAt: 'a0' }],
    }, { routes: { 's1->s1': { bends: null, landing: 24 } }, loose: { l1: { source: 's1', end: { x: 600, y: 80 } } } });
    expect(d.draft.entries).toEqual(['s2']);
    expect(d.draft.next).toEqual({ s1: ['s1'] });
    expect(d.draft.routes['s1->s1']).toEqual({ bends: null, landing: 24, contact: null });
    expect(d.draft.loose['l1']).toEqual({ source: 's1', end: { x: 600, y: 80 } });
    expect(d.edits.workflow).toEqual({ updatedAt: 'w0', fields: { description: 'd' } });
    expect(d.edits.steps['s1']).toEqual({ updatedAt: 's0', fields: {} });
    expect(d.edits.processors['p1']!.fields).toEqual({ name: 'p' });
    expect(d.edits.schemas['p1:config']).toEqual({ id: 'c1', name: 'cfg', version: '1.0.0', description: null, definition: '{}' });
    expect(d.edits.caches['k1']!.fields).toEqual({ root: 'r' });
    expect(d.edits.assignments['s1']).toEqual({ op: 'delete', id: 'a1', updatedAt: 'a0' });
  });

  it('is only the layout\'s shapes when nothing is stored', () => {
    const d = storedDesignOf(null, { routes: {}, loose: {} });
    expect(hasGraphChanges(d)).toBe(false);
    expect(sameDesign(d, EMPTY_DESIGN)).toBe(true);
  });
});
```

`src/WorkflowStudio/src/design/layoutDesign.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { parseLayout } from '../layout/layoutDoc';
import { applyDraft } from './apply';
import { storedDesignOf } from './design';
import { addLoose, EMPTY_DRAFT, setShape } from './draft';
import { layoutOf } from './layoutDesign';

describe('layoutOf (plan 8 §4.2)', () => {
  it('writes every block where it is shown, every canvas step as parked, the shapes of wires that exist and the loose wires', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const shaped = setShape(setShape(EMPTY_DRAFT, 's1->s2', { bends: null, landing: 40 }), 'gone->s2', { bends: null, landing: 8 });
    const draft = addLoose(shaped, 'l1', 's1', { x: 900, y: 64 });
    const shown = applyDraft(doc, draft);

    const layout = layoutOf(shown, draft);

    expect(layout.sphere).toEqual({ x: shown.placement.sphere.cx, y: shown.placement.sphere.cy });
    expect(Object.keys(layout.steps).sort()).toEqual(['s1', 's2']);
    expect([...layout.parked].sort()).toEqual(['s1', 's2']);
    expect(Object.keys(layout.routes)).toEqual(['s1->s2']);
    expect(layout.loose).toEqual({ l1: { source: 's1', end: { x: 900, y: 64 } } });
    // what it writes reads back: positions through the loader's parser, shapes through the stored design
    expect(parseLayout(JSON.parse(JSON.stringify(layout))).steps['s1']).toEqual(shown.placement.steps.get('s1'));
    expect(storedDesignOf(null, JSON.parse(JSON.stringify(layout))).draft.routes['s1->s2']).toEqual({ bends: null, landing: 40, contact: null });
  });
});
```

Append to `src/WorkflowStudio/src/design/draft.test.ts` (add `addLoose`, `attachLoose`, `isEmptyDraft`, `loosen`, `moveLoose`, `removeLoose` to its `./draft` import):

```ts
describe('loose wires (plan 8 §5)', () => {
  it('adds, moves, removes and reads back a loose wire; a malformed one is dropped', () => {
    let d = addLoose(EMPTY_DRAFT, 'l1', 's1', { x: 600, y: 80 });
    expect(d.loose['l1']).toEqual({ source: 's1', end: { x: 600, y: 80 } });
    expect(isEmptyDraft(d)).toBe(false);
    d = moveLoose(d, 'l1', { x: 640, y: 96 });
    expect(parseDraft(JSON.parse(JSON.stringify(d)))!.loose['l1']).toEqual({ source: 's1', end: { x: 640, y: 96 } });
    expect(parseDraft({ loose: { bad: { source: 7 }, worse: { source: 's1', end: { x: 'a', y: 1 } } } })!.loose).toEqual({});
    expect(removeLoose(d, ['l1']).loose).toEqual({});
  });

  it('a released head takes the wire out of the wiring, loose from its source; attached again it is an ordinary wire', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')] }));
    const loose = loosen(EMPTY_DRAFT, doc, 's1->s2', 'l1', { x: 900, y: 400 });
    expect(loose.next['s1']).toEqual([]);
    expect(loose.loose['l1']).toEqual({ source: 's1', end: { x: 900, y: 400 } });
    const wired = attachLoose(loose, doc, 'l1', 's3');
    expect(wired.next['s1']).toEqual(['s3']);
    expect(wired.loose).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/design/design.test.ts src/design/layoutDesign.test.ts src/design/draft.test.ts`
Expected: FAIL (modules `./design`, `./layoutDesign` not found; `addLoose` not exported).

- [ ] **Step 3: Implement**

`src/layout/wires.ts` — after the `Joint` interface:

```ts
/** A loose wire (plan 8 §5): from a source to an open end where it was dropped; never part of the wiring. */
export interface LooseWire {
  source: SourceId;
  /** The open end, in flow coordinates. */
  end: Point;
}

/** A loose wire as drawn: right-angled from its source's port to its open end. */
export interface LooseRoute {
  id: string;
  source: SourceId;
  points: Pt[];
}
```

`src/design/draft.ts`:
- import `type LooseWire` from `'../layout/wires'`;
- `Draft` gains, after `routes`:

```ts
  /** Loose wires by id (plan 8 §5): from a source to an open end; never part of the wiring. */
  loose: Record<string, LooseWire>;
```

- `EMPTY_DRAFT` gains `loose: {}`; `isEmptyDraft` gains `&& empty(d.loose)`;
- add after `resetRoute`:

```ts
/** A pick of a loose wire is `loose:{id}` (plan 8): it never collides with a wire id `source->target`. */
export const LOOSE_PREFIX = 'loose:';

export function addLoose(draft: Draft, id: string, source: SourceId, end: Point): Draft {
  const loose = copy(draft.loose);
  loose[id] = { source, end: { x: end.x, y: end.y } };
  return { ...draft, loose };
}

export function moveLoose(draft: Draft, id: string, end: Point): Draft {
  return Object.hasOwn(draft.loose, id) ? addLoose(draft, id, draft.loose[id]!.source, end) : draft;
}

export function removeLoose(draft: Draft, ids: readonly string[]): Draft {
  const loose = copy(draft.loose);
  for (const id of ids) delete loose[id];
  return { ...draft, loose };
}

/** A loose wire's open end dropped on a step it may wire to: it becomes an ordinary wire (spec §5). */
export function attachLoose(draft: Draft, saved: StudioDocument, id: string, target: Id): Draft {
  if (!Object.hasOwn(draft.loose, id)) return draft;
  return addWire(removeLoose(draft, [id]), saved, draft.loose[id]!.source, target);
}

/** A wire's head released where it attaches to nothing: it leaves the wiring and stays drawn, loose from its source (spec §5). */
export function loosen(draft: Draft, saved: StudioDocument, id: string, looseId: string, end: Point): Draft {
  return addLoose(removeWires(draft, saved, [id]), looseId, wireEnds(id).source, end);
}
```

- `parseDraft`'s return gains:

```ts
    loose: records(value.loose, (raw) => {
      const end = isRecord(raw) ? toPoint(raw.end) : null;
      return isRecord(raw) && typeof raw.source === 'string' && raw.source !== '' && end ? { source: raw.source, end } : null;
    }),
```

Existing draft tests comparing whole drafts with an object literal now also see `loose: {}`; add `loose: {}` to those literals.

`src/design/ids.ts`:

```ts
/** A new v4 GUID for a virtual entity, a schema copy or a loose wire (plan 8: every new one gets a new id). */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
```

`src/design/design.ts`:

```ts
import type { EntityReadDto } from '../api/entities';
import type { Id } from '../model/graph';
import { savedText } from '../store/entityForms';
import type { SchemaSlot } from '../store/inspectorTarget';
import { EMPTY_DRAFT, parseDraft, type Draft } from './draft';

/** A field's value as the update DTO carries it: text, the entry condition's number, or null. */
export type FieldValue = string | number | null;

/** One entity's changed fields (only those that differ from the base), with the stamp it was loaded with. */
export interface EntityEdit {
  /** Owned entities (the workflow, steps): the `updatedAt` BaseApi checks; null for shared ones. */
  updatedAt: string | null;
  fields: Record<string, FieldValue>;
}

/** What happens to a step's assignment in this workflow (spec §3.2): one operation per step. */
export type AssignmentOp =
  | { op: 'create'; id: Id; fields: Record<string, FieldValue> }
  | { op: 'update'; id: Id; updatedAt: string | null; fields: Record<string, FieldValue> }
  | { op: 'delete'; id: Id; updatedAt: string | null };

/** A processor slot's background copy (spec §1.5): a new id, the original's name and version. */
export interface SchemaCopy {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  definition: string;
}

/** The Inspector's part of the design: never in the canvas's undo history. */
export interface EntityEdits {
  workflow: EntityEdit | null;
  steps: Record<Id, EntityEdit>;
  processors: Record<Id, EntityEdit>;
  caches: Record<Id, EntityEdit>;
  /** By step id. */
  assignments: Record<Id, AssignmentOp>;
  /** By `${processorId}:${slot}`. */
  schemas: Record<string, SchemaCopy>;
}

export const EMPTY_EDITS: EntityEdits = { workflow: null, steps: {}, processors: {}, caches: {}, assignments: {}, schemas: {} };

/** One document's whole design (spec §3.2): the canvas draft and the entity edits. */
export interface Design {
  draft: Draft;
  edits: EntityEdits;
}

export const EMPTY_DESIGN: Design = { draft: EMPTY_DRAFT, edits: EMPTY_EDITS };

/** Which entity an edit is for. A schema is reached from its processor's slot, so it is named by both. */
export type EditTarget =
  | { kind: 'workflow' }
  | { kind: 'step'; id: Id }
  | { kind: 'processor'; id: Id }
  | { kind: 'cache'; id: Id }
  | { kind: 'assignment'; id: Id; stepId: Id }
  | { kind: 'schema'; processorId: Id; slot: SchemaSlot };

export const slotKey = (processorId: Id, slot: SchemaSlot): string => `${processorId}:${slot}`;

/** A field value as form text: null reads as '', a number as its digits. */
export const valueText = (v: FieldValue | undefined): string => (v === null || v === undefined ? '' : String(v));

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const copy = <T>(r: Readonly<Record<string, T>>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, r);

function put<T>(r: Readonly<Record<string, T>>, key: string, value: T | null): Record<string, T> {
  const out = copy(r);
  if (value === null) delete out[key];
  else out[key] = value;
  return out;
}

const stampOf = (dto: EntityReadDto): string | null => str((dto as { updatedAt?: unknown }).updatedAt);

/** The fields an entity's form overlays on its base (spec §3.3): a copy's whole text for a schema. */
export function fieldsOf(edits: EntityEdits, t: EditTarget): Record<string, FieldValue> {
  switch (t.kind) {
    case 'workflow': return edits.workflow?.fields ?? {};
    case 'step': return edits.steps[t.id]?.fields ?? {};
    case 'processor': return edits.processors[t.id]?.fields ?? {};
    case 'cache': return edits.caches[t.id]?.fields ?? {};
    case 'assignment': {
      const op = edits.assignments[t.stepId];
      return op && op.op !== 'delete' && op.id === t.id ? op.fields : {};
    }
    case 'schema': {
      const c = edits.schemas[slotKey(t.processorId, t.slot)];
      return c ? { name: c.name, version: c.version, description: c.description, definition: c.definition } : {};
    }
  }
}

/**
 * Sets one field of the design (spec §3.3). A field typed back to the base's value is dropped; an entity
 * left with no field and the base's own stamp goes. A stamp older than the base's (it came from the
 * stored design) is kept: it is what was loaded. A schema edit makes or changes the slot's copy, whose
 * new id comes from `newId` (spec §1.5).
 */
export function setField(edits: EntityEdits, t: EditTarget, base: EntityReadDto, key: string, value: FieldValue, newId: () => Id): EntityEdits {
  const same = valueText(value) === savedText(base, key);
  const stamp = stampOf(base);
  const next = (e: EntityEdit | null | undefined, owned: boolean): EntityEdit | null => {
    const fields = copy(e?.fields ?? {});
    if (same) delete fields[key];
    else fields[key] = value;
    const updatedAt = e ? e.updatedAt : owned ? stamp : null;
    return Object.keys(fields).length === 0 && (updatedAt === null || updatedAt === stamp) ? null : { updatedAt, fields };
  };
  switch (t.kind) {
    case 'workflow': return { ...edits, workflow: next(edits.workflow, true) };
    case 'step': return { ...edits, steps: put(edits.steps, t.id, next(edits.steps[t.id], true)) };
    case 'processor': return { ...edits, processors: put(edits.processors, t.id, next(edits.processors[t.id], false)) };
    case 'cache': return { ...edits, caches: put(edits.caches, t.id, next(edits.caches[t.id], false)) };
    case 'assignment': {
      const op = edits.assignments[t.stepId];
      if (op?.op === 'delete') return edits;
      if (op?.op === 'create') return { ...edits, assignments: put<AssignmentOp>(edits.assignments, t.stepId, { ...op, fields: { ...op.fields, [key]: value } }) };
      const e = next(op ? { updatedAt: op.updatedAt, fields: op.fields } : null, true);
      return { ...edits, assignments: put<AssignmentOp>(edits.assignments, t.stepId, e === null ? null : { op: 'update', id: t.id, updatedAt: e.updatedAt, fields: e.fields }) };
    }
    case 'schema': {
      const k = slotKey(t.processorId, t.slot);
      const was: SchemaCopy = edits.schemas[k] ?? {
        id: newId(), name: savedText(base, 'name'), version: savedText(base, 'version'),
        description: (base as { description?: string | null }).description ?? null, definition: savedText(base, 'definition'),
      };
      const text = valueText(value);
      const changed: SchemaCopy =
        key === 'description' ? { ...was, description: text === '' ? null : text }
        : key === 'name' ? { ...was, name: text }
        : key === 'version' ? { ...was, version: text }
        : key === 'definition' ? { ...was, definition: text }
        : was;
      return { ...edits, schemas: put(edits.schemas, k, changed) };
    }
  }
}

/** Drops everything the design holds for one entity (the Inspector's Revert). */
export function revertEntity(edits: EntityEdits, t: EditTarget): EntityEdits {
  switch (t.kind) {
    case 'workflow': return { ...edits, workflow: null };
    case 'step': return { ...edits, steps: put(edits.steps, t.id, null) };
    case 'processor': return { ...edits, processors: put(edits.processors, t.id, null) };
    case 'cache': return { ...edits, caches: put(edits.caches, t.id, null) };
    case 'assignment': return { ...edits, assignments: put(edits.assignments, t.stepId, null) };
    case 'schema': return { ...edits, schemas: put(edits.schemas, slotKey(t.processorId, t.slot), null) };
  }
}

/**
 * Creates a step's assignment in the design (spec §3.3): `{step}-assignment`, 1.0.0, payload `{}`. When
 * the step's own row was removed in this design, that row is updated to the new values instead: one
 * operation per step.
 */
export function createAssignment(edits: EntityEdits, stepId: Id, stepName: string, id: Id): EntityEdits {
  const fields: Record<string, FieldValue> = { name: `${stepName}-assignment`, version: '1.0.0', description: null, payload: '{}' };
  const op = edits.assignments[stepId];
  const made: AssignmentOp = op?.op === 'delete' ? { op: 'update', id: op.id, updatedAt: op.updatedAt, fields } : { op: 'create', id, fields };
  return { ...edits, assignments: put(edits.assignments, stepId, made) };
}

/** Removes a step's assignment in the design: a created one is forgotten, the base's row is deleted on Save. */
export function removeAssignment(edits: EntityEdits, stepId: Id, base: { id: Id; updatedAt: string } | undefined): EntityEdits {
  const op = edits.assignments[stepId];
  if (op?.op === 'create') return { ...edits, assignments: put(edits.assignments, stepId, null) };
  if (base === undefined || op?.op === 'delete') return edits;
  const updatedAt = op?.op === 'update' ? op.updatedAt : base.updatedAt;
  return { ...edits, assignments: put<AssignmentOp>(edits.assignments, stepId, { op: 'delete', id: base.id, updatedAt }) };
}

const anyFields = (r: Readonly<Record<string, EntityEdit>>) => Object.values(r).some((e) => Object.keys(e.fields).length > 0);

/** Whether the design changes the real entities (Save has something to apply): wiring or entity edits, not shapes or stamps. */
export function hasGraphChanges({ draft, edits }: Design): boolean {
  return Object.keys(draft.next).length > 0 || draft.entries !== null
    || (edits.workflow !== null && Object.keys(edits.workflow.fields).length > 0)
    || anyFields(edits.steps) || anyFields(edits.processors) || anyFields(edits.caches)
    || Object.keys(edits.assignments).length > 0 || Object.keys(edits.schemas).length > 0;
}

export const isEmptyEdits = (edits: EntityEdits): boolean => !hasGraphChanges({ draft: EMPTY_DRAFT, edits });

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    const r = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(r).sort().map((k) => [k, canonical(r[k])]));
  }
  return v;
}

/** Equal designs, whatever the order their records were built in. */
export const sameDesign = (a: Design, b: Design): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// ---- reading back: the session's edits and the server's stored design; anything malformed is dropped ----

function toFields(v: unknown): Record<string, FieldValue> {
  const out = copy<FieldValue>({});
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (raw === null || typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw))) out[k] = raw;
  }
  return out;
}

const toIds = (v: unknown): Id[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : null);

function toOp(v: unknown): AssignmentOp | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (id === null) return null;
  switch (v.op) {
    case 'create': return { op: 'create', id, fields: toFields(v.fields) };
    case 'update': return { op: 'update', id, updatedAt: str(v.updatedAt), fields: toFields(v.fields) };
    case 'delete': return { op: 'delete', id, updatedAt: str(v.updatedAt) };
    default: return null;
  }
}

function toCopy(v: unknown): SchemaCopy | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (id === null || typeof v.name !== 'string' || typeof v.version !== 'string' || typeof v.definition !== 'string') return null;
  return { id, name: v.name, version: v.version, description: typeof v.description === 'string' ? v.description : null, definition: v.definition };
}

const toEdit = (v: unknown): EntityEdit | null => (isRecord(v) ? { updatedAt: str(v.updatedAt), fields: toFields(v.fields) } : null);

function records<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> {
  const out = copy<T>({});
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const value = parse(raw);
    if (value !== null) out[k] = value;
  }
  return out;
}

/** The edits a session held (the shape `EntityEdits` serializes to), or null when it is not that at all. */
export function parseEdits(value: unknown): EntityEdits | null {
  if (!isRecord(value)) return null;
  return {
    workflow: toEdit(value.workflow),
    steps: records(value.steps, toEdit),
    processors: records(value.processors, toEdit),
    caches: records(value.caches, toEdit),
    assignments: records(value.assignments, toOp),
    schemas: records(value.schemas, toCopy),
  };
}

const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/**
 * The last saved design (spec §3.1): the server's stored body (`graph.design`, the request without its
 * layout) read back into a design, with the wire shapes and loose wires of the stored layout. With
 * nothing stored, only those shapes: the real entities hold the rest.
 */
export function storedDesignOf(stored: unknown, layout: unknown): Design {
  const shapes = parseDraft(isRecord(layout) ? { routes: layout.routes, loose: layout.loose } : {})!;
  const draft: Draft = { ...EMPTY_DRAFT, routes: shapes.routes, loose: shapes.loose, next: copy({}) };
  const edits: EntityEdits = { workflow: null, steps: copy({}), processors: copy({}), caches: copy({}), assignments: copy({}), schemas: copy({}) };
  if (!isRecord(stored)) return { draft, edits };

  if (isRecord(stored.workflow)) {
    edits.workflow = toEdit(stored.workflow);
    draft.entries = toIds(stored.workflow.entryStepIds);
  }
  for (const s of list(stored.steps)) {
    const id = str(s.id);
    if (id === null) continue;
    edits.steps[id] = toEdit(s)!;
    const next = toIds(s.nextStepIds);
    if (next !== null) draft.next[id] = next;
  }
  const copies = new Map(list(stored.schemas).flatMap((c) => { const x = toCopy(c); return x ? [[x.id, x] as const] : []; }));
  for (const p of list(stored.processors)) {
    const id = str(p.id);
    if (id === null) continue;
    const fields = toFields(p.fields);
    if (Object.keys(fields).length > 0) edits.processors[id] = { updatedAt: null, fields };
    const slots = isRecord(p.slots) ? p.slots : {};
    for (const slot of ['input', 'output', 'config'] as const) {
      const c = copies.get(str(slots[slot]) ?? '');
      if (c) edits.schemas[slotKey(id, slot)] = c;
    }
  }
  for (const c of list(stored.caches)) {
    const id = str(c.id);
    const fields = toFields(c.fields);
    if (id !== null && Object.keys(fields).length > 0) edits.caches[id] = { updatedAt: null, fields };
  }
  for (const a of list(stored.assignments)) {
    const stepId = str(a.stepId);
    const op = toOp(a);
    if (stepId !== null && op !== null) edits.assignments[stepId] = op;
  }
  return { draft, edits };
}
```

`src/design/layoutDesign.ts`:

```ts
import type { StudioDocument } from '../app/document';
import type { Point } from '../layout/geometry';
import { WORKFLOW_SOURCE } from '../layout/ports';
import type { WireShape } from '../layout/shape';
import type { LooseWire } from '../layout/wires';
import type { Id } from '../model/graph';
import type { Draft } from './draft';

/** The canvas layout Save writes (plan 8 §4.2): positions, every canvas step, wire shapes, loose wires. */
export interface SavedLayout {
  v: 1;
  /** The hub's centre. */
  sphere: Point;
  steps: Record<Id, Point>;
  caches: Record<Id, Point>;
  /**
   * Every step on the canvas. GET /graph returns only the steps the real entry steps reach; after a stored
   * design wired steps in or out, the loader still finds each one here (it skips the reachable ones).
   */
  parked: Id[];
  routes: Record<string, WireShape>;
  loose: Record<string, LooseWire>;
}

/** The layout of what the canvas shows: shapes only of wires that exist, loose wires only from sources on the canvas. */
export function layoutOf(shown: StudioDocument, draft: Draft): SavedLayout {
  const wires = new Set(shown.wires.map((w) => w.id));
  const onCanvas = (source: string) => source === WORKFLOW_SOURCE || shown.placement.steps.has(source);
  const points = (m: ReadonlyMap<Id, Point>) => Object.fromEntries([...m].map(([id, p]) => [id, { x: p.x, y: p.y }]));
  return {
    v: 1,
    sphere: { x: shown.placement.sphere.cx, y: shown.placement.sphere.cy },
    steps: points(shown.placement.steps),
    caches: points(shown.placement.caches),
    parked: [...shown.placement.steps.keys()],
    routes: Object.fromEntries(Object.entries(draft.routes).filter(([id]) => wires.has(id))),
    loose: Object.fromEntries(Object.entries(draft.loose).filter(([, l]) => onCanvas(l.source))),
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/design src/layout; npx tsc -b; Remove-Item tsconfig.tsbuildinfo`
Expected: PASS; the type check is clean.

- [ ] **Step 5: Commit**

```powershell
git add src/WorkflowStudio/src/design src/WorkflowStudio/src/layout/wires.ts
git commit -m "feat(studio): the design model: entity edits, assignment operations, schema copies, loose wires, the layout Save writes (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Regenerated API types, `saveDesign` on the client, opening with GETs only, Problems shows save errors

**Files:**
- Regenerate: `src/WorkflowStudio/openapi/baseapi.v1.json`, `src/WorkflowStudio/src/api/schema.d.ts` (`npm run gen:api`)
- Modify: `src/WorkflowStudio/src/api/types.ts`, `src/api/client.ts:2,42-43,132`, `src/api/toModel.ts:83-97`, `src/model/graph.ts:69-74,87-107`
- Modify: `src/WorkflowStudio/src/app/document.ts`, `src/app/loadDocument.ts`, `src/app/fixtures.ts`, `src/design/apply.ts:42`
- Modify: `src/WorkflowStudio/src/store/studioState.ts:20-34,147-154` (`OpenDocument.edits`, `OpenDocument.errors`), `src/app/session.ts:142-146` (`restoredState`)
- Create: `src/WorkflowStudio/src/store/errorTarget.ts`; Delete: `src/store/problemTarget.ts`, `src/store/problemTarget.test.ts`
- Modify: `src/WorkflowStudio/src/panels/Problems.tsx`
- Test: `src/api/client.test.ts`, `src/app/loadDocument.test.ts`, `src/store/errorTarget.test.ts`, `src/panels/panes.test.tsx` (the `Problems` describe), `src/canvas/toFlow.test.ts`, `src/canvas/WorkflowCanvas.test.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 3's endpoint (in the regenerated types); Task 8's `EntityEdits`, `EMPTY_EDITS`, `LooseRoute`.
- Produces:
  - `api/types.ts`: `DesignSaveRequest`, `DesignOutcomeDto`, `DesignErrorDto` (aliases of the generated schemas); `WorkflowValidationDto`, `WorkflowProblemDto` aliases removed.
  - `StudioApi.saveDesign(workflowId: string, body: DesignSaveRequest): Promise<ApiResult<DesignOutcomeDto>>` (`PUT /workflows/{id}/design`); `StudioApi.validate` removed.
  - `model/graph.ts`: `Graph.design: unknown`; `Assignment.updatedAt: string`; `interface DesignError { kind: string; id: Id; stage: string; field: string | null; message: string }`; `WorkflowProblem` removed.
  - `api/toModel.ts`: `designErrorsFromDto(dto: DesignOutcomeDto): DesignError[]`.
  - `StudioDocument` = `{ graph; parkedIds; placement; wires; loose: LooseRoute[] }` (no `problems`).
  - `OpenDocument.edits: EntityEdits`, `OpenDocument.errors: DesignError[] | null`.
  - `store/errorTarget.ts`: `errorTarget(error: DesignError, graph: Graph, edits: EntityEdits): Selection | null`.
  - `app/fixtures.ts`: `loadedDocument(graph?: WorkflowGraphDto, parked?: StepReadDto[])`.

- [ ] **Step 1: Regenerate the API types** (PowerShell in `src/WorkflowStudio`; builds BaseApi Debug and runs the Swashbuckle CLI offline)

Run: `npm run gen:api`
Expected: `openapi/baseapi.v1.json` gains `/api/v1/workflows/{id}/design` and the `Design*` schemas; `src/api/schema.d.ts` gains `DesignSaveRequest`, `DesignOutcomeDto`, `DesignErrorDto`, and `WorkflowGraphDto.design?: unknown`.

- [ ] **Step 2: Write the failing tests**

`src/api/client.test.ts` — replace the test `POSTs validate with no body and returns the verdict` with:

```ts
  it('PUTs the design and returns the outcome (plan 8 §4.2)', async () => {
    const outcome = { applied: false, errors: [{ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' }] };
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, outcome));
    const body = { layout: { v: 1 } } as DesignSaveRequest;

    const result = await createApi('/api/v1', fetchImpl).saveDesign('wf1', body);

    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/workflows/wf1/design', {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(result).toEqual({ ok: true, value: outcome });
  });
```

(add `import type { DesignSaveRequest } from './types';`).

`src/app/loadDocument.test.ts` — in `fakeApi` replace `validate: …` with `saveDesign: vi.fn().mockResolvedValue(notFound),`; delete the tests `marks the wire a schemaEdge problem names as broken, and keeps the problem`, `still loads when validate cannot be reached, with problems null and no broken wire` and the `it.each` `draws the graph with problems null when validate answers %s`; in `loads, places and routes a workflow` delete the `problems` expectation; append:

```ts
  it('opens with GETs only: no validate, no write (plan 8 §3.1)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify(graphDto({ design: { steps: [] } } as never)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await loadDocument(createApi('/api/v1', fetchImpl as unknown as typeof fetch), 'wf1');

    expect(calls).toEqual(['GET /api/v1/workflows/wf1/graph']);
    expect(result.ok && result.value.graph.design).toEqual({ steps: [] });
    expect(result.ok && result.value.loose).toEqual([]);
  });
```

(add `import { createApi } from '../api/client';`).

`src/store/errorTarget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assignmentDto, cacheDto, graphDto, processorDto, stepDto } from '../api/fixtures';
import { graphFromDto } from '../api/toModel';
import { createAssignment, EMPTY_EDITS } from '../design/design';
import type { DesignError } from '../model/graph';
import { errorTarget } from './errorTarget';

const graph = graphFromDto(graphDto({
  steps: [stepDto('s1', { processorId: 'p1' }), stepDto('s2', { processorId: 'p1' })],
  processors: [processorDto('p1')],
  assignments: [assignmentDto('a1', { stepId: 's2' })],
  caches: [cacheDto('c1')],
}));
const error = (kind: string, id: string): DesignError => ({ kind, id, stage: 'x', field: null, message: 'm' });

describe('errorTarget (plan 8 §4.1: a Problems row selects its entity)', () => {
  it('selects the workflow, a step, a cache, and a processor on the first step that uses it', () => {
    expect(errorTarget(error('workflow', 'wf1'), graph, EMPTY_EDITS)).toEqual({ kind: 'workflow' });
    expect(errorTarget(error('step', 's2'), graph, EMPTY_EDITS)).toEqual({ kind: 'step', stepId: 's2' });
    expect(errorTarget(error('cache', 'c1'), graph, EMPTY_EDITS)).toEqual({ kind: 'cache', cacheId: 'c1' });
    expect(errorTarget(error('processor', 'p1'), graph, EMPTY_EDITS)).toEqual({ kind: 'processor', processorId: 'p1', stepId: 's1' });
  });

  it('selects an assignment\'s step, a created one\'s too, and a schema copy\'s processor', () => {
    expect(errorTarget(error('assignment', 'a1'), graph, EMPTY_EDITS)).toEqual({ kind: 'step', stepId: 's2' });
    const edits = { ...createAssignment(EMPTY_EDITS, 's1', 'x', 'n1'), schemas: { 'p1:config': { id: 'copy', name: 'n', version: 'v', description: null, definition: '{}' } } };
    expect(errorTarget(error('assignment', 'n1'), graph, edits)).toEqual({ kind: 'step', stepId: 's1' });
    expect(errorTarget(error('schema', 'copy'), graph, edits)).toEqual({ kind: 'processor', processorId: 'p1', stepId: 's1' });
  });

  it('selects nothing for an entity this canvas does not hold', () => {
    expect(errorTarget(error('step', 'gone'), graph, EMPTY_EDITS)).toBeNull();
    expect(errorTarget(error('schema', 'unknown'), graph, EMPTY_EDITS)).toBeNull();
  });
});
```

`src/panels/panes.test.tsx` — `storeWith` becomes:

```ts
async function storeWith(errors: DesignError[] | null = null): Promise<StudioStore> {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  const state = store.getState();
  return createStudioStore({ ...state, docs: state.docs.map((d) => ({ ...d, errors })) });
}
```

(add `import type { DesignError } from '../model/graph';`) and the `Problems` describe becomes:

```ts
describe('Problems (plan 8 §4.1: the last Save\'s errors)', () => {
  const errors: DesignError[] = [
    { kind: 'step', id: 's2', stage: 'steps', field: 'version', message: "'abc' is not a version" },
    { kind: 'schema', id: 'nowhere', stage: 'schemas', field: 'definition', message: 'not JSON' },
  ];

  it('says "No problems" when no Save has reported any', async () => {
    wrap(await storeWith(null), <Problems />);
    expect(screen.getByText('No problems')).toBeInTheDocument();
  });

  it('lists entity, field and message, and selects the entity of a row when clicked', async () => {
    const store = await storeWith(errors);
    wrap(store, <Problems />);
    const [named, unnamed] = screen.getAllByRole('listitem');
    expect(named).toHaveTextContent('Step');
    expect(named).toHaveTextContent('store_1.0.0-s2 · version');
    expect(named).toHaveTextContent("'abc' is not a version");

    fireEvent.click(unnamed!);
    expect(store.getState().docs[0]!.selection).toBeNull();
    fireEvent.click(named!);
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('selects from the keyboard: a row with an entity is focusable and Enter selects it', async () => {
    const store = await storeWith(errors);
    wrap(store, <Problems />);
    const [named, unnamed] = screen.getAllByRole('listitem');
    expect(named).toHaveAttribute('tabindex', '0');
    expect(unnamed).not.toHaveAttribute('tabindex');
    fireEvent.keyDown(named!, { key: 'Enter' });
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's2' });
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/api/client.test.ts src/app/loadDocument.test.ts src/store/errorTarget.test.ts src/panels/panes.test.tsx`
Expected: FAIL (`saveDesign` not a function; validate still called; `./errorTarget` missing; Problems reads `doc.problems`).

- [ ] **Step 4: Implement**

`src/api/types.ts` — delete the `WorkflowValidationDto` and `WorkflowProblemDto` lines; append:

```ts
export type DesignSaveRequest = Schemas['DesignSaveRequest'];
export type DesignOutcomeDto = Schemas['DesignOutcomeDto'];
export type DesignErrorDto = Schemas['DesignErrorDto'];
```

`src/api/client.ts` — the types import becomes `import type { AssignmentCreateDto, AssignmentReadDto, DesignOutcomeDto, DesignSaveRequest, ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto } from './types';`; in `StudioApi` replace the `validate` member with:

```ts
  /**
   * Plan 8: `PUT /workflows/{id}/design`. BaseApi stores the design on the workflow, dry-runs it, and aligns
   * the real entities only when it finds no errors; 200 either way, with `applied` and the errors.
   */
  saveDesign(workflowId: string, body: DesignSaveRequest): Promise<ApiResult<DesignOutcomeDto>>;
```

and in `createApi` replace the `validate:` line with:

```ts
    saveDesign: (workflowId, body) => request<DesignOutcomeDto>('PUT', `/workflows/${id(workflowId)}/design`, body),
```

`src/model/graph.ts` — `Assignment` gains `/** The concurrency stamp a remove or an edit sends back (plan 8). */ updatedAt: string;`; delete `WorkflowProblem`; add:

```ts
/** One error BaseApi's design dry run reported (plan 8 §4.3). Only ever the answer to a Save; never stored. */
export interface DesignError {
  kind: string;
  id: Id;
  stage: string;
  field: string | null;
  message: string;
}
```

and `Graph` gains, after `layout`:

```ts
  /** The studio's stored design exactly as the server returned it (opaque JSON), or null (plan 8). */
  design: unknown;
```

`src/api/toModel.ts` — the assignment map becomes `({ id: required(a.id, 'assignment id'), stepId: text(a.stepId), payload: text(a.payload), updatedAt: text(a.updatedAt) })`; the returned graph gains `design: dto.design ?? null,`; append (and import `DesignOutcomeDto` from `./types`, `DesignError` from `../model/graph`):

```ts
/** A Save's errors as the model carries them; every field read defensively. */
export function designErrorsFromDto(dto: DesignOutcomeDto): DesignError[] {
  return (dto.errors ?? []).map((e) => ({
    kind: text(e.kind), id: text(e.id), stage: text(e.stage), field: optional(e.field), message: text(e.message),
  }));
}
```

`src/app/document.ts`:

```ts
import type { Id, Graph } from '../model/graph';
import type { Placement } from '../layout/placement';
import type { LooseRoute, WireRoute } from '../layout/wires';

/**
 * One opened workflow, ready to draw: the graph (unwired steps included), where every block sits, every
 * wire's route, and the loose wires (plan 8 §5). Opening reads with GETs only: nothing is judged on load.
 */
export interface StudioDocument {
  graph: Graph;
  /** Steps on the canvas that the entry steps do not reach. They look like every other step (plan 8). */
  parkedIds: Id[];
  placement: Placement;
  wires: WireRoute[];
  loose: LooseRoute[];
}
```

`src/app/loadDocument.ts` — replace the doc comment's validate paragraph with "Opening is GETs only (plan 8 §3.1): no validate, nothing marked broken."; delete lines 39-45 (the validate call and `brokenEdges`), the `brokenEdgeKeys` function and the `WorkflowProblem` import; the `routeWires` call passes `brokenEdges: new Set<string>()`; the return becomes `return { ok: true, value: { graph, parkedIds, placement, wires, loose: [] } };`.

`src/design/apply.ts:42` — `return { graph: shownGraph, parkedIds, placement, wires, loose: saved.loose };` and its comment line 39 becomes `// nothing is drawn broken: opening runs no validate (plan 8)`.

`src/app/fixtures.ts`:

```ts
import type { StudioApi } from '../api/client';
import { graphDto } from '../api/fixtures';
import type { StepReadDto, WorkflowGraphDto } from '../api/types';
import type { StudioDocument } from './document';
import { loadDocument } from './loadDocument';

const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

/** Tests only: a document loaded through the real loader from a graph DTO. `parked` are the steps GET /steps/{id} returns (list their ids in the layout). */
export async function loadedDocument(graph: WorkflowGraphDto = graphDto(), parked: StepReadDto[] = []): Promise<StudioDocument> {
  const api = {
    getGraph: async () => ({ ok: true, value: graph }),
    getStep: async (id: string) => {
      const step = parked.find((s) => s.id === id);
      return step ? { ok: true, value: step } : notFound;
    },
    getProcessor: async () => notFound,
    getSchema: async () => notFound,
  } as unknown as StudioApi;
  const result = await loadDocument(api, graph.workflow?.id ?? 'wf1');
  if (!result.ok) throw new Error(`fixture failed to load: ${JSON.stringify(result.error)}`);
  return result.value;
}
```

`src/store/studioState.ts` — import `type EntityEdits, EMPTY_EDITS` from `'../design/design'` and `type DesignError` from `'../model/graph'`; `OpenDocument` gains:

```ts
  /** The Inspector's part of the design (plan 8): entity edits, assignment operations, schema copies. Not in the undo history. */
  edits: EntityEdits;
  /** The last Save's errors (plan 8 §4.1); null: no Save answered with errors since it was opened, saved or discarded. */
  errors: DesignError[] | null;
```

and the `'open'` case's new document gains `edits: EMPTY_EDITS, errors: null`. `src/app/session.ts` `restoredState` adds `edits: EMPTY_EDITS, errors: null,` to each restored document (import `EMPTY_EDITS`).

`src/store/errorTarget.ts`:

```ts
import type { EntityEdits } from '../design/design';
import type { DesignError, Graph, Id } from '../model/graph';
import type { Selection } from './selection';

/**
 * The entity a Save error names, as a canvas selection (plan 8 §4.1: clicking a Problems row selects it),
 * or null when it names nothing on this canvas. An assignment selects its step (a created one's step is
 * found in the design); a processor, and a schema copy through its processor, select the processor on the
 * first step that uses it.
 */
export function errorTarget(error: DesignError, graph: Graph, edits: EntityEdits): Selection | null {
  switch (error.kind) {
    case 'workflow': return { kind: 'workflow' };
    case 'step': return graph.steps.has(error.id) ? { kind: 'step', stepId: error.id } : null;
    case 'cache': return graph.caches.has(error.id) ? { kind: 'cache', cacheId: error.id } : null;
    case 'processor': return processorOn(graph, error.id);
    case 'assignment': {
      const stepId = graph.assignments.find((a) => a.id === error.id)?.stepId
        ?? Object.entries(edits.assignments).find(([, op]) => op.id === error.id)?.[0];
      return stepId !== undefined && graph.steps.has(stepId) ? { kind: 'step', stepId } : null;
    }
    case 'schema': {
      const key = Object.entries(edits.schemas).find(([, c]) => c.id === error.id)?.[0];
      return key === undefined ? null : processorOn(graph, key.slice(0, key.lastIndexOf(':')));
    }
    default: return null;
  }
}

function processorOn(graph: Graph, id: Id): Selection | null {
  for (const step of graph.steps.values()) if (step.processorId === id) return { kind: 'processor', processorId: id, stepId: step.id };
  return null;
}
```

`src/panels/Problems.tsx`:

```tsx
import { useGuard } from '../app/studioActions';
import { entityName } from '../model/entityNames';
import type { DesignError, Graph } from '../model/graph';
import { errorTarget } from '../store/errorTarget';
import { selectionKey } from '../store/selection';
import { activeDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { PaneNote } from './PaneNote';

const KIND: Readonly<Record<string, string>> = {
  workflow: 'Workflow', step: 'Step', processor: 'Processor', cache: 'Cache', assignment: 'Assignment', schema: 'Schema',
};

/** The entity a row names, by its unique name when this canvas holds it, else by its id. */
function entityLabel(e: DesignError, graph: Graph): string {
  const named = (x: { name: string; version: string; id: string } | undefined) => (x ? entityName(x.name, x.version, x.id) : e.id);
  switch (e.kind) {
    case 'workflow': return named(graph.workflow);
    case 'step': return named(graph.steps.get(e.id));
    case 'processor': return named(graph.processors.get(e.id));
    case 'cache': return named(graph.caches.get(e.id));
    default: return e.id;
  }
}

/**
 * Problems (plan 8 §4.1): the errors of the active document's last Save, one row each: the entity, the
 * field and the message. Clicking a row selects its entity. Opening a workflow shows none: it runs no
 * dry run, and errors are never stored.
 */
export function Problems() {
  const active = useStudio(activeDocument);
  const store = useStudioStore();
  const guard = useGuard();

  if (active === null) return <PaneNote pane="problems">Open a workflow to see its problems.</PaneNote>;
  if (active.status.kind === 'loading') return <PaneNote pane="problems">Loading…</PaneNote>;
  if (active.status.kind === 'failed') return <PaneNote pane="problems">Problems unavailable.</PaneNote>;
  const errors = active.errors ?? [];
  if (errors.length === 0) return <PaneNote pane="problems">No problems</PaneNote>;
  const { graph } = active.status.doc;

  return (
    <div className="paneBody" data-pane="problems">
      <div className="pbody" role="list" aria-label="Problems">
        {errors.map((error, i) => {
          const target = errorTarget(error, graph, active.edits);
          const choose = () => store.dispatch({ type: 'select', workflowId: active.workflowId, selection: target });
          const select = target === null ? undefined
            : (from: Element) => (selectionKey(target) === selectionKey(active.selection) ? choose() : guard(active.workflowId, choose, from.ownerDocument));
          return (
            <div
              key={i}
              role="listitem"
              className={select ? 'prob' : 'prob static'}
              tabIndex={select ? 0 : undefined}
              onClick={select ? (e) => select(e.currentTarget) : undefined}
              onKeyDown={select ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e.currentTarget); } } : undefined}
              data-tip={select ? 'Select it' : undefined}
            >
              <span className="gate">{KIND[error.kind] ?? error.kind}</span>
              <b>{entityLabel(error, graph)}{error.field ? ` · ${error.field}` : ''}</b>
              <div className="pd">{error.message}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

Delete `src/store/problemTarget.ts` and `src/store/problemTarget.test.ts`.

Fix the remaining compile errors the type check names, mechanically:
- `src/canvas/toFlow.test.ts` `doc()`: the graph gains `design: null`, the assignment gains `updatedAt: ''`, and `problems: []` becomes `loose: []`.
- `src/canvas/WorkflowCanvas.test.tsx`, `src/App.test.tsx`: delete every `validate: …` entry of the fake APIs; in `App.test.tsx` delete the test `asks before a Problems click selects another entity, and not for the one already selected` (validate problems no longer exist; Problems rows come from Save, Task 13) and the `expect(api.validate).toHaveBeenCalledTimes(4)` line in `re-reads every open document after a save`.
- Any other object literal of a `StudioDocument` or `Graph` the checker names: add `loose: []` / `design: null` / `updatedAt: ''` and drop `problems`.

- [ ] **Step 5: Run to verify they pass**

Run: `npx tsc -b; Remove-Item tsconfig.tsbuildinfo; npx vitest run`
Expected: the type check is clean; all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/WorkflowStudio/openapi src/WorkflowStudio/src
git commit -m "feat(studio): open with GETs only (no validate), saveDesign on the client, Problems lists a Save's errors (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `applyDesign`: the base, the entity edits and the draft, with loose wires routed

**Files:**
- Modify: `src/WorkflowStudio/src/layout/wires.ts` (imports; `routeLoose` after `routeWires`)
- Modify: `src/WorkflowStudio/src/design/apply.ts`
- Modify: `src/WorkflowStudio/src/app/DocumentPanel.tsx:43-64` (the canvas draws the base with the entity edits)
- Test: `src/WorkflowStudio/src/design/apply.test.ts`

**Interfaces:**
- Consumes: Task 8 (`EntityEdits`, `isEmptyEdits`, `valueText`, `LooseWire`, `LooseRoute`, `Draft.loose`).
- Produces: `routeLoose(loose: Readonly<Record<string, LooseWire>>, placement: Placement): LooseRoute[]`; `applyEdits(base: StudioDocument, edits: EntityEdits): StudioDocument` (the same object when the edits change nothing); `applyDesign(base, draft, edits) = applyDraft(applyEdits(base, edits), draft)`; `applyDraft` now sets `loose`.

- [ ] **Step 1: Write the failing tests** (append to `src/design/apply.test.ts`; add to its imports `assignmentDto, processorDto, schemaDto, stepDto, workflowDto` from `../api/fixtures`, `applyDesign` from `./apply`, `createAssignment, EMPTY_EDITS, removeAssignment, setField` from `./design`, `addLoose, EMPTY_DRAFT` from `./draft`, `PMID, STEP_W` from `../layout/geometry`)

```ts
describe('applyDesign (plan 8 §3.1: what the canvas, the Inspector and the panels show)', () => {
  it('lays the entity edits over the base: names, an entry condition and its wire colour, a schema copy, assignments', async () => {
    const base = await loadedDocument(graphDto({
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 1 })],
      processors: [processorDto('p1', { configSchemaId: 'sc1' })],
      schemas: [schemaDto('sc1')],
      assignments: [assignmentDto('a1', { stepId: 's2' })],
    }));
    let edits = setField(EMPTY_EDITS, { kind: 'step', id: 's2' }, stepDto('s2'), 'entryCondition', 2, () => 'x');
    edits = setField(edits, { kind: 'workflow' }, workflowDto(), 'name', 'renamed', () => 'x');
    edits = setField(edits, { kind: 'schema', processorId: 'p1', slot: 'config' }, schemaDto('sc1'), 'definition', '{"type":"string"}', () => 'copy1');
    edits = createAssignment(removeAssignment(edits, 's2', { id: 'a1', updatedAt: '' }), 's1', 'step-s1', 'n1');

    const shown = applyDesign(base, EMPTY_DRAFT, edits);

    expect(shown.graph.workflow.name).toBe('renamed');
    expect(shown.graph.steps.get('s2')!.entryCondition).toBe(2);
    expect(shown.wires.find((w) => w.id === 's1->s2')!.condition).toBe(2);
    expect(shown.graph.processors.get('p1')!.configSchemaId).toBe('copy1');
    expect(shown.graph.schemas.get('copy1')!.name).toBe('schema-sc1');
    expect(shown.graph.assignments.map((a) => a.id)).toEqual(['n1']);
    expect(base.graph.workflow.name).toBe('orders'); // the base is untouched
  });

  it('gives back the base itself when nothing is designed', async () => {
    const base = await loadedDocument();
    expect(applyDesign(base, EMPTY_DRAFT, EMPTY_EDITS)).toBe(base);
  });

  it('routes a loose wire from its source\'s port to its open end, and drops one whose source is not on the canvas', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const at = base.placement.steps.get('s1')!;
    const draft = addLoose(addLoose(EMPTY_DRAFT, 'l1', 's1', { x: at.x + 600, y: at.y + 240 }), 'l2', 'gone', { x: 0, y: 0 });

    const shown = applyDesign(base, draft, EMPTY_EDITS);

    expect(shown.loose.map((l) => l.id)).toEqual(['l1']);
    const pts = shown.loose[0]!.points;
    expect(pts[0]).toEqual([at.x + STEP_W, at.y + PMID]);
    expect(pts[pts.length - 1]).toEqual([at.x + 600, at.y + 240]);
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual([]); // never part of the wiring
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/design/apply.test.ts`
Expected: FAIL (`applyDesign` is not exported).

- [ ] **Step 3: Implement**

`src/layout/wires.ts` — add `PMID` to the `./geometry` import and `WORKFLOW_SOURCE` is already imported from `./ports`; after `routeWires`:

```ts
/** Loose wires (plan 8 §5), each from its source's port to its open end; one whose source is not on the canvas is left out. */
export function routeLoose(loose: Readonly<Record<string, LooseWire>>, placement: Placement): LooseRoute[] {
  const boxes = blockBoxes(placement);
  const out: LooseRoute[] = [];
  for (const [id, l] of Object.entries(loose)) {
    const step = l.source === WORKFLOW_SOURCE ? null : placement.steps.get(l.source);
    if (l.source !== WORKFLOW_SOURCE && !step) continue;
    const from = step ? { x: step.x + STEP_W, y: step.y + PMID } : { x: placement.sphere.cx + SPHERE_R, y: placement.sphere.cy };
    out.push({ id, source: l.source, points: clearPath(route(from.x, from.y, l.end.x, l.end.y, boxIdOf(l.source), '', 0, boxes), boxes) });
  }
  return out;
}
```

`src/design/apply.ts` — imports gain `routeLoose` (with `routeWires`) from `../layout/wires`, `type Assignment, type Cache, type Processor, type Schema` from `../model/graph`, `isEmptyEdits, valueText, type EntityEdits, type FieldValue` from `./design`; the last line of `applyDraft` becomes:

```ts
  return { graph: shownGraph, parkedIds, placement, wires, loose: routeLoose(draft.loose, placement) };
```

and append:

```ts
const NO_AUDIT = { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null };
const text = (f: Readonly<Record<string, FieldValue>>, k: string, was: string): string => (Object.hasOwn(f, k) ? valueText(f[k]) : was);
const nullable = (f: Readonly<Record<string, FieldValue>>, k: string, was: string | null): string | null =>
  (Object.hasOwn(f, k) ? (valueText(f[k]) === '' ? null : valueText(f[k])) : was);

/**
 * The base with the design's entity edits laid over it (spec §3.1): fields, a slot re-pointed to its schema
 * copy, assignments created, updated or deleted. Wires are routed again, so an entry condition changed in the
 * design colours its wires. Pure; edits that change nothing give the base back unchanged.
 */
export function applyEdits(base: StudioDocument, edits: EntityEdits): StudioDocument {
  if (isEmptyEdits(edits)) return base;
  const g = base.graph;
  const wf = edits.workflow?.fields ?? {};
  const workflow = {
    ...g.workflow, name: text(wf, 'name', g.workflow.name), version: text(wf, 'version', g.workflow.version),
    description: nullable(wf, 'description', g.workflow.description), cronExpression: nullable(wf, 'cronExpression', g.workflow.cronExpression),
  };

  const steps = new Map(g.steps);
  for (const [id, e] of Object.entries(edits.steps)) {
    const s = steps.get(id);
    if (!s) continue;
    const f = e.fields;
    steps.set(id, {
      ...s, name: text(f, 'name', s.name), version: text(f, 'version', s.version), description: nullable(f, 'description', s.description),
      entryCondition: typeof f.entryCondition === 'number' ? f.entryCondition : s.entryCondition,
    });
  }

  const processors = new Map<string, Processor>(g.processors);
  for (const [id, e] of Object.entries(edits.processors)) {
    const p = processors.get(id);
    if (!p) continue;
    const f = e.fields;
    processors.set(id, {
      ...p, name: text(f, 'name', p.name), version: text(f, 'version', p.version), description: nullable(f, 'description', p.description),
      sourceHash: text(f, 'sourceHash', p.sourceHash), instanceId: nullable(f, 'instanceId', p.instanceId),
    });
  }

  const schemas = new Map<string, Schema>(g.schemas);
  for (const [key, c] of Object.entries(edits.schemas)) {
    const at = key.lastIndexOf(':');
    const pid = key.slice(0, at), slot = key.slice(at + 1);
    const p = processors.get(pid);
    if (!p) continue;
    const was = slot === 'input' ? p.inputSchemaId : slot === 'output' ? p.outputSchemaId : p.configSchemaId;
    schemas.set(c.id, { id: c.id, name: c.name, version: c.version, description: c.description, audit: (was ? g.schemas.get(was)?.audit : undefined) ?? NO_AUDIT });
    processors.set(pid, slot === 'input' ? { ...p, inputSchemaId: c.id } : slot === 'output' ? { ...p, outputSchemaId: c.id } : { ...p, configSchemaId: c.id });
  }

  const caches = new Map<string, Cache>(g.caches);
  for (const [id, e] of Object.entries(edits.caches)) {
    const c = caches.get(id);
    if (!c) continue;
    const f = e.fields;
    caches.set(id, {
      ...c, name: text(f, 'name', c.name), version: text(f, 'version', c.version), description: nullable(f, 'description', c.description),
      root: text(f, 'root', c.root), items: text(f, 'items', c.items),
    });
  }

  let assignments: Assignment[] = g.assignments;
  for (const [stepId, op] of Object.entries(edits.assignments)) {
    if (op.op === 'delete') assignments = assignments.filter((a) => a.id !== op.id);
    else if (op.op === 'update') assignments = assignments.map((a) => (a.id === op.id && typeof op.fields.payload === 'string' ? { ...a, payload: op.fields.payload } : a));
    else assignments = [...assignments.filter((a) => a.stepId !== stepId), { id: op.id, stepId, payload: typeof op.fields.payload === 'string' ? op.fields.payload : '{}', updatedAt: '' }];
  }

  const graph: Graph = { ...g, workflow, steps, processors, schemas, caches, assignments };
  const wires = routeWires({ entryStepIds: workflow.entryStepIds, steps, brokenEdges: new Set<string>() }, base.placement);
  return { ...base, graph, wires };
}

/** What the canvas shows (spec §3.1): the base, the entity edits, then the canvas draft. */
export function applyDesign(base: StudioDocument, draft: Draft, edits: EntityEdits): StudioDocument {
  return applyDraft(applyEdits(base, edits), draft);
}
```

`src/app/DocumentPanel.tsx` — import `applyEdits` from `../design/apply`; after the `cls` line (before the early returns, so the hook order never changes) add:

```ts
  // the canvas draws the design (plan 8 §3.1): the base with the entity edits; the canvas draft goes over it inside the canvas
  const base = open?.status.kind === 'ready' ? open.status.doc : null;
  const edits = open?.edits ?? null;
  const edited = useMemo(() => (base && edits ? applyEdits(base, edits) : null), [base, edits]);
```

and the canvas takes `doc={edited ?? open.status.doc}`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/design src/layout src/app; npx tsc -b; Remove-Item tsconfig.tsbuildinfo`
Expected: PASS; type check clean.

- [ ] **Step 5: Commit**

```powershell
git add src/WorkflowStudio/src/design/apply.ts src/WorkflowStudio/src/design/apply.test.ts src/WorkflowStudio/src/layout/wires.ts src/WorkflowStudio/src/app/DocumentPanel.tsx
git commit -m "feat(studio): applyDesign lays entity edits and the draft over the base; loose wires routed from their source (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The store keeps the stored design, the unsaved edits and the save state; the session keeps the edits

**Files:**
- Modify: `src/WorkflowStudio/src/store/studioState.ts`, `src/store/inspector.ts`, `src/store/inspectorTarget.ts`
- Modify: `src/WorkflowStudio/src/app/session.ts`
- Test: `src/store/studioState.test.ts`, `src/app/session.test.ts`

**Interfaces:**
- Consumes: Task 8 (`Design`, `EntityEdits`, `storedDesignOf`, `sameDesign`, `hasGraphChanges`, `setField`, `revertEntity`, `createAssignment`, `removeAssignment`, `LOOSE_PREFIX`), Task 9 (`DesignError`).
- Produces:
  - `OpenDocument` gains `stored: Design | null`, `restored: boolean`, `saving: boolean` (Task 9 added `edits`, `errors`); `StudioState.output: OutputLine[]`, `interface OutputLine { at: string; workflowId: Id; name: string; text: string }`.
  - Actions: `editField { workflowId, key, value: FieldValue, copyId }`, `revertEntity { workflowId }`, `createAssignment { workflowId, stepId, stepName, id }`, `removeAssignment { workflowId, stepId }`, `saving { workflowId }`, `saveAnswered { workflowId, at, applied, errors: DesignError[], doc: StudioDocument | null }`, `saveFailed { workflowId, at, message }`. Removed: `edit`, `discard`, `busy`, the old `saveFailed`, `saved`, `created`, `refreshed`; `back` loses `write`.
  - `designOf(d): Design`, `designDirty(d)`, `canSave(d)`.
  - `InspectorState = { trail, saved, readError }`; `InspectorDraft = { trail }`; `hasEdits` removed.
  - `inspectorTarget.ts`: schema targets carry `processorId` (`{ kind: 'schema'; id: Id; slot: SchemaSlot; processorId: Id }`, `id` '' for an empty slot); `newAssignment` removed; `targetKey` of a schema is `schema:{processorId}:{slot}`; `editTargetOf(target): EditTarget`.
  - Session: `SessionDoc.draft?: { trail }`, `SessionDoc.design?: Draft`, `SessionDoc.edits?: EntityEdits` (written while `designDirty`).

- [ ] **Step 1: Write the failing tests**

`src/store/studioState.test.ts` — delete the tests that test what plan 8 removes: in `the Inspector (slice 3b)`: `keeps an edit until it is typed back to the saved value`, `saved clears only what it sent: text typed during the save stays (review focus 1)`, `a failed save keeps the edits and says why; discard drops both`, `a created assignment replaces the new-assignment form in the trail`, `a created assignment keeps the text typed while it was created (final review 1)`, `a back carrying a write token applies only while that write is current; a back from the user always applies`, `a late saveFailed or created, after the user moved on, changes nothing`, `after created the Inspector stays busy until the link settles; only its own busy false clears it`, `a link that fails after created still shows its failure on the new assignment`, `a late back from a remove, after the user left and re-opened the same assignment and typed, leaves the edits`, `a late saved or saveFailed from an earlier write does not clear the busy flag of a newer write`, `a refreshed document takes the new graph and name, keeping its Inspector; retry reloads a failed one`. In `opens a document with an empty Inspector…` delete the `edit` dispatch; in `a read drops edits that already match what was read; a failed read says why` keep only the failed-read half (rename it `a failed re-read keeps the form it had, with why`) and drop its `edits` expectations. In `designing (plan 4)` make `opened` load the document: `const opened = () => reduce(reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }), { type: 'loaded', workflowId: 'wf1', doc });`. Then append:

```ts
describe('the design (plan 8)', () => {
  const graph = graphDto({
    steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2')],
    assignments: [assignmentDto('a2', { stepId: 's2', updatedAt: '2026-10-07T10:00:00Z' })],
    design: { steps: [{ id: 's1', updatedAt: 't0', fields: { description: 'stored' } }] },
  } as never);
  const loaded = async (s: StudioState = run(open('wf1'))) => reduce(s, { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  const d0 = (s: StudioState) => s.docs[0]!;

  it('loading takes the stored design; it is not dirty, and Save is offered because it is not applied', async () => {
    const s = await loaded();
    expect(d0(s).edits.steps['s1']!.fields).toEqual({ description: 'stored' });
    expect(designDirty(d0(s))).toBe(false);
    expect(canSave(d0(s))).toBe(true);
  });

  it('a restored document keeps its session design when it loads (Review Focus 3)', async () => {
    const session = { version: 1 as const, activeId: 'wf1', showDetails: false, dock: null,
      docs: [{ workflowId: 'wf1', name: 'orders', version: '1.0.0', selection: null, view: null,
        design: { ...EMPTY_DRAFT, next: { s1: [] } }, edits: { ...EMPTY_EDITS, caches: { c9: { updatedAt: null, fields: { root: 'r' } } } } }] };
    const s = await loaded(restoredState(session));
    expect(d0(s).design.draft.next).toEqual({ s1: [] });
    expect(d0(s).edits.caches['c9']).toBeDefined();
    expect(d0(s).stored!.edits.steps['s1']).toBeDefined();
    expect(designDirty(d0(s))).toBe(true);
  });

  it('Discard design returns to the stored design, not to nothing (Review Focus 4)', async () => {
    let s = await loaded();
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, next: { s1: [] } } });
    s = reduce(s, { type: 'discardDesign', workflowId: 'wf1' });
    expect(d0(s).design.draft.next).toEqual({});
    expect(d0(s).edits.steps['s1']!.fields).toEqual({ description: 'stored' });
    expect(designDirty(d0(s))).toBe(false);
  });

  it('a typed field changes the shown entity in the design once its base is read; never while saving', async () => {
    let s = reduce(await loaded(), { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's2' } });
    const edit: StudioAction = { type: 'editField', workflowId: 'wf1', key: 'name', value: 'renamed', copyId: 'c' };
    expect(reduce(s, edit)).toBe(s); // nothing read yet
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s2', result: { ok: true, dto: stepDto('s2') } });
    s = reduce(s, edit);
    expect(d0(s).edits.steps['s2']!.fields).toEqual({ name: 'renamed' });
    expect(designDirty(d0(s))).toBe(true);
    s = reduce(s, { type: 'revertEntity', workflowId: 'wf1' });
    expect(d0(s).edits.steps['s2']).toBeUndefined();
    const saving = reduce(s, { type: 'saving', workflowId: 'wf1' });
    expect(reduce(saving, edit)).toBe(saving);
  });

  it('Create shows the new assignment at once; Remove of the shown one goes back to its step', async () => {
    let s = reduce(await loaded(), { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    s = reduce(s, { type: 'createAssignment', workflowId: 'wf1', stepId: 's1', stepName: 'fetch', id: 'n1' });
    expect(d0(s).edits.assignments['s1']).toMatchObject({ op: 'create', id: 'n1' });
    expect(shownTargetOf(d0(s))).toEqual({ kind: 'assignment', id: 'n1', stepId: 's1' });
    s = reduce(s, { type: 'removeAssignment', workflowId: 'wf1', stepId: 's1' });
    expect(d0(s).edits.assignments['s1']).toBeUndefined();
    expect(shownTargetOf(d0(s))).toEqual({ kind: 'step', id: 's1' });
    // the base's assignment is deleted on Save, with its loaded stamp
    s = reduce(s, { type: 'removeAssignment', workflowId: 'wf1', stepId: 's2' });
    expect(d0(s).edits.assignments['s2']).toEqual({ op: 'delete', id: 'a2', updatedAt: '2026-10-07T10:00:00Z' });
  });

  it('a Save answer: the design read back is the stored one, the session edits go, errors and Output follow the answer', async () => {
    let s = reduce(await loaded(), { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, next: { s1: [] } } });
    s = reduce(s, { type: 'saving', workflowId: 'wf1' });
    expect(canSave(d0(s))).toBe(false);
    const errors = [{ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' }];
    const reread = await loadedDocument(graphDto({ ...graph, design: { steps: [{ id: 's1', nextStepIds: [] }] } } as never));
    s = reduce(s, { type: 'saveAnswered', workflowId: 'wf1', at: '2026-10-07T12:00:00Z', applied: false, errors, doc: reread });
    expect(d0(s).saving).toBe(false);
    expect(d0(s).errors).toEqual(errors);
    expect(d0(s).design.draft.next).toEqual({ s1: [] });
    expect(designDirty(d0(s))).toBe(false);
    expect(s.output.at(-1)).toMatchObject({ workflowId: 'wf1', text: 'Saved; not applied: 1 error' });

    s = reduce(s, { type: 'saveAnswered', workflowId: 'wf1', at: '2026-10-07T12:01:00Z', applied: true, errors: [], doc: await loadedDocument(graphDto()) });
    expect(d0(s).errors).toBeNull();
    expect(s.output.at(-1)!.text).toBe('Saved and applied');
    s = reduce(s, { type: 'saveFailed', workflowId: 'wf1', at: '2026-10-07T12:02:00Z', message: 'Network error: down' });
    expect(s.output.at(-1)!.text).toBe('Not saved: Network error: down');
  });
});
```

(imports: add `assignmentDto` to the fixtures import, `EMPTY_EDITS` from `../design/design`, `restoredState` from `../app/session`, `canSave` to the `./studioState` import.)

`src/app/session.test.ts` — in `the draft (slice 3b, spec §6.1)` the draft is now only a trail: replace `reads a valid draft and drops a broken one, never the session` and `writes a document's draft only when it has one, and restores it into the Inspector` with:

```ts
  it('keeps the Inspector\'s trail across a refresh, and drops a broken one', () => {
    const storage = memoryStorage();
    const trail = [{ kind: 'processor', id: 'p1' }];
    writeSession(storage, { version: 1, activeId: 'wf1', showDetails: false, dock: null,
      docs: [{ workflowId: 'wf1', name: 'a', version: '1', selection: { kind: 'step', stepId: 's1' }, view: null, draft: { trail } as never }] });
    expect(restoredState(readSession(storage)).docs[0]!.inspector.trail).toEqual(trail);
    storage.setItem(SESSION_KEY, JSON.stringify({ version: 1, docs: [{ workflowId: 'wf1', name: 'a', version: '1', draft: { trail: [{ kind: 'nope' }] } }] }));
    expect(restoredState(readSession(storage)).docs[0]!.inspector.trail).toEqual([]);
  });
```

and in `the design draft (plan 4)` replace `writes no design field while there is no draft` with:

```ts
  it('writes the design and the edits only while they differ from the stored design, and restores both (plan 8 §3.2)', async () => {
    let s = reduce(reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }),
      { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument() });
    expect(sessionOf(s, new Map(), null).docs[0]!.design).toBeUndefined();
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, loose: { l1: { source: 's1', end: { x: 8, y: 8 } } } } });
    const written = JSON.parse(JSON.stringify(sessionOf(s, new Map(), null)));
    const back = restoredState(readSession(storageWith(written))).docs[0]!;
    expect(back.design.draft.loose['l1']).toEqual({ source: 's1', end: { x: 8, y: 8 } });
    expect(back.edits).toEqual(EMPTY_EDITS);
    expect(back.restored).toBe(true);
  });
```

where `storageWith` is a local helper `const storageWith = (session: unknown) => { const st = memoryStorage(); st.setItem(SESSION_KEY, JSON.stringify(session)); return st; };` (imports: `reduce`, `INITIAL_STATE` from `../store/studioState`, `loadedDocument` from `./fixtures`, `EMPTY_DRAFT` from `../design/draft`, `EMPTY_EDITS` from `../design/design`, `memoryStorage` from `../test/memoryStorage`, and `SESSION_KEY` if the file does not import it yet). Existing session tests that build a `SessionDoc` with `draft: { trail, edits }` keep working (extra keys are ignored).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/store/studioState.test.ts src/app/session.test.ts`
Expected: FAIL (unknown actions; `canSave` not exported; `restored`, `output` missing).

- [ ] **Step 3: Implement**

`src/store/inspector.ts`:

```ts
import type { EntityReadDto } from '../api/entities';
import type { InspectorTarget } from './inspectorTarget';

/** What a refresh keeps of a document's Inspector (spec §6.1): where it was drilled to. Typed text lives in the design (plan 8). */
export interface InspectorDraft {
  /** The drill-downs below the selection, in order; empty: the selection itself is shown. */
  trail: InspectorTarget[];
}

export interface InspectorState extends InspectorDraft {
  /** The shown entity's base (its GET, or made up for what the database does not hold yet) and the target key it belongs to. */
  saved: { key: string; dto: EntityReadDto } | null;
  /** Why the shown entity could not be read. */
  readError: string | null;
}

export const EMPTY_INSPECTOR: InspectorState = { trail: [], saved: null, readError: null };
```

`src/store/inspectorTarget.ts` — the `schema` member becomes `| { kind: 'schema'; id: Id; slot: SchemaSlot; processorId: Id }` with the doc line "`id` is the slot's schema in the database ('' when the slot is empty); the design's copy is found by processor and slot (plan 8)"; delete the `newAssignment` member and its cases (`targetKey`, `entityKindOf`, `crumbLabel`, `isTarget`); `targetKey` returns `` `schema:${target.processorId}:${target.slot}` `` for a schema; `isTarget`'s schema case becomes `return typeof v.id === 'string' && id('processorId') && (v.slot === 'input' || v.slot === 'output' || v.slot === 'config');`; append:

```ts
/** The design entity a target edits (plan 8): a schema by its processor's slot, an assignment by its step. */
export function editTargetOf(target: InspectorTarget): EditTarget {
  switch (target.kind) {
    case 'workflow': return { kind: 'workflow' };
    case 'schema': return { kind: 'schema', processorId: target.processorId, slot: target.slot };
    case 'assignment': return { kind: 'assignment', id: target.id, stepId: target.stepId };
    default: return { kind: target.kind, id: target.id };
  }
}
```

(import `type EditTarget` from `../design/design`). `entityKindOf` becomes `(target) => target.kind`.

`src/store/studioState.ts`:
- imports: `LOOSE_PREFIX, entriesOf, nextOf, wireEnds, EMPTY_DRAFT, type Draft` from `../design/draft`; `createAssignment, EMPTY_EDITS, hasGraphChanges, removeAssignment, revertEntity, sameDesign, setField, storedDesignOf, type Design, type EntityEdits, type FieldValue` from `../design/design`; `editTargetOf` with the other `./inspectorTarget` imports; drop `savedText` and `SaveFailure`.
- `OpenDocument` gains:

```ts
  /** The last saved design (plan 8 §3.1): the stored design read back with the graph; null until it is loaded. */
  stored: Design | null;
  /** The session brought unsaved design edits back: loading keeps them instead of the stored design. */
  restored: boolean;
  /** A Save is in flight: the design is read-only (spec §4.1). */
  saving: boolean;
```

- `StudioState` gains `/** Save results, oldest first (plan 8 §4.1); not kept across a refresh. */ output: OutputLine[];` and:

```ts
export interface OutputLine {
  /** ISO time of the answer. */
  at: string;
  workflowId: Id;
  name: string;
  text: string;
}
```

- `INITIAL_STATE` = `{ docs: [], activeId: null, showDetails: false, output: [] }`.
- `StudioAction`: delete `edit`, `discard`, `busy`, `saveFailed`, `saved`, `created`, `refreshed`; `back` becomes `{ type: 'back'; workflowId: Id; depth: number }`; add:

```ts
  /** A field typed into the shown entity: a design edit (spec §3.3). `copyId` names a schema copy if this edit makes one. */
  | { type: 'editField'; workflowId: Id; key: string; value: FieldValue; copyId: string }
  /** Drops the shown entity's design edits. */
  | { type: 'revertEntity'; workflowId: Id }
  /** Creates a step's assignment in the design and shows it. */
  | { type: 'createAssignment'; workflowId: Id; stepId: Id; stepName: string; id: Id }
  /** Removes a step's assignment in the design. */
  | { type: 'removeAssignment'; workflowId: Id; stepId: Id }
  | { type: 'saving'; workflowId: Id }
  /** BaseApi's answer to a Save, with the document read again (null: the re-read failed). */
  | { type: 'saveAnswered'; workflowId: Id; at: string; applied: boolean; errors: DesignError[]; doc: StudioDocument | null }
  /** A Save that never got an answer (400, network): nothing was stored. */
  | { type: 'saveFailed'; workflowId: Id; at: string; message: string }
```

- `'open'` adds `stored: null, restored: false, saving: false` (Task 9 added `edits`, `errors`).
- `'loaded'`:

```ts
    case 'loaded':
      return update(state, action.workflowId, (d) => {
        const stored = storedDesignOf(action.doc.graph.design, action.doc.graph.layout);
        // a refresh's unsaved edits win over the stored design (spec §3.2)
        const design = d.restored ? {} : { design: historyOf(stored.draft), edits: stored.edits };
        return { ...d, ...design, name: action.doc.graph.workflow.name, version: action.doc.graph.workflow.version, status: { kind: 'ready', doc: action.doc }, stored, restored: false };
      });
```

- `'discardDesign'`:

```ts
    case 'discardDesign':
      return update(state, action.workflowId, (d) => {
        const back = redesign(d, historyOf(d.stored?.draft ?? EMPTY_DRAFT));
        return { ...back, edits: d.stored?.edits ?? EMPTY_EDITS, errors: null };
      });
```

- `'back'`: `return inspect(state, action.workflowId, (i) => (action.depth >= i.trail.length ? i : { ...EMPTY_INSPECTOR, trail: i.trail.slice(0, Math.max(0, action.depth)) }));`
- `'read'`: the ok branch becomes `return { ...i, saved: { key: action.key, dto: action.result.dto }, readError: null };`.
- delete the `edit`, `discard`, `busy`, old `saveFailed`, `saved`, `created`, `refreshed` cases; add:

```ts
    case 'editField':
      return update(state, action.workflowId, (d) => {
        const target = shownTargetOf(d);
        const base = d.inspector.saved;
        if (d.saving || target === null || base === null || base.key !== targetKey(target)) return d;
        return { ...d, edits: setField(d.edits, editTargetOf(target), base.dto, action.key, action.value, () => action.copyId) };
      });
    case 'revertEntity':
      return update(state, action.workflowId, (d) => {
        const target = shownTargetOf(d);
        return d.saving || target === null ? d : { ...d, edits: revertEntity(d.edits, editTargetOf(target)) };
      });
    case 'createAssignment':
      return update(state, action.workflowId, (d) => {
        if (d.saving) return d;
        const edits = createAssignment(d.edits, action.stepId, action.stepName, action.id);
        const shown = edits.assignments[action.stepId]!;
        return { ...d, edits, inspector: { ...EMPTY_INSPECTOR, trail: [...d.inspector.trail, { kind: 'assignment', id: shown.id, stepId: action.stepId }] } };
      });
    case 'removeAssignment':
      return update(state, action.workflowId, (d) => {
        if (d.saving) return d;
        const base = d.status.kind === 'ready' ? d.status.doc.graph.assignments.find((a) => a.stepId === action.stepId) : undefined;
        const edits = removeAssignment(d.edits, action.stepId, base && { id: base.id, updatedAt: base.updatedAt });
        const shown = shownTargetOf(d);
        const leave = shown?.kind === 'assignment' && shown.stepId === action.stepId;
        return { ...d, edits, inspector: leave ? { ...EMPTY_INSPECTOR, trail: d.inspector.trail.slice(0, -1) } : d.inspector };
      });
    case 'saving':
      return update(state, action.workflowId, (d) => (d.saving ? d : { ...d, saving: true }));
    case 'saveAnswered': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      if (!doc) return state;
      const n = action.errors.length;
      const text = action.applied ? 'Saved and applied' : `Saved; not applied: ${n} error${n === 1 ? '' : 's'}`;
      const next = update(state, action.workflowId, (d) => {
        // either way the design is now stored on the workflow and the session's edits are cleared (spec §4.1)
        const stored = action.doc ? storedDesignOf(action.doc.graph.design, action.doc.graph.layout) : designOf(d);
        const status: DocStatus = action.doc ? { kind: 'ready', doc: action.doc } : d.status;
        const out: OpenDocument = {
          ...d, status, stored, restored: false, saving: false, errors: action.applied ? null : action.errors,
          design: historyOf(stored.draft), edits: stored.edits,
          name: action.doc?.graph.workflow.name ?? d.name, version: action.doc?.graph.workflow.version ?? d.version,
        };
        return { ...out, picks: prunedPicks(out, stored.draft) };
      });
      return { ...next, output: [...next.output, { at: action.at, workflowId: action.workflowId, name: doc.name, text: action.doc ? text : `${text} (the workflow could not be read again)` }] };
    }
    case 'saveFailed': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      if (!doc) return state;
      const next = update(state, action.workflowId, (d) => ({ ...d, saving: false }));
      return { ...next, output: [...next.output, { at: action.at, workflowId: action.workflowId, name: doc.name, text: `Not saved: ${action.message}` }] };
    }
```

- `prunedPicks`: before `const { source, target } = wireEnds(p.id);` add `if (p.id.startsWith(LOOSE_PREFIX)) return Object.hasOwn(draft.loose, p.id.slice(LOOSE_PREFIX.length));`.
- replace `designDirty` with:

```ts
/** The design as it stands: the canvas draft and the entity edits. */
export const designOf = (d: OpenDocument): Design => ({ draft: d.design.draft, edits: d.edits });

/** The design differs from the last saved one (spec §3.2): the tab is marked, closing asks, the session keeps it. */
export const designDirty = (d: OpenDocument): boolean => (d.stored === null ? d.restored : !sameDesign(designOf(d), d.stored));

/** Save is offered (spec §4.1): the design differs from the stored one, or the stored one is not applied yet. */
export const canSave = (d: OpenDocument): boolean =>
  d.status.kind === 'ready' && !d.saving && d.stored !== null && (designDirty(d) || hasGraphChanges(d.stored));
```

`src/app/session.ts`:
- imports: `parseEdits, EMPTY_EDITS, type EntityEdits` from `../design/design`; `parseDraft, type Draft` from `../design/draft`; `designDirty` and `INITIAL_STATE`, `type StudioState` from `../store/studioState`; drop `isEmptyDraft` and `hasEdits`.
- `SessionDoc`: `draft?: InspectorDraft` (now only a trail); `design?: Draft`; add `/** The unsaved entity edits (plan 8): absent when there are none. */ edits?: EntityEdits;`.
- `readSession`: the `draft` line becomes `...(isDraft(d.draft) ? { draft: { trail: d.draft.trail } } : {}),` and `...designOf(d.design)` becomes `...designParts(d.design, d.edits),`; `isDraft` becomes `return isRecord(value) && Array.isArray(value.trail) && value.trail.every(isTarget);`; replace `designOf` with:

```ts
function designParts(design: unknown, edits: unknown): { design?: Draft; edits?: EntityEdits } {
  const draft = parseDraft(design);
  const parsed = parseEdits(edits);
  return { ...(draft !== null ? { design: draft } : {}), ...(parsed !== null ? { edits: parsed } : {}) };
}
```

- `sessionOf`'s document map:

```ts
    docs: state.docs.map((d) => ({
      workflowId: d.workflowId, name: d.name, version: d.version, selection: d.selection, view: views.get(d.workflowId) ?? null,
      ...(d.inspector.trail.length > 0 ? { draft: { trail: d.inspector.trail } } : {}),
      ...(designDirty(d) ? { design: d.design.draft, edits: d.edits } : {}),
    })),
```

- `restoredState`:

```ts
export function restoredState(session: Session | null): StudioState {
  if (session === null) return INITIAL_STATE;
  return {
    docs: session.docs.map((d) => ({ workflowId: d.workflowId, name: d.name, version: d.version, status: { kind: 'loading' }, selection: d.selection,
      inspector: { ...EMPTY_INSPECTOR, trail: d.draft?.trail ?? [] },
      picks: picksOf(d.selection),
      design: historyOf(d.design),
      edits: d.edits ?? EMPTY_EDITS,
      stored: null,
      restored: d.design !== undefined || d.edits !== undefined,
      saving: false,
      errors: null,
    })),
    activeId: session.activeId,
    showDetails: session.showDetails,
    output: [],
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/store src/app/session.test.ts`
Expected: PASS. (`npx tsc -b` still reports the Inspector, its service, `App.tsx` and `DocumentPanel.tsx`, which use the removed actions: Task 12 rewrites them.)

- [ ] **Step 5: Commit together with Task 12**

No separate commit: a commit here would not type-check. Review this task's diff on its own (`git diff -- src/WorkflowStudio/src/store src/WorkflowStudio/src/app/session.ts src/WorkflowStudio/src/app/session.test.ts`), then go straight on to Task 12, whose Step 6 commits both.

---

### Task 12: The Inspector edits the design, never BaseApi

**Files:**
- Modify: `src/WorkflowStudio/src/store/entityForms.ts` (export `fieldValue`; drop `updateDto`'s callers' helpers that remain unused: `createAssignmentDto`, `newAssignmentDto`, `missingRequired`, `splitErrors`)
- Rewrite: `src/WorkflowStudio/src/app/inspectorService.ts`, `src/app/inspectorService.test.ts`
- Modify: `src/WorkflowStudio/src/panels/Inspector.tsx`, `src/panels/inspectorView.ts:39-45`
- Modify: `src/WorkflowStudio/src/app/studioActions.ts`, `src/App.tsx`, `src/app/DocumentPanel.tsx`, `src/app/CapsuleToolbar.tsx`, `src/test/inspector.tsx`
- Test: `src/panels/panes.test.tsx` (`Inspector editing`), `src/app/DocumentPanel.test.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 11's actions and `editTargetOf`; Task 10's `applyEdits`; Task 8's `fieldsOf`, `valueText`, `slotKey`, `newId`.
- Produces:
  - `entityForms.fieldValue(spec: FieldSpec, text: string): FieldValue` (the old private `toDtoValue`).
  - `InspectorService = { read(workflowId, again?), edit(workflowId, spec, text), revert(workflowId), createAssignment(workflowId, stepId, stepName), removeAssignment(workflowId, stepId) }`; `createInspectorService(api: StudioApi, store: StudioStore)`.
  - `StudioActions = { service; guard(workflowId, proceed, doc?) /* proceeds at once unless a dialog is open */; confirmDiscardDesign(workflowId, doc?) }` (`confirmRemove` removed).
  - `CapsuleToolbar` props: `{ workflow; status; save?: { enabled: boolean; saving: boolean; onSave: () => void }; design? }` (`dirty`, `busy`, `blocked`, `onSave` removed).
  - `kindLabel(target: InspectorTarget): string`.

- [ ] **Step 1: Write the failing tests**

`src/app/inspectorService.test.ts` — replace the whole file:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, processorDto, schemaDto, stepDto } from '../api/fixtures';
import { FIELDS } from '../store/entityForms';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { createInspectorService } from './inspectorService';

const ok = <T,>(value: T) => ({ ok: true, value }) as const;
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;
const spec = (kind: keyof typeof FIELDS, key: string) => FIELDS[kind].find((f) => f.key === key)!;

async function setup(getEntity = vi.fn().mockResolvedValue(ok(stepDto('s1', { name: 'fetch' })))) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto({
    steps: [stepDto('s1', { name: 'fetch', processorId: 'p1' })], processors: [processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })], schemas: [schemaDto('sc1')],
  })) });
  store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
  const writes = { putEntity: vi.fn(), createAssignment: vi.fn(), deleteAssignment: vi.fn(), saveDesign: vi.fn() };
  const api = { getEntity, ...writes } as unknown as StudioApi;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { store, api, writes, service: createInspectorService(api, store), flush, doc: () => store.getState().docs[0]! };
}

describe('InspectorService (plan 8 §3.3: reads, then design edits)', () => {
  it('reads the shown entity once, and not again while it is read', async () => {
    const { service, getEntity, flush, doc } = await setup().then((s) => ({ ...s, getEntity: s.api.getEntity as ReturnType<typeof vi.fn> }));
    service.read('wf1');
    service.read('wf1');
    await flush();
    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(doc().inspector.saved?.key).toBe('step:s1');
  });

  it('says when the shown entity no longer exists', async () => {
    const { service, flush, doc } = await setup(vi.fn().mockResolvedValue(notFound));
    service.read('wf1');
    await flush();
    expect(doc().inspector.readError).toBe('This step no longer exists.');
  });

  it('turns typed text into a design edit: an entry condition is a number, a blank nullable field is null; nothing is written', async () => {
    const { service, flush, doc, writes } = await setup();
    service.read('wf1');
    await flush();
    service.edit('wf1', spec('step', 'entryCondition'), '4');
    service.edit('wf1', spec('step', 'description'), '   ');
    expect(doc().edits.steps['s1']!.fields).toEqual({ entryCondition: 4 });
    service.edit('wf1', spec('step', 'description'), 'typed');
    expect(doc().edits.steps['s1']!.fields).toEqual({ entryCondition: 4, description: 'typed' });
    service.revert('wf1');
    expect(doc().edits.steps['s1']).toBeUndefined();
    for (const w of Object.values(writes)) expect(w).not.toHaveBeenCalled();
  });

  it('makes up the base of a created assignment and of an empty slot\'s schema, with no GET', async () => {
    const { service, store, flush, doc, api } = await setup();
    service.createAssignment('wf1', 's1', 'fetch');
    service.read('wf1');
    await flush();
    expect(doc().inspector.saved?.dto).toMatchObject({ stepId: 's1' });
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'schema', id: '', slot: 'output', processorId: 'p1' } });
    service.read('wf1');
    await flush();
    expect(doc().inspector.saved?.dto).toEqual({ id: '', name: 'fetcher-output', version: '1.0.0', description: null, definition: '{}' });
    expect(api.getEntity).toHaveBeenCalledTimes(0);
  });
});
```

`src/panels/panes.test.tsx` — delete the whole `Inspector editing (slice 3b)` describe and replace it with:

```ts
describe('Inspector editing (plan 8 §3.3: the design, never BaseApi)', () => {
  const step = stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' });
  const reads = (kind: string, id: string) => ok(
    kind === 'step' ? (id === 's1' ? step : stepDto('s2', { name: 'store', processorId: 'p1' }))
      : kind === 'processor' ? processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })
        : kind === 'schema' ? schemaDto('sc1', { name: 'cfg', version: '1.2.3', definition: '{"type":"object"}' })
          : assignmentDto(id, { stepId: 's1' }));

  it('an edit goes to the design: marked, kept when the Inspector moves away, and Revert drops it', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const { store, api } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'typed' } });
    expect(screen.getByText('● unsaved changes')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's2' } }));
    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } }));
    expect(await screen.findByLabelText('Description')).toHaveValue('typed');

    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(api.putEntity).not.toHaveBeenCalled();
  });

  it('a schema edited from its processor\'s slot becomes a copy with the same name and version (spec §1.5)', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const { store } = await renderInspector({ getEntity }, { selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    // the fixture graph carries no schema rows, so the slot shows the schema's id
    fireEvent.click(await screen.findByRole('button', { name: 'sc1' }));
    fireEvent.change(await screen.findByLabelText('Definition'), { target: { value: '{"type":"string"}' } });
    const copy = store.getState().docs[0]!.edits.schemas['p1:config']!;
    expect([copy.name, copy.version, copy.definition]).toEqual(['cfg', '1.2.3', '{"type":"string"}']);
    expect(copy.id).not.toBe('sc1');
  });

  it('an empty slot offers ＋ Define: a copy named <processor>-<slot>, 1.0.0', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const { store } = await renderInspector({ getEntity }, { selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    const output = (await screen.findAllByText('Out'))[0]!.closest('.slot')!;
    fireEvent.click(within(output as HTMLElement).getByRole('button', { name: '＋ Define' }));
    fireEvent.change(await screen.findByLabelText('Definition'), { target: { value: '{"type":"array"}' } });
    expect(store.getState().docs[0]!.edits.schemas['p1:output']).toMatchObject({ name: 'fetcher-output', version: '1.0.0', definition: '{"type":"array"}' });
  });

  it('＋ Create makes the step\'s assignment in the design and shows it; Remove takes it away; nothing is written', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const { store, api } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: '＋ Create' }));
    expect(await screen.findByText('ASSIGNMENT')).toBeInTheDocument();
    expect(await screen.findByLabelText('Name')).toHaveValue('fetch-assignment');
    fireEvent.click(screen.getByRole('button', { name: 'Remove assignment' }));
    expect(await screen.findByText('STEP')).toBeInTheDocument();
    expect(store.getState().docs[0]!.edits.assignments).toEqual({});
    expect(api.createAssignment).not.toHaveBeenCalled();
    expect(api.deleteAssignment).not.toHaveBeenCalled();
  });
});
```

(add `within` to the Testing Library import of `panes.test.tsx`). Also delete from `panes.test.tsx`'s `Inspector` describe any assertion on `confirmRemove`.

Append to `src/app/DocumentPanel.test.tsx` (inside `describe('DocumentPanel')`; import `stepDto` is there):

```tsx
  it('draws the design: a step renamed in the Inspector shows its new name on the canvas (plan 8 §3.1)', async () => {
    const { store } = await setup();
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    await screen.findByText('fetch');
    act(() => {
      store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
      store.dispatch({ type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: stepDto('s1', { name: 'fetch' }) } });
      store.dispatch({ type: 'editField', workflowId: 'wf1', key: 'name', value: 'gather', copyId: 'x' });
    });
    expect(await screen.findByText('gather')).toBeInTheDocument();
    expect(screen.getByText('● design draft')).toBeInTheDocument();
  });
```

and delete its tests `enables Save only with edits, says so, and hands a click to onSave` and `disables Save while the shown entity would be saved with a blank Name (final review 5)` (Save is the design's now: Task 13).

`src/App.test.tsx` — delete the whole `describe('unsaved Inspector edits (slice 3b)', …)` (its nested `removing an assignment` included) and, in `the design draft (plan 4)`, the test `Discard on close, then Cancel in the Inspector question: the document stays open with its design draft`; append:

```tsx
describe('the design session (plan 8 §3.2)', () => {
  const session = (doc: object) => memoryStorage({ [SESSION_KEY]: JSON.stringify({
    version: 1, activeId: ALPHA, showDetails: false, dock: null,
    docs: [{ workflowId: ALPHA, name: 'alpha', version: '1.0.0', selection: { kind: 'step', stepId: 's1' }, view: null, ...doc }],
  }) });
  const api = () => fakeApi({ getEntity: vi.fn().mockResolvedValue({ ok: true, value: stepDto('s1', { name: 'fetch' }) }) });

  it('brings unsaved entity edits back after a refresh, marked as a design draft', async () => {
    render(<App api={api()} storage={memoryStorage()} tabStorage={session({ edits: { steps: { s1: { updatedAt: null, fields: { description: 'typed' } } } } })} />);
    expect(await screen.findByLabelText('Description')).toHaveValue('typed');
    expect(screen.getByText('● design draft')).toBeInTheDocument();
    expect(document.querySelector('.doctab.dirty')).not.toBeNull();
  });

  it('typing marks the design and the tab, asks nothing and writes nothing', async () => {
    const fake = api();
    render(<App api={fake} storage={memoryStorage()} tabStorage={session({})} />);
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'typed' } });
    expect(await screen.findByText('● design draft')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fake.putEntity).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/app/inspectorService.test.ts src/panels/panes.test.tsx src/app/DocumentPanel.test.tsx src/App.test.tsx`
Expected: FAIL (the service has no `edit`; the Inspector still has Save; `editField` is not drawn).

- [ ] **Step 3: Implement the service and the form helpers**

`src/store/entityForms.ts` — rename `toDtoValue` to an exported `fieldValue`:

```ts
/** Typed text as the design keeps it (plan 8): the entry condition's number; a blank nullable field is null. */
export function fieldValue(spec: FieldSpec, text: string): FieldValue {
  if (spec.kind === 'condition') return Number(text);
  if (spec.nullable && text.trim() === '') return null;
  return text;
}
```

(import `type FieldValue` from `../design/design`); delete `updateDto`, `UPDATE_KEYS`, `missingRequired`, `splitErrors`, `newAssignmentDto`, `createAssignmentDto` and their tests in `src/store/entityForms.test.ts` (keep the `savedText`, `shownText`, `jsonProblem` tests).

`src/app/inspectorService.ts` — replace the file:

```ts
import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { EntityReadDto } from '../api/entities';
import type { AssignmentReadDto, SchemaReadDto } from '../api/types';
import { newId } from '../design/ids';
import type { Id } from '../model/graph';
import { fieldValue, type FieldSpec } from '../store/entityForms';
import { crumbLabel, targetKey, type InspectorTarget } from '../store/inspectorTarget';
import { shownTargetOf, type OpenDocument } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';

/**
 * The Inspector's reads and edits (plan 8 §3.3). Reads are GETs of the shown entity's base; every edit goes
 * to the design in the store. Nothing here writes to BaseApi: Save does (app/saveDesign.ts).
 */
export interface InspectorService {
  /** Reads the base of the entity a document's Inspector shows, unless it is read or being read; `again` reads it anew. */
  read(workflowId: Id, again?: boolean): void;
  /** One field typed into the shown entity: a design edit. */
  edit(workflowId: Id, spec: FieldSpec, text: string): void;
  /** Drops the shown entity's design edits. */
  revert(workflowId: Id): void;
  /** Creates the step's assignment in the design (`{step}-assignment`, 1.0.0, `{}`) and shows it. */
  createAssignment(workflowId: Id, stepId: Id, stepName: string): void;
  /** Removes the step's assignment in the design: no question, no other workflow checked (assignments are not shared). */
  removeAssignment(workflowId: Id, stepId: Id): void;
}

/** A base for what the database does not hold yet (spec §3.2): a created assignment, an empty slot's schema. */
function madeUp(doc: OpenDocument, target: InspectorTarget): EntityReadDto | null {
  if (target.kind === 'assignment') {
    const op = doc.edits.assignments[target.stepId];
    if (op?.op === 'create' && op.id === target.id) {
      return { id: op.id, name: '', version: '', description: null, stepId: target.stepId, payload: '' } as AssignmentReadDto;
    }
  }
  if (target.kind === 'schema' && target.id === '' && doc.status.kind === 'ready') {
    const p = doc.status.doc.graph.processors.get(target.processorId);
    return { id: '', name: `${p?.name ?? target.processorId}-${target.slot}`, version: '1.0.0', description: null, definition: '{}' } as SchemaReadDto;
  }
  return null;
}

export function createInspectorService(api: StudioApi, store: StudioStore): InspectorService {
  /** workflowId → the target key whose GET is in flight. */
  const reading = new Map<Id, string>();
  const docOf = (id: Id) => store.getState().docs.find((d) => d.workflowId === id) ?? null;

  function read(workflowId: Id, again = false): void {
    const doc = docOf(workflowId);
    const target = doc === null ? null : shownTargetOf(doc);
    if (doc === null || target === null) return;
    const key = targetKey(target);
    if (!again && (doc.inspector.saved?.key === key || reading.get(workflowId) === key)) return;
    const virtual = madeUp(doc, target);
    if (virtual !== null) {
      store.dispatch({ type: 'read', workflowId, key, result: { ok: true, dto: virtual } });
      return;
    }
    reading.set(workflowId, key);
    void api.getEntity(target.kind, target.id).then((r) => {
      if (reading.get(workflowId) === key) reading.delete(workflowId);
      store.dispatch({
        type: 'read', workflowId, key,
        result: r.ok ? { ok: true, dto: r.value }
          : { ok: false, message: r.error.kind === 'notFound' ? `This ${crumbLabel(target).toLowerCase()} no longer exists.` : `Could not read it. ${describeError(r.error)}` },
      });
    });
  }

  return {
    read,
    edit: (workflowId, spec, text) => store.dispatch({ type: 'editField', workflowId, key: spec.key, value: fieldValue(spec, text), copyId: newId() }),
    revert: (workflowId) => store.dispatch({ type: 'revertEntity', workflowId }),
    createAssignment: (workflowId, stepId, stepName) => store.dispatch({ type: 'createAssignment', workflowId, stepId, stepName, id: newId() }),
    removeAssignment: (workflowId, stepId) => store.dispatch({ type: 'removeAssignment', workflowId, stepId }),
  };
}
```

- [ ] **Step 4: Implement the Inspector**

`src/panels/inspectorView.ts` — `kindLabel` becomes:

```ts
/** The kind pill. An unwired step is an ordinary step (plan 8). */
export function kindLabel(target: InspectorTarget): string {
  return target.kind.toUpperCase();
}
```

(drop its `StudioDocument` import).

`src/panels/Inspector.tsx` — replace `EntityPane` and `EntityForm` (keep `readOnly`, `Inspector`, `wireNote`, `SLOTS`); imports become:

```tsx
import { Fragment, useEffect, useMemo } from 'react';
import type { EntityReadDto } from '../api/entities';
import type { StepReadDto } from '../api/types';
import type { StudioDocument } from '../app/document';
import { useStudioActions } from '../app/studioActions';
import { applyEdits } from '../design/apply';
import { fieldsOf, slotKey, valueText } from '../design/design';
import { wireEnds } from '../design/draft';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { assignmentByStep, payloadKeyCount } from '../model/assignments';
import { entityName } from '../model/entityNames';
import type { Graph } from '../model/graph';
import { FIELDS, savedText, type FieldSpec } from '../store/entityForms';
import { crumbLabel, editTargetOf, rootTarget, targetKey, type InspectorTarget, type SchemaSlot } from '../store/inspectorTarget';
import { activeDocument, shownTargetOf, type OpenDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { FieldEditor } from './FieldEditor';
import { detailRows, kindLabel, uniqueNameOf, type Row } from './inspectorView';
import { PaneNote } from './PaneNote';
```

In `Inspector`, replace the last return with `return <EntityPane open={active} target={target} />;` and update its doc comment's last sentence to "Edits go to the design (plan 8 §3.3); nothing here writes to BaseApi.". Then:

```tsx
function EntityPane({ open, target }: { open: OpenDocument; target: InspectorTarget }) {
  const store = useStudioStore();
  const showDetails = useStudio((s) => s.showDetails);
  const { service } = useStudioActions();
  const { workflowId, inspector } = open;
  const base = open.status.kind === 'ready' ? open.status.doc : null;
  // the Inspector shows the design: names, assignments and schema copies as edited (spec §3.1)
  const doc = useMemo(() => (base ? applyEdits(base, open.edits) : null), [base, open.edits]);
  if (doc === null || base === null) return null;
  const drill = (next: InspectorTarget) => store.dispatch({ type: 'drill', workflowId, target: next });
  const back = (depth: number) => store.dispatch({ type: 'back', workflowId, depth });
  const crumbs = [rootTarget(open.selection, workflowId)!, ...inspector.trail];
  const saved = inspector.saved?.key === targetKey(target) ? inspector.saved.dto : null;
  const fields = fieldsOf(open.edits, editTargetOf(target));
  const dirty = Object.keys(fields).length > 0;

  return (
    <div className="paneBody" data-pane="inspector">
      <div className="ph2">
        <span className="kindpill">{kindLabel(target)}</span>
        {dirty && <span className="unsaved">● unsaved changes</span>}
      </div>
      {crumbs.length > 1 && (
        <nav className="crumbs" aria-label="Drill-down">
          <button type="button" className="link" aria-label="Back" onClick={() => back(inspector.trail.length - 1)}>‹</button>
          {crumbs.map((t, i) => (i === crumbs.length - 1
            ? <span key={i} aria-current="page">{crumbLabel(t)}</span>
            : <Fragment key={i}><button type="button" className="link" onClick={() => back(i)}>{crumbLabel(t)}</button><span className="sep">›</span></Fragment>))}
        </nav>
      )}
      {saved === null ? (
        <div className="pbody">
          <div className="sec">
            <p className={inspector.readError ? 'note warn' : 'note'}>{inspector.readError ?? 'Loading…'}</p>
            {inspector.readError && <button type="button" className="btn" onClick={() => service.read(workflowId, true)}>Retry</button>}
          </div>
        </div>
      ) : (
        <>
          <div className="pbody">
            {inspector.readError && <div className="sec"><p className="note warn">{inspector.readError}</p></div>}
            {/* read-only while a Save is in flight (spec §4.1) */}
            <fieldset className="plain" disabled={open.saving}>
              <EntityForm open={open} doc={doc} base={base} target={target} saved={saved} fields={fields} showDetails={showDetails} drill={drill} />
            </fieldset>
          </div>
          <div className="savebar">
            {target.kind === 'assignment' && (
              <button type="button" className="link danger" disabled={open.saving}
                onClick={() => service.removeAssignment(workflowId, target.stepId)}>Remove assignment</button>
            )}
            <button type="button" className="btn" disabled={!dirty || open.saving} onClick={() => service.revert(workflowId)}>Revert</button>
          </div>
        </>
      )}
    </div>
  );
}

const SLOTS: ReadonlyArray<{ slot: SchemaSlot; label: string; key: 'inputSchemaId' | 'outputSchemaId' | 'configSchemaId' }> = [
  { slot: 'input', label: 'In', key: 'inputSchemaId' },
  { slot: 'output', label: 'Out', key: 'outputSchemaId' },
  { slot: 'config', label: 'Config', key: 'configSchemaId' },
];

function EntityForm({ open, doc, base, target, saved, fields, showDetails, drill }: {
  open: OpenDocument; doc: StudioDocument; base: StudioDocument; target: InspectorTarget; saved: EntityReadDto;
  fields: Readonly<Record<string, string | number | null>>; showDetails: boolean; drill: (t: InspectorTarget) => void;
}) {
  const store = useStudioStore();
  const { service } = useStudioActions();
  const { workflowId } = open;
  const shown = (key: string) => (Object.hasOwn(fields, key) ? valueText(fields[key]) : savedText(saved, key));
  // the last Save's errors on this entity, under their fields (Problems lists them all)
  const entityId = target.kind === 'workflow' ? workflowId : target.kind === 'schema' ? open.edits.schemas[slotKey(target.processorId, target.slot)]?.id ?? target.id : target.id;
  const errorsOf = (key: string) => (open.errors ?? []).filter((e) => e.id === entityId && e.field === key).map((e) => e.message);
  const editor = (spec: FieldSpec) => (
    <FieldEditor key={spec.key} spec={spec} value={shown(spec.key)} saved={savedText(saved, spec.key)} errors={errorsOf(spec.key)}
      onChange={(text) => service.edit(workflowId, spec, text)} />
  );
  const { graph } = doc;
  const name = target.kind === 'schema' && open.edits.schemas[slotKey(target.processorId, target.slot)]
    ? entityName(shown('name'), shown('version'), open.edits.schemas[slotKey(target.processorId, target.slot)]!.id)
    : uniqueNameOf(saved);

  return (
    <>
      <div className="sec">
        <div className="uname" aria-label="Unique name"><span className="ro" data-tipcut={name}>{name}</span></div>
        <div className="sec-title">{crumbLabel(target)}</div>
        {FIELDS[target.kind].slice(0, 2).map(editor)}
        <div className="metatog">
          <button type="button" className="link" onClick={() => store.dispatch({ type: 'toggleDetails' })}>
            {showDetails ? '▾ hide details' : '▸ show all'}
          </button>
        </div>
        {showDetails && <div className="meta">{detailRows(saved).map(readOnly)}</div>}
        {FIELDS[target.kind].slice(2).map(editor)}
        {target.kind === 'step' && (() => {
          const step = saved as StepReadDto;
          const p = graph.processors.get(step.processorId ?? '');
          const label = p ? entityName(p.name, p.version, p.id) : step.processorId ?? '';
          return (
            <div className="field">
              <label>Processor</label>
              <button type="button" className="drill" data-tipcut={label} onClick={() => drill({ kind: 'processor', id: step.processorId ?? '' })}>{label}</button>
            </div>
          );
        })()}
        {target.kind === 'step' && (() => {
          const assignment = assignmentByStep(graph.assignments).get(target.id);
          if (!assignment) {
            return (
              <div className="field">
                <label>Assignment</label>
                <button type="button" className="link" onClick={() => service.createAssignment(workflowId, target.id, shown('name'))}>＋ Create</button>
              </div>
            );
          }
          const keys = payloadKeyCount(assignment.payload);
          const label = keys === null ? '◆ payload' : `◆ ${keys} key${keys === 1 ? '' : 's'}`;
          return (
            <div className="field">
              <label>Assignment</label>
              <div className="fval arow">
                <button type="button" className="drill" onClick={() => drill({ kind: 'assignment', id: assignment.id, stepId: target.id })}>{label}</button>
                <button type="button" className="link danger" onClick={() => service.removeAssignment(workflowId, target.id)}>✕ Remove</button>
              </div>
            </div>
          );
        })()}
        {target.kind === 'assignment' && (() => {
          const s = graph.steps.get(target.stepId);
          return readOnly({ label: 'Step', value: s ? entityName(s.name, s.version, s.id) : target.stepId });
        })()}
      </div>
      {target.kind === 'processor' && (
        <div className="sec">
          <div className="sec-title">Schemas</div>
          {SLOTS.map(({ slot, label, key }) => {
            // the slot as designed (a copy re-points it); the drill reads the base's schema and edits it through the copy
            const designed = graph.processors.get(target.id)?.[key] ?? null;
            const original = base.graph.processors.get(target.id)?.[key] ?? null;
            const schema = designed ? graph.schemas.get(designed) : undefined;
            const text = designed ? (schema ? entityName(schema.name, schema.version, schema.id) : designed) : '∅';
            const go = () => drill({ kind: 'schema', id: original ?? '', slot, processorId: target.id });
            return (
              <div key={slot} className="slot">
                <span className="k">{label}</span>
                {designed
                  ? <button type="button" className="v drill" data-tipcut={text} onClick={go}>{text}</button>
                  : <span className="v null" data-tipcut={text}>{text}</span>}
                {designed ? <span /> : <button type="button" className="link" onClick={go}>＋ Define</button>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
```

Add to `src/panels/panels.css`: `fieldset.plain { border: 0; margin: 0; padding: 0; min-width: 0; }`.

- [ ] **Step 5: The page: no write guard, no Inspector Save, no remove dialog**

`src/app/studioActions.ts` — `StudioActions` loses `confirmRemove`; the `guard` doc becomes "Runs `proceed` now; it waits only while a dialog is open (plan 8: Inspector edits live in the design, so moving away loses nothing)."

`src/App.tsx`:
- `const service = useMemo(() => createInspectorService(api, store), [api, store]);` — delete `serviceRef`, `afterWrite` and `refresh`;
- `Prompt` keeps `design` and `closeDesign` only; delete `saveThenProceed` and the `unsaved` and `remove` dialogs;
- `actions`:

```tsx
  const actions: StudioActions = useMemo(() => ({
    service,
    // nothing is lost by moving away (plan 8): only an open question holds an action back
    guard: (_workflowId, proceed) => { if (asking.current === null) proceed(); },
    confirmDiscardDesign: (workflowId, doc = document) => {
      if (asking.current !== null) return;
      setPrompt({ kind: 'design', workflowId, doc });
    },
  }), [service, setPrompt]);
```

- `identity` and `documents` use `designDirty(d)` alone (drop `hasEdits(d.inspector) ||`); `onCloseDocument`'s `close` calls `views.current.delete(id); store.dispatch({ type: 'close', workflowId: id });` directly (no `actions.guard`); the `DocumentPanel` loses `onSave` for now (Task 13 wires Save); drop the `hasEdits` and `shownTargetOf` imports.

`src/app/CapsuleToolbar.tsx` — props become `{ workflow, status, save, design }`:

```tsx
export function CapsuleToolbar({ workflow, status, save, design }: {
  workflow: Workflow; status: LiveStatus;
  /** The design's Save (plan 8 §4.1): enabled when the design differs from the base; read-only while it runs. */
  save?: { enabled: boolean; saving: boolean; onSave: () => void };
  /** The design draft (plan 4): its mark, Undo, Redo and Discard. */
  design?: { dirty: boolean; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onDiscard: () => void };
}) {
```

with the `{dirty && …● unsaved changes…}` line deleted and the Save control:

```tsx
        {save && (save.enabled || save.saving)
          ? <button type="button" className="qb" disabled={save.saving} onClick={save.onSave} data-tip="Store the design; BaseApi applies it when it finds no errors">{save.saving ? '⤓ Saving…' : '⤓ Save'}</button>
          : <span data-tip="Nothing to save yet"><button type="button" className="qb" disabled>⤓ Save</button></span>}
```

`src/app/DocumentPanel.tsx` — drop `missingRequiredShown`, its imports (`missingRequired`, `hasEdits`, `entityKindOf`, `targetKey`, `shownTargetOf`) and `blank`; `CapsuleToolbar` gets no `dirty`/`busy`/`blocked`/`onSave`.

`src/test/inspector.tsx` — the service is `createInspectorService(full, store)`; delete `afterWrite` and `confirmRemove`; the provider value is `{ service, guard, confirmDiscardDesign }`; `full` gains `saveDesign: vi.fn()`; return `{ ...view, store, api: full, service, guard }`.

- [ ] **Step 6: Run everything, then commit Tasks 11 and 12 together**

Run: `npx tsc -b; Remove-Item tsconfig.tsbuildinfo; npx vitest run`
Expected: type check clean; all tests PASS. A remaining failure in a test that asserts the removed Inspector Save, the remove dialog or `refreshed` is a test of removed behaviour: delete it, naming it in the commit body.

```powershell
git add src/WorkflowStudio/src
git commit -m "feat(studio): the Inspector edits the design: no per-entity writes, Create/Remove assignment and schema copies are virtual; the session keeps the edits (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Save: the request, the answer, Problems and Output; read-only while saving; the close question

**Files:**
- Create: `src/WorkflowStudio/src/app/saveDesign.ts`, `src/app/saveDesign.test.ts`, `src/WorkflowStudio/src/panels/Output.tsx`
- Modify: `src/WorkflowStudio/src/panels/PaneNote.tsx` (drop `Output`), `src/panels/panels.css`, `src/App.tsx`, `src/app/DocumentPanel.tsx`, `src/app/CapsuleToolbar.tsx`
- Test: `src/app/saveDesign.test.ts`, `src/panels/panes.test.tsx` (`Output and Toolbox`), `src/app/DocumentPanel.test.tsx`, `src/App.test.tsx` (`the design draft (plan 4)`)

**Interfaces:**
- Consumes: Task 8 (`layoutOf`, `Design`), Task 9 (`saveDesign` on the client, `designErrorsFromDto`), Task 10 (`applyDesign`, `applyDraft`), Task 11 (`saving`, `saveAnswered`, `saveFailed`, `canSave`, `designOf`, `designDirty`).
- Produces:
  - `interface DesignRequest` (the body, §4.2), `buildDesignRequest(base: StudioDocument, shown: StudioDocument, design: Design): DesignRequest`
  - `saveDesign(api: StudioApi, store: StudioStore, workflowId: Id, now?: () => Date): Promise<void>`
  - `panels/Output.tsx`: `Output()`
  - `CapsuleToolbar`'s `design` prop gains `locked: boolean` (Undo, Redo and Discard disabled while saving).

- [ ] **Step 1: Write the failing tests**

`src/app/saveDesign.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { assignmentDto, cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import type { WorkflowGraphDto } from '../api/types';
import { applyDesign } from '../design/apply';
import { EMPTY_EDITS, removeAssignment, setField } from '../design/design';
import { EMPTY_DRAFT, loosen } from '../design/draft';
import { designDirty } from '../store/studioState';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { buildDesignRequest, saveDesign } from './saveDesign';

const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

describe('buildDesignRequest (plan 8 §4.2)', () => {
  it('sends only the changes: loaded stamps, wiring, a schema copy with its re-point, cache fields, assignment operations, the layout', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ updatedAt: 'w0' }),
      steps: [stepDto('s1', { nextStepIds: ['s2'], updatedAt: 't1' }), stepDto('s2', { updatedAt: 't2' })],
      processors: [processorDto('p1', { configSchemaId: 'sc1' })],
      assignments: [assignmentDto('a2', { stepId: 's2', updatedAt: 'ta' })],
      caches: [cacheDto('c1')],
    }));
    let edits = setField(EMPTY_EDITS, { kind: 'step', id: 's2' }, stepDto('s2', { updatedAt: 't2' }), 'name', 'renamed', () => 'x');
    edits = setField(edits, { kind: 'schema', processorId: 'p1', slot: 'config' }, schemaDto('sc1'), 'definition', '{"type":"string"}', () => 'copy1');
    edits = setField(edits, { kind: 'cache', id: 'c1' }, cacheDto('c1'), 'root', 'r2', () => 'x');
    edits = removeAssignment(edits, 's2', { id: 'a2', updatedAt: 'ta' });
    const draft = { ...EMPTY_DRAFT, next: { s1: [] } };

    const body = buildDesignRequest(base, applyDesign(base, draft, edits), { draft, edits });

    expect(body.workflow).toEqual({ updatedAt: 'w0', fields: {}, entryStepIds: null, cacheIds: null });
    expect(body.steps).toEqual([
      { id: 's1', updatedAt: 't1', fields: {}, nextStepIds: [] },
      { id: 's2', updatedAt: 't2', fields: { name: 'renamed' }, nextStepIds: null },
    ]);
    expect(body.processors).toEqual([{ id: 'p1', fields: {}, slots: { config: 'copy1' } }]);
    expect(body.schemas).toEqual([{ id: 'copy1', name: 'schema-sc1', version: '1.0.0', description: null, definition: '{"type":"string"}' }]);
    expect(body.caches).toEqual([{ id: 'c1', fields: { root: 'r2' } }]);
    expect(body.assignments).toEqual([{ op: 'delete', id: 'a2', stepId: 's2', updatedAt: 'ta', fields: {} }]);
    expect([...body.layout.parked].sort()).toEqual(['s1', 's2']);
  });

  it('never sends a loose wire as a next step, and keeps it in the layout (Review Focus 5)', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const draft = loosen(EMPTY_DRAFT, base, 's1->s2', 'l1', { x: 904, y: 400 });

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps).toEqual([{ id: 's1', updatedAt: expect.any(String), fields: {}, nextStepIds: [] }]);
    expect(body.workflow.entryStepIds).toBeNull();
    expect(body.layout.loose).toEqual({ l1: { source: 's1', end: { x: 904, y: 400 } } });
  });
});

describe('saveDesign (plan 8 §4.1)', () => {
  const NOW = () => new Date('2026-10-07T12:00:00Z');
  async function storeWithChange() {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto()) });
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } });
    return store;
  }
  const apiWith = (answer: unknown, after: WorkflowGraphDto = graphDto()) => ({
    saveDesign: vi.fn().mockResolvedValue(answer),
    getGraph: vi.fn().mockResolvedValue({ ok: true, value: after }),
    getStep: vi.fn().mockResolvedValue(notFound), getProcessor: vi.fn().mockResolvedValue(notFound), getSchema: vi.fn().mockResolvedValue(notFound),
  }) as unknown as StudioApi;

  it('applied: the workflow is read again with GETs, no errors, Output says "Saved and applied"', async () => {
    const store = await storeWithChange();
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } });

    await saveDesign(api, store, 'wf1', NOW);

    expect(api.saveDesign).toHaveBeenCalledTimes(1);
    expect(api.getGraph).toHaveBeenCalledWith('wf1');
    const d = store.getState().docs[0]!;
    expect([d.saving, d.errors, designDirty(d)]).toEqual([false, null, false]);
    expect(store.getState().output).toEqual([{ at: '2026-10-07T12:00:00.000Z', workflowId: 'wf1', name: 'orders', text: 'Saved and applied' }]);
  });

  it('not applied: the stored design stays on the canvas; Problems gets each error, Output the count', async () => {
    const store = await storeWithChange();
    const errors = [{ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' }];
    const api = apiWith({ ok: true, value: { applied: false, errors } }, graphDto({ design: { steps: [{ id: 's1', fields: { version: 'abc' } }] } } as never));

    await saveDesign(api, store, 'wf1', NOW);

    const d = store.getState().docs[0]!;
    expect(d.errors).toEqual(errors);
    expect(d.edits.steps['s1']!.fields).toEqual({ version: 'abc' });
    expect(designDirty(d)).toBe(false);
    expect(store.getState().output.at(-1)!.text).toBe('Saved; not applied: 1 error');
  });

  it('a request that never got an answer stores nothing: Output says why, the edits stay, nothing is read', async () => {
    const store = await storeWithChange();
    const api = apiWith({ ok: false, error: { kind: 'network', message: 'down' } });

    await saveDesign(api, store, 'wf1', NOW);

    const d = store.getState().docs[0]!;
    expect(api.getGraph).not.toHaveBeenCalled();
    expect([d.saving, designDirty(d)]).toEqual([false, true]);
    expect(store.getState().output.at(-1)!.text).toBe('Not saved: Network error: down');
  });

  it('sends nothing when there is nothing to save', async () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto()) });
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } });

    await saveDesign(api, store, 'wf1', NOW);

    expect(api.saveDesign).not.toHaveBeenCalled();
  });
});
```

`src/panels/panes.test.tsx` — `Output and Toolbox` becomes (import `Output` from `./Output`, `Toolbox` stays from `./PaneNote`):

```tsx
describe('Output and Toolbox', () => {
  it('Output says nothing happened yet, then logs each Save answer with its workflow (plan 8 §4.1)', async () => {
    const store = await storeWith();
    const { unmount } = wrap(store, <Output />);
    expect(screen.getByText('Nothing yet. Each Save says here what happened.')).toBeInTheDocument();
    unmount();
    act(() => store.dispatch({ type: 'saveFailed', workflowId: 'wf1', at: '2026-10-07T12:00:00Z', message: 'Network error: down' }));
    wrap(store, <Output />);
    expect(screen.getByRole('log', { name: 'Output' })).toHaveTextContent('orders Not saved: Network error: down');
  });

  it('Toolbox is a real pane with one line', () => {
    render(<Toolbox />);
    expect(screen.getByText('The toolbox arrives in a later version.')).toBeInTheDocument();
  });
});
```

Append to `src/app/DocumentPanel.test.tsx` (`describe('DocumentPanel')`; import `EMPTY_DRAFT` from `../design/draft`):

```tsx
  it('offers Save once the design differs from the base, and is read-only while it runs (plan 8 §4.1)', async () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] })) });
    const api = { listLive: vi.fn().mockResolvedValue({ ok: true, value: [] }), listLiveness: vi.fn().mockResolvedValue({ ok: true, value: [] }) } as unknown as StudioApi;
    const onSave = vi.fn();
    render(<StudioStoreProvider value={store}><div style={{ width: 1200, height: 800 }}>
      <DocumentPanel api={api} workflowId="wf1" panel={fakePanel().panel} onSave={onSave} />
    </div></StudioStoreProvider>);

    expect(await screen.findByRole('button', { name: '⤓ Save' })).toBeDisabled();
    act(() => store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } }));
    fireEvent.click(screen.getByRole('button', { name: '⤓ Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.studio-canvas')!.getAttribute('tabindex')).toBe('0');

    act(() => store.dispatch({ type: 'saving', workflowId: 'wf1' }));
    expect(screen.getByRole('button', { name: '⤓ Saving…' })).toBeDisabled();
    // read-only: the canvas is not in design mode while the answer is awaited
    expect(document.querySelector('.studio-canvas')!.getAttribute('tabindex')).toBeNull();
    await screen.findByText('■ stopped');
  });
```

`src/App.test.tsx` — in `the design draft (plan 4)` the close dialog is now `Save design changes?`: change both `findByRole('alertdialog', { name: 'Discard design changes?' })` to `{ name: 'Save design changes?' }`; give that describe's `api()` a `saveDesign: vi.fn().mockResolvedValue({ ok: true, value: { applied: true, errors: [] } })`; and append there:

```tsx
  it('closing and choosing Save stores the design, then closes the document', async () => {
    const fake = api();
    render(<App api={fake} storage={memoryStorage()} tabStorage={designSession()} />);
    expect(await screen.findByText('● design draft')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close alpha' }));
    const box = await screen.findByRole('alertdialog', { name: 'Save design changes?' });
    fireEvent.click(within(box).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryAllByText('alpha', { selector: '.doctab .nm' })).toHaveLength(0));
    expect(fake.saveDesign).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/app/saveDesign.test.ts src/panels/panes.test.tsx src/app/DocumentPanel.test.tsx src/App.test.tsx`
Expected: FAIL (`./saveDesign` missing; `./Output` missing; Save never enabled; dialog name).

- [ ] **Step 3: Implement**

`src/app/saveDesign.ts`:

```ts
import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import { designErrorsFromDto } from '../api/toModel';
import type { DesignSaveRequest } from '../api/types';
import { applyDesign } from '../design/apply';
import type { Design, FieldValue, SchemaCopy } from '../design/design';
import { layoutOf, type SavedLayout } from '../design/layoutDesign';
import type { Id } from '../model/graph';
import type { SchemaSlot } from '../store/inspectorTarget';
import { canSave, designOf } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';
import type { StudioDocument } from './document';
import { loadDocument } from './loadDocument';

type Fields = Record<string, FieldValue>;

/** The body of `PUT /workflows/{id}/design` (plan 8 §4.2) as the studio builds it: every change, nothing else. */
export interface DesignRequest {
  workflow: { updatedAt: string | null; fields: Fields; entryStepIds: Id[] | null; cacheIds: Id[] | null };
  steps: { id: Id; updatedAt: string | null; fields: Fields; nextStepIds: Id[] | null }[];
  processors: { id: Id; fields: Fields; slots: Partial<Record<SchemaSlot, Id>> }[];
  caches: { id: Id; fields: Fields }[];
  schemas: SchemaCopy[];
  assignments: { op: 'create' | 'update' | 'delete'; id: Id; stepId: Id; updatedAt: string | null; fields: Fields }[];
  layout: SavedLayout;
}

/**
 * The design's changes relative to the base (spec §4.2). The workflow always carries its stamp (the
 * workflow stage needs it when assignment links change); a step carries the stamp the design kept, else
 * the base's. Loose wires live only in the layout: they are never a next step (spec §6.4). Entities the
 * base no longer has are left out.
 */
export function buildDesignRequest(base: StudioDocument, shown: StudioDocument, { draft, edits }: Design): DesignRequest {
  const g = base.graph;
  const has = (id: Id) => g.steps.has(id);
  const stepIds = [...new Set([...Object.keys(edits.steps), ...Object.keys(draft.next)])].filter(has).sort();

  const slots = new Map<Id, Partial<Record<SchemaSlot, Id>>>();
  const schemas: SchemaCopy[] = [];
  for (const [key, c] of Object.entries(edits.schemas)) {
    const at = key.lastIndexOf(':');
    const pid = key.slice(0, at), slot = key.slice(at + 1) as SchemaSlot;
    if (!g.processors.has(pid)) continue;
    slots.set(pid, { ...slots.get(pid), [slot]: c.id });
    schemas.push({ ...c });
  }
  const processorIds = [...new Set([...Object.keys(edits.processors), ...slots.keys()])].filter((id) => g.processors.has(id)).sort();

  return {
    workflow: {
      updatedAt: edits.workflow?.updatedAt ?? g.workflow.updatedAt, fields: { ...edits.workflow?.fields },
      entryStepIds: draft.entries === null ? null : draft.entries.filter(has), cacheIds: null,
    },
    steps: stepIds.map((id) => ({
      id, updatedAt: edits.steps[id]?.updatedAt ?? g.steps.get(id)!.updatedAt, fields: { ...edits.steps[id]?.fields },
      nextStepIds: Object.hasOwn(draft.next, id) ? draft.next[id]!.filter(has) : null,
    })),
    processors: processorIds.map((id) => ({ id, fields: { ...edits.processors[id]?.fields }, slots: slots.get(id) ?? {} })),
    caches: Object.entries(edits.caches).filter(([id]) => g.caches.has(id)).map(([id, e]) => ({ id, fields: { ...e.fields } })),
    schemas,
    assignments: Object.entries(edits.assignments).filter(([stepId]) => has(stepId)).map(([stepId, op]) => ({
      op: op.op, id: op.id, stepId, updatedAt: op.op === 'create' ? null : op.updatedAt, fields: op.op === 'delete' ? {} : { ...op.fields },
    })),
    layout: layoutOf(shown, draft),
  };
}

/**
 * Save (spec §4.1): the design's changes in one request, the design read-only until the answer. Either way
 * the design is then stored on the workflow: the document is read again with GETs (the stored design comes
 * back with it), its errors go to Problems and a line to Output. A request that got no answer stored
 * nothing: Output says why and the edits stay.
 */
export async function saveDesign(api: StudioApi, store: StudioStore, workflowId: Id, now: () => Date = () => new Date()): Promise<void> {
  const open = store.getState().docs.find((d) => d.workflowId === workflowId);
  if (!open || open.status.kind !== 'ready' || !canSave(open)) return;
  const base = open.status.doc;
  const design = designOf(open);
  const body = buildDesignRequest(base, applyDesign(base, design.draft, design.edits), design);
  store.dispatch({ type: 'saving', workflowId });
  const answer = await api.saveDesign(workflowId, body as unknown as DesignSaveRequest);
  if (!answer.ok) {
    store.dispatch({ type: 'saveFailed', workflowId, at: now().toISOString(), message: describeError(answer.error) });
    return;
  }
  const reread = await loadDocument(api, workflowId);
  store.dispatch({
    type: 'saveAnswered', workflowId, at: now().toISOString(), applied: answer.value.applied === true,
    errors: designErrorsFromDto(answer.value), doc: reread.ok ? reread.value : null,
  });
}
```

`src/panels/Output.tsx`:

```tsx
import { useStudio } from '../store/studioStore';
import { PaneNote } from './PaneNote';

const timeOf = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};

/** Output (plan 8 §4.1): one line per Save answer, with its time and workflow, oldest first. */
export function Output() {
  const lines = useStudio((s) => s.output);
  if (lines.length === 0) return <PaneNote pane="output">Nothing yet. Each Save says here what happened.</PaneNote>;
  return (
    <div className="paneBody" data-pane="output">
      <div className="pbody" role="log" aria-label="Output">
        {lines.map((l, i) => (
          <div key={i} className="outl"><span className="t">{timeOf(l.at)}</span> <b>{l.name}</b> {l.text}</div>
        ))}
      </div>
    </div>
  );
}
```

`src/panels/PaneNote.tsx` — delete the `Output` function and its doc comment. `src/panels/panels.css` — add `.outl { padding: 2px 10px; font-family: var(--mono); font-size: 12px; } .outl .t { color: var(--muted); }`.

`src/app/CapsuleToolbar.tsx` — the `design` prop gains `locked: boolean` ("a Save is in flight"); Undo is `disabled={design.locked || !design.canUndo}`, Redo `disabled={design.locked || !design.canRedo}`, Discard design `disabled={design.locked || !design.dirty}`.

`src/app/DocumentPanel.tsx` — import `applyDraft` (with `applyEdits`) from `../design/apply` and `canSave` from `../store/studioState`; after `edited`:

```ts
  // while a Save runs the design is read-only (spec §4.1): the canvas draws it whole, with no design mode
  const frozen = useMemo(() => (edited && open?.saving ? applyDraft(edited, open.design.draft) : null), [edited, open?.saving, open?.design.draft]);
```

the canvas takes `doc={frozen ?? edited ?? open.status.doc}` and `design={open.saving ? undefined : { …as before… }}`; the toolbar:

```tsx
        <CapsuleToolbar workflow={open.status.doc.graph.workflow} status={status}
          save={onSave ? { enabled: canSave(open), saving: open.saving, onSave } : undefined}
          design={actions ? {
            dirty: designDirty(open), locked: open.saving, canUndo: canUndo(open.design), canRedo: canRedo(open.design),
            onUndo: () => store.dispatch({ type: 'undo', workflowId }),
            onRedo: () => store.dispatch({ type: 'redo', workflowId }),
            onDiscard: () => actions.confirmDiscardDesign(workflowId, ownerDocument),
          } : undefined} />
```

(the `onSave` prop doc becomes "Saves the design (plan 8 §4.1)").

`src/App.tsx` — import `saveDesign` from `./app/saveDesign` and `Output` from `./panels/Output` (the `PaneNote` import keeps `Toolbox`); `renderDocument`'s `DocumentPanel` gets `onSave={() => void saveDesign(api, store, id)}`; the `closeDesign` dialog becomes:

```tsx
      {prompt?.kind === 'closeDesign' && (
        <ConfirmDialog doc={prompt.doc} title="Save design changes?" onCancel={() => setPrompt(null)}
          message="This workflow has design changes that are not saved. Save stores them on the workflow (BaseApi applies them when it finds no errors); Discard drops them."
          buttons={[
            { label: 'Discard', onClick: () => { setPrompt(null); prompt.proceed(); } },
            {
              label: 'Save', primary: true,
              onClick: () => {
                setPrompt(null);
                // closed once the design is stored; a Save that got no answer keeps the document open with its edits
                void saveDesign(api, store, prompt.workflowId).then(() => {
                  const still = store.getState().docs.find((d) => d.workflowId === prompt.workflowId);
                  if (still && !designDirty(still)) prompt.proceed();
                });
              },
            },
          ]} />
      )}
```

and the Discard design dialog's message becomes "Every unsaved design change in this workflow is dropped; the canvas shows the last saved design again."

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsc -b; Remove-Item tsconfig.tsbuildinfo; npx vitest run`
Expected: type check clean; all tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/WorkflowStudio/src
git commit -m "feat(studio): Save sends the design, reads it back, and fills Problems and Output; read-only while saving; closing asks Save/Discard/Cancel (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Wires dropped anywhere: cycles allowed, loose wires drawn and re-attached, the legend

**Files:**
- Modify: `src/WorkflowStudio/src/design/rules.ts`, `src/design/useWireGestures.ts`, `src/design/DesignContext.ts`, `src/design/DesignOverlay.tsx:79`, `src/design/useDesignKeys.ts:79-84`
- Modify: `src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx:127,137,172-178`, `src/canvas/selection.ts:97-101`, `src/canvas/toFlow.ts`, `src/canvas/edges/CableEdge.tsx`, `src/canvas/Legend.tsx`, `src/canvas/nodes/StepNode.tsx`, `src/canvas/art.css`, `src/canvas/canvas.css`
- Modify: `src/WorkflowStudio/src/panels/Inspector.tsx` (`wireNote`)
- Test: `src/design/rules.test.ts`, `src/design/useWireGestures.test.tsx`, `src/canvas/edges/CableEdge.test.tsx`, `src/canvas/toFlow.test.ts`, `src/canvas/Legend.test.tsx`, `src/canvas/nodes/StepNode.test.tsx`

**Interfaces:**
- Consumes: Task 8 (`addLoose`, `moveLoose`, `removeLoose`, `attachLoose`, `loosen`, `LOOSE_PREFIX`, `newId`), Task 10 (`StudioDocument.loose`).
- Produces:
  - `rules.ts`: `type DropVerdict = 'ok' | 'self' | 'loose' | 'cannotStart'`; `type JoinVerdict = 'ok' | 'sameWire' | 'loose'`; `type Refusal = 'start'`; `canWire` with no cycle check; labels `loose` → "loose wire", `cannotStart` → "cannot start here".
  - `DropHint`: `{ id: string | null; line; tone: 'ok' | 'loose' | 'no'; why; newWire; at }` (`ok` removed).
  - `DesignGestures.looseEndPointerDown(looseId: string, e: ReactPointerEvent): void`.
  - `CableEdgeData.loose?: boolean`, `halo?: 'ok' | 'no' | 'loose'`; `LOOSE_COLOUR = '#8A97A8'`; loose edges `loose:{id}`, an open circle `circle.nx-open` and its press target `circle.nx-open-hit`.
  - The hub node gains a target handle `loose`; step nodes lose `parked`.

- [ ] **Step 1: Write the failing tests**

`src/design/rules.test.ts` — the behaviour of the existing `canWire` and `canJoin` tests changes (spec §5): rewrite each expectation by this table, and delete any test whose only point was a refusal that no longer exists:

| old verdict / label | new verdict / label |
|---|---|
| `'cycle'` / "would make a loop" (a wire) | `'ok'` / "re-attach here" or "connect here" |
| `'duplicate'` / "already wired" | `'loose'` / "loose wire" |
| `'notStep'` / "not a step" | `'loose'` / "loose wire" |
| `'colour'` / "other colour", `'loop'` / "would make a loop" (a join) | `'loose'` / "loose wire" |
| `'needStep'` / "drop on a step" | gone (lines are not drop targets for a new wire or an arrow) |

and append:

```ts
describe('wires dropped anywhere (plan 8 §5)', () => {
  it('allows a cycle, still refuses a step wired to itself, and makes the rest loose', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')] }));
    expect(canWire(doc, 's3', 's1')).toBe('ok');
    expect(canWire(doc, 's2', 's2')).toBe('self');
    expect(canWire(doc, 's1', 's2')).toBe('loose');
    expect(canWire(doc, 's1', 'cache:c1')).toBe('loose');
    expect(canWire(doc, 's1', 'wf')).toBe('loose');
    expect(dropLabel('loose', false)).toBe('loose wire');
    expect(dropLabel('cannotStart', false)).toBe('cannot start here');
  });
});
```

Append to `src/design/useWireGestures.test.tsx` (inside `describe('wire gestures', …)`; add `addLoose`, `EMPTY_DRAFT` to the `./draft` import and `stepDto`, `graphDto` to the fixtures import if missing):

```tsx
  const twoAndOne = () => loadedDocument(
    graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')], layout: { parked: ['s3'] } }),
    [stepDto('s3')],
  );
  const EMPTY_AT = { x: 1104, y: 704 };
  const commits = (design: ReturnType<typeof designOf>) => vi.mocked(design.onCommit).mock.calls;

  it('a new wire released on empty canvas becomes a loose wire from its source, told "loose wire" in grey (plan 8 §5)', async () => {
    const doc = await twoAndOne();
    const design = designOf();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.react-flow__node[data-id="s2"] .nx-port')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const label = container.querySelector('.design-drop-label')!;
    expect(label.textContent).toBe('loose wire');
    expect(label.getAttribute('class')).toContain('loose');
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const [draft, options] = commits(design)[0]!;
    const [id, loose] = Object.entries(draft.loose)[0]!;
    expect(loose).toEqual({ source: 's2', end: EMPTY_AT });
    expect(draft.next).toEqual({});
    expect(options).toEqual({ picks: [{ kind: 'wire', id: `loose:${id}` }] });
  });

  it('a picked wire\'s head released on empty canvas leaves the wiring and stays drawn as a loose wire', async () => {
    const doc = await twoAndOne();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s1->s2"] .design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const [draft] = commits(design)[0]!;
    expect(draft.next['s1']).toEqual([]);
    expect(Object.values(draft.loose)).toEqual([{ source: 's1', end: EMPTY_AT }]);
  });

  it('a head dropped where it closes a loop re-attaches the wire: cycles are allowed (plan 8 §5)', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s2->s3"] .design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('re-attach here');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(commits(design)[0]![0].next['s2']).toEqual(['s1']);
  });

  it('a tail released on empty canvas snaps back: a loose wire always keeps its source', async () => {
    const doc = await twoAndOne();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s1->s2"] .design-handle.end[data-end="source"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')).toBeNull();
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a loose wire\'s open end: onto a step it wires, elsewhere it moves, on its own source it snaps back', async () => {
    const doc = await twoAndOne();
    const design = designOf({ draft: addLoose(EMPTY_DRAFT, 'l1', 's1', EMPTY_AT) });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const openEnd = () => container.querySelector('[data-testid="rf__edge-loose:l1"] .nx-open-hit')!;
    const drag = (to: { x: number; y: number }) => {
      fireEvent.pointerDown(openEnd(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
      fireEvent.pointerMove(document, { ...screenOf(container, to), pointerId: 1 });
      const label = container.querySelector('.design-drop-label')?.textContent ?? null;
      fireEvent.pointerUp(document, { ...screenOf(container, to), pointerId: 1 });
      return label;
    };
    expect(drag(middleOf(doc, 's3'))).toBe('connect here');
    expect(commits(design)[0]![0].next['s1']).toEqual(['s2', 's3']);
    expect(commits(design)[0]![0].loose).toEqual({});

    expect(drag({ x: 1200, y: 760 })).toBe('loose wire');
    expect(commits(design)[1]![0].loose['l1']).toEqual({ source: 's1', end: { x: 1200, y: 760 } });

    expect(drag(middleOf(doc, 's1'))).toBe('same step');
    expect(commits(design)).toHaveLength(2);
  });

  it('Delete removes a picked loose wire', async () => {
    const doc = await twoAndOne();
    const design = designOf({ draft: addLoose(EMPTY_DRAFT, 'l1', 's1', EMPTY_AT), picks: [{ kind: 'wire', id: 'loose:l1' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.keyDown(container.querySelector('.studio-canvas')!, { key: 'Delete' });
    expect(commits(design)[0]![0].loose).toEqual({});
  });
```

Existing tests in this file that assert a removed refusal (labels "would make a loop", "other colour", "already wired", "not a step", "drop on a step", a red outline on a cache, or "snaps back" on empty canvas for a head or a new wire) are rewritten by the table above: the label becomes "loose wire", the outline/halo class `drop-loose`/`halo-loose`, and the release commits a draft with one loose wire instead of nothing.

`src/canvas/edges/CableEdge.test.tsx` — append (import `LOOSE_COLOUR` with `CableEdgeView`):

```tsx
  it('draws a loose wire grey and dashed, a ring at its source and an open circle at its end, with no arrow head or pulse (plan 8 §5)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 0], [40, 0], [40, 30]]} colour={LOOSE_COLOUR} broken={false} delay={0} loose flowing /></svg>);
    const g = container.querySelector('g.wire.loose')!;
    expect(g.querySelector('circle.nx-src')).not.toBeNull();
    expect([g.querySelector('circle.nx-open')!.getAttribute('cx'), g.querySelector('circle.nx-open')!.getAttribute('cy')]).toEqual(['40', '30']);
    expect(g.querySelector('.nx-head')).toBeNull();
    expect(g.querySelector('.nx-pulse')).toBeNull();
  });
```

`src/canvas/toFlow.test.ts` — replace `labels a parked step PARKED` with the two tests below, and remove the parked part of `gives each step a tooltip: unique name, entry condition, assignment, and parked when it is` (its title becomes `… entry condition and assignment`):

```ts
  it('draws an unwired step like every other step (plan 8: no parked look)', () => {
    const { nodes } = toFlow(doc({ steps: new Map([['a', step('a')], ['b', step('b')], ['p', step('p')]]) }, ['p']), fitter);
    const p = nodes.find((n) => n.id === 'p')!;
    expect('parked' in (p.data as object)).toBe(false);
    expect((p.data as { tip: string }).tip).not.toContain('parked');
  });

  it('draws each loose wire as a loose cable edge on its source node; the hub can hold one (plan 8 §5)', () => {
    const d: StudioDocument = { ...doc(), loose: [{ id: 'l1', source: 'a', points: [[512, 128], [704, 400]] }, { id: 'l2', source: 'wf', points: [[224, 128], [304, 304]] }] };
    const { nodes, edges } = toFlow(d, fitter);
    const l1 = edges.find((e) => e.id === 'loose:l1')!;
    expect([l1.source, l1.target, l1.targetHandle]).toEqual(['a', 'a', 'in']);
    expect(l1.data).toMatchObject({ loose: true, points: [[512, 128], [704, 400]] });
    const l2 = edges.find((e) => e.id === 'loose:l2')!;
    expect([l2.source, l2.target, l2.targetHandle]).toEqual(['wf', 'wf', 'loose']);
    expect(nodes.find((n) => n.id === 'wf')!.handles!.some((h) => h.id === 'loose' && h.type === 'target')).toBe(true);
  });
```

(`fitter` is the text fitter this file already builds for its other tests; `step` is its step builder.)

`src/canvas/Legend.test.tsx` — the second test becomes:

```tsx
  it('shows broken as grey dashes around the amber warning, and a loose wire as a grey dashed line with an open end; no parked', () => {
    const { getByText, queryByText } = render(<Legend />);
    const broken = getByText('broken').closest('.lg-item')!;
    expect(broken.querySelector('.lg-dash')).not.toBeNull();
    expect(broken.querySelector('.lg-warn')!.textContent).toBe('⚠');
    const loose = getByText('loose wire').closest('.lg-item')!;
    expect(loose.querySelector('.lg-loose')).not.toBeNull();
    expect(loose.querySelector('.lg-open')).not.toBeNull();
    expect(queryByText('parked')).toBeNull();
  });
```

`src/canvas/nodes/StepNode.test.tsx` — delete `marks a parked step with the PARKED label and the parked class` and the `parked: false` key of its data builder.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/design src/canvas`
Expected: FAIL (a cycle is refused; no loose wire is made; no `loose` edge; the legend still shows parked).

- [ ] **Step 3: Implement the rules**

`src/design/rules.ts` — types and `canWire` become:

```ts
/** `loose`: the drop attaches to nothing and the wire becomes loose there (plan 8 §5); `cannotStart`: a tail over such a place (it snaps back). */
export type DropVerdict = 'ok' | 'self' | 'loose' | 'cannotStart';
export type JoinVerdict = 'ok' | 'sameWire' | 'loose';
/** A wire's start never joins a line. */
export type Refusal = 'start';

/**
 * May a wire from `source` to `target` exist in the shown document (plan 8 §5)? `moving` is the wire whose
 * end is dragged: it is judged as if gone. A step wired to itself is refused (`self`, it snaps back); a
 * target that is not a step (a cache, the hub) or a wire that already exists makes the wire loose. Cycles
 * are allowed: a design may be anything, and starting is when cycles are judged.
 */
export function canWire(shown: StudioDocument, source: SourceId, target: string, moving?: string): DropVerdict {
  const { graph } = shown;
  if (target === WORKFLOW_SOURCE || !graph.steps.has(target)) return 'loose';
  if (source !== WORKFLOW_SOURCE && !graph.steps.has(source)) return 'loose';
  if (source === target) return 'self';
  const list = source === WORKFLOW_SOURCE ? graph.workflow.entryStepIds : graph.steps.get(source)?.nextStepIds ?? [];
  if (list.some((t) => t === target && `${source}->${t}` !== moving)) return 'loose';
  return 'ok';
}
```

`canJoin`: `if (wire === host) return 'sameWire';` stays; the other refusals return `'loose'` (`if (!w || !h || w.condition !== h.condition) return 'loose';` and `if (x.joint.host === wire) return 'loose';`). `dropLabel`:

```ts
export function dropLabel(verdict: DropVerdict | 'move' | 'here' | JoinVerdict | Refusal, newWire: boolean, line = false): string {
  switch (verdict) {
    case 'ok': return line ? 'join here' : newWire ? 'connect here' : 're-attach here';
    case 'move': return 'move contact here';
    case 'here': return 'starts here';
    case 'self': return 'same step';
    case 'sameWire': return 'same wire';
    case 'loose': return 'loose wire';
    case 'cannotStart': return 'cannot start here';
    case 'start': return 'start stays on a block';
  }
}
```

- [ ] **Step 4: Implement the gestures**

`src/design/DesignContext.ts` — `DesignGestures` gains:

```ts
  /** A press on a loose wire's open end (plan 8 §5): drags it onto a step, or elsewhere. */
  looseEndPointerDown(looseId: string, e: ReactPointerEvent): void;
```

`src/design/useWireGestures.ts`:
- imports: `addLoose, attachLoose, LOOSE_PREFIX, loosen, moveLoose` with the other `./draft` imports; `newId` from `./ids`; `canJoin, canWire, type DropVerdict, type JoinVerdict, type Refusal` stay.
- `DropHint` becomes:

```ts
export interface DropHint {
  /** The block (node id) or, when `line`, the wire under the pointer; null over empty canvas. */
  id: string | null;
  /** Over a wire's line, not a block (plan 7). */
  line: boolean;
  /** green: the drop attaches; grey: the wire becomes loose there (plan 8 §5); red: it snaps back. */
  tone: 'ok' | 'loose' | 'no';
  /** 'move': a wire end back on its own step slides its contact point there; 'here': a tail back on its own step stays. */
  why: DropVerdict | 'move' | 'here' | JoinVerdict | Refusal;
  /** A new wire, not a re-attached end: an allowed drop says "connect here". */
  newWire: boolean;
  /** The pointer, in flow coordinates. */
  at: Point;
}
```

- `dropGesture` — replace it whole:

```ts
  /**
   * Drags a wire end, drawn as `path` to the pointer (plan 8 §5). Over a block `verdict` decides: green when the
   * drop attaches, grey "loose wire" when it would make the wire loose (only when `loose` is given), red when it
   * snaps back; `current` (the end's own block) is green with the `selfWhy` label and runs `onSelf`. With no
   * block, a wire's line within the drop reach is judged by `line` (absent: lines are no drop target), and empty
   * canvas makes the wire loose. On release: `done`, `line.done`, `onSelf`, `loose`, or nothing (it snaps back).
   */
  const dropGesture = (e: ReactPointerEvent, o: {
    wire: string | null; path: (p: Point, over: string | null) => Pt[]; current: string | null; verdict: (over: string) => DropVerdict;
    done: (over: string, p: Point) => void;
    /** Dropped back on `current`; required whenever `current` is set. */
    onSelf?: (p: Point) => void;
    /** The label over `current`: 'move' (a head slides its contact) or 'here' (a tail stays where it starts). */
    selfWhy?: 'move' | 'here';
    /** What a wire's line under the pointer does: joins (`LineDrop`) or refuses (a start); absent, lines are not drop targets. */
    line?: LineDrop | Refusal;
    /** Released where it attaches to nothing: the wire becomes loose there (plan 8 §5); absent, it snaps back. */
    loose?: (p: Point) => void;
    /** A joined wire's arrow: the ghost is its branch (plan 7 §6.2). */
    part?: 'branch';
  }) => {
    let over: string | null = null;
    let onLine: { id: string; at: number } | null = null;
    let at: Point = { x: 0, y: 0 };
    const newWire = o.wire === null;
    // the drawn end snaps to the very block the drop is judged over: one hit test (plan 7 §6.1a)
    const ghost = (p: Point) => setGhost({ wire: o.wire, part: o.part, points: o.path({ x: snap(p.x), y: snap(p.y) }, over) });
    const hintFor = (id: string | null, line: boolean, why: DropHint['why'], p: Point): DropHint | null => {
      if (why === 'ok' || why === 'move' || why === 'here') return { id, line, tone: 'ok', why, newWire, at: p };
      if (why === 'loose') return o.loose ? { id, line, tone: 'loose', why, newWire, at: p } : id === null ? null : { id, line, tone: 'no', why, newWire, at: p };
      return id === null ? null : { id, line, tone: 'no', why, newWire, at: p };
    };
    run(e, (p) => {
      at = p;
      // a block counts from the drop reach outside its border, like a line (plan 7 §6.1a)
      over = blockAt(shown.current, p, DROP_REACH / getZoom());
      // a block wins over a line; the dragged wire itself is never the drop target
      onLine = over === null && o.line !== undefined ? wireAt(shown.current, p, DROP_REACH / getZoom(), o.wire) : null;
      if (onLine && typeof o.line === 'object') {
        const why = o.line.verdict(onLine.id);
        setHint(hintFor(onLine.id, true, why, p));
        // an allowed line: the wire is drawn joined there (the preview) instead of the ghost
        if (why === 'ok') { setGhost(null); setPreview(o.line.preview(onLine.id, onLine.at)); return; }
      } else if (onLine) setHint(hintFor(onLine.id, true, o.line as Refusal, p));
      else if (over === null) setHint(hintFor(null, false, 'loose', p));
      else if (over === o.current) setHint(hintFor(over, false, o.selfWhy ?? 'move', p));
      else setHint(hintFor(over, false, o.verdict(over), p));
      setPreview(null);
      ghost(p);
    }, (cancelled) => {
      setGhost(null);
      setHint(null);
      setPreview(null);
      if (cancelled) return;
      const end = { x: snap(at.x), y: snap(at.y) };
      if (onLine && typeof o.line === 'object') {
        const why = o.line.verdict(onLine.id);
        if (why === 'ok') o.line.done(onLine.id, onLine.at);
        else if (why === 'loose') o.loose?.(end);
        return;
      }
      if (onLine) return; // a start over a line snaps back
      if (over === null) { o.loose?.(end); return; }
      if (over === o.current) { o.onSelf?.(at); return; }
      const why = o.verdict(over);
      if (why === 'ok') o.done(over, at);
      else if (why === 'loose') o.loose?.(end);
    });
  };
```

- `startEnd`: the `verdict` becomes `(over) => (end === 'target' ? canWire(shown.current, wire.source, over, wire.id) : startOnly(canWire(shown.current, over, wire.target, wire.id)))` with, above it, `const startOnly = (v: DropVerdict): DropVerdict => (v === 'loose' ? 'cannotStart' : v);` (a loose wire keeps its source, so a tail never makes one); add, after `selfWhy`:

```ts
      // a head released where it attaches to nothing: the wire leaves the wiring, loose from its source (plan 8 §5)
      loose: end === 'target' ? (p) => {
        const id = newId();
        d.onCommit(loosen(base, saved, wire.id, id, p), { picks: [{ kind: 'wire', id: `${LOOSE_PREFIX}${id}` }] });
      } : undefined,
```

- `startArrow`: delete `line: 'needStep',`; add the same `loose` callback as `startEnd`'s target end (`(p) => { const id = newId(); d.onCommit(loosen(base, saved, wire.id, id, p), { picks: [{ kind: 'wire', id: `${LOOSE_PREFIX}${id}` }] }); }`).
- `startNew`: delete `line: 'needStep',`; add:

```ts
      // released where it attaches to nothing: kept as a loose wire from its source (plan 8 §5)
      loose: (p) => {
        const id = newId();
        d.onCommit(addLoose(d.draft, id, source, p), { picks: [{ kind: 'wire', id: `${LOOSE_PREFIX}${id}` }] });
      },
```

- add after `startNew`:

```ts
  /**
   * Drags a loose wire's open end (plan 8 §5): onto a step it may wire to, it becomes an ordinary wire; anywhere
   * else its end moves there; back on its own source it snaps back ("same step").
   */
  const startLoose = (looseId: string, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const l = base.loose[looseId];
    if (!l) return;
    const { placement } = shown.current;
    const at = placement.steps.get(l.source);
    const from = l.source === WORKFLOW_SOURCE
      ? { x: placement.sphere.cx + SPHERE_R, y: placement.sphere.cy }
      : { x: (at?.x ?? 0) + STEP_W, y: (at?.y ?? 0) + PMID };
    const boxes = blockBoxes(placement);
    setResize(null);
    dropGesture(e, {
      wire: null,
      path: (p, over) => { const f = freeEnd(p, 'target', boxes, over); return clearPath(route(from.x, from.y, f.x, f.y, boxOf(l.source), f.box, 0, boxes), boxes); },
      current: null,
      verdict: (over) => canWire(shown.current, l.source, over),
      done: (over) => d.onCommit(attachLoose(base, saved, looseId, over), { picks: [{ kind: 'wire', id: wireId(l.source, over) }] }),
      loose: (p) => d.onCommit(moveLoose(base, looseId, p), { picks: [{ kind: 'wire', id: `${LOOSE_PREFIX}${looseId}` }] }),
    });
  };
```

- `latestRef` holds `{ startSegment, startNew, startLoose, flowPointOf }` (both the initial value and the per-render assignment); the `gestures` memo gains:

```ts
    looseEndPointerDown(looseId, e) {
      latestRef.current.startLoose(looseId, e);
    },
```

`src/design/DesignOverlay.tsx:79` — the label group's class becomes `` `design-drop-label ${hint.tone}` ``.

`src/design/useDesignKeys.ts` — import `LOOSE_PREFIX, removeLoose` from `./draft`; the Delete branch becomes:

```ts
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const picked = wirePickIds(design.picks);
      const wires = picked.filter((id) => shown.current.wires.some((w) => w.id === id));
      // a loose wire is picked by its edge id `loose:{id}` (plan 8)
      const loose = picked.filter((id) => id.startsWith(LOOSE_PREFIX)).map((id) => id.slice(LOOSE_PREFIX.length));
      if (wires.length === 0 && loose.length === 0) return; // blocks are never removed (spec §2)
      e.preventDefault();
      design.onCommit(removeLoose(removeWires(design.draft, saved, wires), loose), { picks: design.picks.filter((p) => p.kind !== 'wire') });
    }
```

- [ ] **Step 5: Implement the drawing**

`src/canvas/edges/CableEdge.tsx`:
- import `LOOSE_PREFIX` from `../../design/draft`;
- `CableEdgeData`: `halo?: 'ok' | 'no' | 'loose';` and add `/** A loose wire (plan 8 §5): grey, dashed, an open circle at its end, no arrow head. */ loose?: boolean;`;
- add `/** A loose wire's colour: grey, of no entry condition (plan 8 §5). */ export const LOOSE_COLOUR = '#8A97A8';`;
- `CableEdgeView` takes `loose` too, and right after the `gap` line (hooks stay first):

```tsx
  if (loose) {
    const [sx0, sy0] = points[0]!;
    const [ex, ey] = points[points.length - 1]!;
    return (
      <g className={`wire loose${picked ? ' picked' : ''}`} style={{ '--nc': LOOSE_COLOUR } as CSSProperties}>
        <circle className="nx-src" cx={sx0} cy={sy0} r={2.6} />
        <path className="w" d={pathOf(points)} stroke={LOOSE_COLOUR} />
        <circle className="nx-open" cx={ex} cy={ey} r={4.5} />
      </g>
    );
  }
```

- `CableEdge` adds, after the hit bands:

```tsx
      {/* a loose wire's open end is always draggable in design mode (plan 8 §5) */}
      {data.loose && gestures && (() => {
        const [ex, ey] = data.points[data.points.length - 1]!;
        return <circle className="nx-open-hit" cx={ex} cy={ey} r={9} onPointerDown={(e) => gestures.looseEndPointerDown(id.slice(LOOSE_PREFIX.length), e)} />;
      })()}
```

`src/canvas/toFlow.ts`:
- import `LOOSE_PREFIX` from `../design/draft` and `LOOSE_COLOUR` (with the `CableEdgeType` import) from `./edges/CableEdge`;
- the hub's `handles` gain `handle('loose', 'target', Position.Right, 2 * SPHERE_R, SPHERE_R)` ("a loose wire from the hub ends on the hub itself: React Flow needs a target handle");
- delete `const parked = new Set(doc.parkedIds);`; `stepLabels(step, fitter)` loses its `parked` parameter (its `versionX` is `42`, and it returns `{ name, version }`); the tooltip loses its parked line;
- before `return { nodes, edges };`:

```ts
  // loose wires (plan 8 §5): drawn by the cable edge from their source; never part of the wiring
  for (const l of doc.loose) {
    const node = l.source === WORKFLOW_SOURCE ? SPHERE_NODE_ID : l.source;
    edges.push({
      id: `${LOOSE_PREFIX}${l.id}`, type: 'cable', source: node, target: node,
      sourceHandle: 'out', targetHandle: l.source === WORKFLOW_SOURCE ? 'loose' : 'in', selectable: false, focusable: false,
      data: { points: l.points, colour: LOOSE_COLOUR, broken: false, delay: 0, loose: true },
    });
  }
```

`src/canvas/nodes/StepNode.tsx` — delete `parked` from its data type (line 17); `versionX` is `42`; the group's class is `'blk nx'`; the kind text is `'STEP'`.

`src/canvas/selection.ts` — add `export const DROP_LOOSE_CLASS = 'drop-loose';` beside `DROP_OK_CLASS` and replace `withHint`:

```ts
export function withHint(nodes: StudioNode[], hint: { id: string | null; tone: 'ok' | 'loose' | 'no' } | null): StudioNode[] {
  if (hint === null || hint.id === null) return nodes;
  const cls = hint.tone === 'ok' ? DROP_OK_CLASS : hint.tone === 'loose' ? DROP_LOOSE_CLASS : DROP_NO_CLASS;
  return nodes.map((n) => (n.id === hint.id ? { ...n, className: withClass(n.className, cls) } : n));
}
```

`src/canvas/WorkflowCanvas.tsx`:
- line 137: `if (wiring.hint?.line && e.id === wiring.hint.id) data = { ...data, halo: wiring.hint.tone };`
- `onEdgeContextMenu`: `if (!design || edge.type !== 'cable' || edge.id.startsWith(LOOSE_PREFIX)) return;` (a loose wire has no route to reset; import `LOOSE_PREFIX` with `resetRoute`).

`src/panels/Inspector.tsx` `wireNote` — first line: `if (id.startsWith(LOOSE_PREFIX)) return 'Loose wire: not part of the workflow until its open end is dropped on a step';` (import `LOOSE_PREFIX` with `wireEnds`).

`src/canvas/Legend.tsx` — replace the parked item with:

```tsx
      <span className="lg-item" title={'Loose wire: dropped where it attaches to nothing.\nNot part of the workflow until its open end is dropped on a step.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <path className="lg-loose" d="M1 7H21" />
          <circle className="lg-open" cx="25" cy="7" r="3.5" />
        </svg>
        loose wire
      </span>
```

and its doc comment: "The colour key (spec §5.1, §5.3; plan 8 §5): broken and loose wires; an unwired step looks like any other."

`src/canvas/art.css` — delete `.blk.parked …` (lines 31-32) and `.legend .lg-parked …` (line 106); add:

```css
/* plan 8: a loose wire, grey and dashed, with an open circle where it was dropped; never pulses */
.wire.loose path.w { stroke-dasharray: 6 4; filter: none; }
.wire.loose .nx-open { fill: #060c17; stroke: #8A97A8; stroke-width: 1.6; pointer-events: none; }
.nx-open-hit { fill: transparent; stroke: none; pointer-events: all; cursor: grab; }
.wire.halo-loose path.w { stroke-width: 3; filter: drop-shadow(0 0 4px #9AA7B8) drop-shadow(0 0 8px #9AA7B8); }
.legend .lg-loose { fill: none; stroke: #8A97A8; stroke-width: 1.4; stroke-dasharray: 4 3; }
.legend .lg-open { fill: none; stroke: #8A97A8; stroke-width: 1.4; }
```

`src/canvas/canvas.css` — after `.drop-no`:

```css
/* plan 8: released here the wire becomes loose (grey) */
.studio-canvas .react-flow__node.drop-loose { outline: calc(3px * var(--inv, 1)) solid #9AA7B8; outline-offset: calc(4px * var(--inv, 1)); border-radius: 8px; }
.design-drop-label.loose rect { fill: rgba(20, 26, 36, .92); stroke: #9AA7B8; }
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx tsc -b; Remove-Item tsconfig.tsbuildinfo; npx vitest run`
Expected: type check clean; all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/WorkflowStudio/src
git commit -m "feat(studio): wires drop anywhere: cycles allowed, loose wires grey and dashed with an open end, re-attachable; legend loses parked (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Playwright with a real mouse and keyboard: save on a throwaway workflow; the designer and Inspector specs follow plan 8

**Files:**
- Modify: `src/WorkflowStudio/e2e/studio.ts` (read-only guard: GETs only; `pointOnWire`, `centreOf` moved here and exported), `e2e/throwaway.ts` (two steps, an assignment; the guard allows only `PUT …/design` for this run's workflow)
- Create: `src/WorkflowStudio/e2e/save.spec.ts`
- Rewrite: `src/WorkflowStudio/e2e/inspector.spec.ts`
- Modify: `src/WorkflowStudio/e2e/designer.spec.ts` (imports; five tests whose behaviour plan 8 changes; one new loose-wire test)
- Modify: `src/WorkflowStudio/playwright.config.ts:3-5` (comment)

**Interfaces:**
- Consumes: everything above, through the browser; BaseApi CRUD through `request` for setup, checks and teardown.
- Produces: `Throwaway` gains `stepBId: string`, `assignmentId: string`, `tag: string`; `studio.ts` exports `pointOnWire(panel, id, f?, clear?)` and `centreOf(locator)`.

- [ ] **Step 1: The guards and the throwaway workflow**

`e2e/studio.ts` — the read-only guard's doc becomes "fails the test if any request is not a GET (opening a workflow runs no validate, plan 8 §3.1)" and its body:

```ts
    context.on('request', (r) => {
      if (r.method() === 'GET' || r.method() === 'HEAD') return;
      writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
```

Move `pointOnWire` and `centreOf` (with their doc comments, unchanged) from `e2e/designer.spec.ts` to the end of `e2e/studio.ts`, exported; `designer.spec.ts` imports them from `./studio`.

`e2e/throwaway.ts`:
- `Throwaway` gains `stepBId: string; assignmentId: string; tag: string;` and `created` gains `stepBId?: string; assignmentId?: string; tag?: string;`; delete `Kind`, `allowed`, `allow`, `PUT_PATH` (the browser writes nothing but Save now);
- `createThrowaway`:

```ts
/** A schema, a processor using it as its config schema, steps A → B, an assignment on A, a cache, and a workflow with entry A. */
export async function createThrowaway(request: APIRequestContext): Promise<Throwaway> {
  const tag = `e2e-8-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  created.tag = tag;
  created.schemaId = await post(request, 'schemas', { name: `${tag}-config`, version: '1.0.0', description: null, definition: '{"type":"object"}' });
  created.processorId = await post(request, 'processors', {
    name: `${tag}-proc`, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: created.schemaId,
  });
  created.stepBId = await post(request, 'steps', { name: `${tag}-b`, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds: [], entryCondition: 1 });
  const stepName = `${tag}-a`;
  created.stepId = await post(request, 'steps', { name: stepName, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds: [created.stepBId], entryCondition: 1 });
  created.assignmentId = await post(request, 'assignments', { name: `${tag}-asg`, version: '1.0.0', description: null, stepId: created.stepId, payload: '{}' });
  created.cacheId = await post(request, 'caches', { name: `${tag}-cache`, version: '1.0.0', description: null, root: `${tag}-root`, items: '{}' });
  created.workflowId = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [created.stepId], assignmentIds: [created.assignmentId], cacheIds: [created.cacheId], cronExpression: null,
  });
  return {
    workflow: { id: created.workflowId, name: tag, version: '1.0.0', label: label(tag, '1.0.0', created.workflowId) }, tag,
    stepId: created.stepId, stepName, stepBId: created.stepBId, assignmentId: created.assignmentId,
    processorId: created.processorId, schemaId: created.schemaId, cacheId: created.cacheId,
  };
}
```

(`post` loses its `allow(kind, id)` line and takes `kind: string`.)
- `removeThrowaway` — after the workflow delete: delete every assignment whose `stepId` is A or B; `PUT steps/{A}` back with `nextStepIds: []` (GET it first, as `WorkflowGraphLiveTests.DisposeAsync` does); delete steps A and B; delete the processor; then delete every schema whose name starts with `created.tag` (`GET /api/v1/schemas`, filter by `name`; the original and any copy a Save made, which keep its name); then the cache. Every step stays best effort and collects failures as today.
- `refusal`:

```ts
/** Why a request may not reach BaseApi, or null when it may: GETs, and Save of this run's workflow (plan 8 §8). */
function refusal(r: Request): string | null {
  const method = r.method();
  const path = new URL(r.url()).pathname;
  if (method === 'GET' || method === 'HEAD') return null;
  if (method === 'PUT' && created.workflowId !== undefined && path === `/api/v1/workflows/${created.workflowId}/design`) return null;
  return `${method} ${path}`;
}
```

and the `test` fixture's doc: "the browser may write only Save of this run's throwaway workflow; any other write is aborted before it reaches BaseApi and fails the test".

`playwright.config.ts` — the header comment's "They only read: GETs and the validate dry run." becomes "They only read (GETs), except save.spec.ts, which saves a throwaway workflow it creates and deletes (plan 8 §8)."

- [ ] **Step 2: Write the save spec** (`e2e/save.spec.ts`)

```ts
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, inspector, openWorkflow, pointOnWire, tab } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// Plan 8 §8: Save is the studio's only write, and these tests write only to their own throwaway workflow
// (e2e/throwaway.ts, `e2e-8-…`), created here through BaseApi's CRUD and deleted afterwards. They build on
// each other's state, so they run in order, never retried.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const field = (page: Page, label: string): Locator => inspector(page).getByLabel(label, { exact: true });
const pill = (page: Page): Locator => inspector(page).locator('.kindpill');
const node = (panel: Locator, id: string): Locator => panel.locator(`.react-flow__node[data-id="${id}"]`);
const looseWires = (panel: Locator): Locator => panel.locator('.react-flow__edge[data-id^="loose:"]');

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(`/api/v1/${path}`);
  expect(r.ok(), `GET ${path}`).toBe(true);
  return (await r.json()) as T;
}

/** Replaces a field's text with the real keyboard: click, select all, type. */
async function typeInto(page: Page, label: string, text: string): Promise<void> {
  await field(page, label).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

async function selectStep(page: Page, panel: Locator, id: string): Promise<void> {
  await node(panel, id).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
}

/** The capsule's Save, then wait for the answer (the button leaves "Saving…"). */
async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: '⤓ Save' }).click();
  await expect(page.getByRole('button', { name: '⤓ Saving…' })).toHaveCount(0, { timeout: 20_000 });
}

async function pane(page: Page, name: 'Problems' | 'Output'): Promise<Locator> {
  await tab(page, name).click();
  return page.locator(`[data-pane="${name.toLowerCase()}"]`);
}

test('an invalid design is stored but not applied: Problems and Output say why, BaseApi is unchanged, a fresh page shows the stored design', async ({ page, request, context }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);

  // on the canvas: a new wire from B's port, released on empty canvas, is a loose wire
  const b = node(panel, t.stepBId);
  await b.hover();
  const port = await centreOf(b.locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  const empty = { x: area.x + area.width - 80, y: area.y + area.height - 120 };
  await page.mouse.move(port.x, port.y);
  await page.mouse.down();
  await page.mouse.move(empty.x, empty.y, { steps: 12 });
  await expect(panel.locator('.design-drop-label')).toHaveText('loose wire');
  await page.mouse.up();
  await expect(looseWires(panel)).toHaveCount(1);

  // in the Inspector: step A gets a description and a version BaseApi refuses
  await selectStep(page, panel, t.stepId);
  await typeInto(page, 'Description', 'designed');
  await typeInto(page, 'Version', 'abc');
  await expect(page.getByText('● design draft')).toBeVisible();
  await save(page);

  const problems = await pane(page, 'Problems');
  await expect(problems.getByRole('listitem')).toHaveCount(1);
  await expect(problems.getByRole('listitem').first()).toContainText('version');
  await expect(await pane(page, 'Output')).toContainText('Saved; not applied: 1 error');
  // the real step is unchanged, and the design is stored on the workflow
  const step = await get<{ version: string; description: string | null }>(request, `steps/${t.stepId}`);
  expect([step.version, step.description]).toEqual(['1.0.0', null]);
  expect((await get<{ design: unknown }>(request, `workflows/${t.workflow.id}/graph`)).design).not.toBeNull();

  // a fresh page, with no session, shows the stored design and no errors
  const fresh = await context.newPage();
  await fresh.goto('/');
  await fresh.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await fresh.reload();
  await openWorkflow(fresh, t.workflow);
  const again = documentPanel(fresh, t.workflow);
  await expect(looseWires(again)).toHaveCount(1);
  await selectStep(fresh, again, t.stepId);
  await expect(field(fresh, 'Version')).toHaveValue('abc');
  await expect(field(fresh, 'Description')).toHaveValue('designed');
  await tab(fresh, 'Problems').click();
  await expect(fresh.locator('[data-pane="problems"]')).toContainText('No problems');
  await fresh.close();
});

test('fixed and saved again, the design is applied: BaseApi holds it, the stored design is emptied, the loose wire stays in the layout', async ({ page, request }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await selectStep(page, panel, t.stepId);
  await expect(field(page, 'Version')).toHaveValue('abc');
  await typeInto(page, 'Version', '1.0.1');
  await save(page);

  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  await expect(await pane(page, 'Problems')).toContainText('No problems');
  const step = await get<{ version: string; description: string | null }>(request, `steps/${t.stepId}`);
  expect([step.version, step.description]).toEqual(['1.0.1', 'designed']);
  expect((await get<{ design: unknown }>(request, `workflows/${t.workflow.id}/graph`)).design).toBeNull();

  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(looseWires(again)).toHaveCount(1);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('one Save applies changes of every kind: a deleted wire, a removed assignment, a schema copy with its name and version', async ({ page, request }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const wireId = `${t.stepId}->${t.stepBId}`;

  // the canvas: pick A -> B and delete it; B stays on the canvas and looks like any step
  const p = await pointOnWire(panel, wireId);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Delete');
  await expect(panel.locator(`.react-flow__edge[data-id="${wireId}"]`)).toHaveCount(0);
  await expect(node(panel, t.stepBId).locator('.blk.parked')).toHaveCount(0);

  // the Inspector: A's assignment removed; its processor's Config schema edited (a background copy)
  await selectStep(page, panel, t.stepId);
  await inspector(page).getByRole('button', { name: '✕ Remove' }).click();
  await expect(inspector(page).getByRole('button', { name: '＋ Create' })).toBeVisible();
  await node(panel, t.stepId).locator('.chipg').click();
  await expect(pill(page)).toHaveText('PROCESSOR');
  await inspector(page).locator('.slot').filter({ hasText: 'Config' }).getByRole('button').first().click();
  await expect(pill(page)).toHaveText('SCHEMA');
  await typeInto(page, 'Definition', '{"type":"string"}');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');

  expect((await get<{ nextStepIds: string[] }>(request, `steps/${t.stepId}`)).nextStepIds).toEqual([]);
  expect((await request.get(`/api/v1/assignments/${t.assignmentId}`)).status()).toBe(404);
  const proc = await get<{ configSchemaId: string }>(request, `processors/${t.processorId}`);
  expect(proc.configSchemaId).not.toBe(t.schemaId);
  const copy = await get<{ name: string; version: string; definition: string }>(request, `schemas/${proc.configSchemaId}`);
  expect([copy.name, copy.version]).toEqual([`${t.tag}-config`, '1.0.0']);
  expect(JSON.parse(copy.definition)).toEqual({ type: 'string' });
});
```

- [ ] **Step 3: The Inspector spec edits the design** (`e2e/inspector.spec.ts` — replace the file)

```ts
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { documentPanel, inspector, openWorkflow } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// Plan 8 §3.3: the Inspector edits the design, never BaseApi. These tests never press Save: the write guard
// (e2e/throwaway.ts) fails them on any write, and each checks BaseApi still holds what it created.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const field = (page: Page, label: string): Locator => inspector(page).getByLabel(label, { exact: true });
const pill = (page: Page): Locator => inspector(page).locator('.kindpill');

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(`/api/v1/${path}`);
  expect(r.ok(), `GET ${path}`).toBe(true);
  return (await r.json()) as T;
}

async function typeInto(page: Page, label: string, text: string): Promise<void> {
  await field(page, label).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

test('every entity kind edits the design: marked unsaved, kept while the Inspector moves on, nothing written', async ({ page, request }) => {
  const panel = await open(page);
  await panel.locator('.react-flow__node-workflow').click();
  await expect(pill(page)).toHaveText('WORKFLOW');
  await typeInto(page, 'Description', 'wf designed');
  await expect(inspector(page).getByText('● unsaved changes')).toBeVisible();

  await panel.locator(`.react-flow__node[data-id="${t.stepId}"]`).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
  await typeInto(page, 'Description', 'step designed');
  await field(page, 'Entry condition').click();
  await inspector(page).getByRole('option', { name: /Always/ }).click();

  await panel.locator(`.react-flow__node[data-id="${t.stepId}"] .chipg`).click();
  await expect(pill(page)).toHaveText('PROCESSOR');
  await typeInto(page, 'Description', 'proc designed');

  await panel.locator('.react-flow__node-cache').first().click();
  await expect(pill(page)).toHaveText('CACHE');
  await typeInto(page, 'Items', '{"a":"b"}');

  // back on the workflow: its edit is still there
  await panel.locator('.react-flow__node-workflow').click();
  await expect(field(page, 'Description')).toHaveValue('wf designed');
  await expect(page.getByText('● design draft')).toBeVisible();

  expect((await get<{ description: string | null }>(request, `workflows/${t.workflow.id}`)).description).toBeNull();
  expect((await get<{ description: string | null; entryCondition: number }>(request, `steps/${t.stepId}`)).entryCondition).toBe(1);
  expect((await get<{ description: string | null }>(request, `processors/${t.processorId}`)).description).toBeNull();
  expect((await get<{ items: string }>(request, `caches/${t.cacheId}`)).items).toBe('{}');
});

test('Revert drops one entity\'s edits; the others stay', async ({ page }) => {
  const panel = await open(page);
  await panel.locator(`.react-flow__node[data-id="${t.stepId}"]`).click({ position: { x: 20, y: 12 } });
  await typeInto(page, 'Version', 'abc');
  await panel.locator('.react-flow__node-workflow').click();
  await typeInto(page, 'Description', 'kept');
  await panel.locator(`.react-flow__node[data-id="${t.stepId}"]`).click({ position: { x: 20, y: 12 } });
  await inspector(page).getByRole('button', { name: 'Revert' }).click();
  await expect(field(page, 'Version')).toHaveValue('1.0.0');
  await panel.locator('.react-flow__node-workflow').click();
  await expect(field(page, 'Description')).toHaveValue('kept');
});

test('Create and Remove assignment change the design only', async ({ page, request }) => {
  const panel = await open(page);
  await panel.locator(`.react-flow__node[data-id="${t.stepBId}"]`).click({ position: { x: 20, y: 12 } });
  await inspector(page).getByRole('button', { name: '＋ Create' }).click();
  await expect(pill(page)).toHaveText('ASSIGNMENT');
  await expect(field(page, 'Name')).toHaveValue(`${t.tag}-b-assignment`);
  await inspector(page).getByRole('button', { name: 'Remove assignment' }).click();
  await expect(pill(page)).toHaveText('STEP');
  const all = await get<{ stepId: string }[]>(request, 'assignments');
  expect(all.filter((a) => a.stepId === t.stepBId)).toEqual([]);
});
```

- [ ] **Step 4: The designer spec follows plan 8** (`e2e/designer.spec.ts`)

Replace the test `a wire end dropped where it would close a cycle outlines red and snaps back` with:

```ts
test('a wire end dropped where it closes a loop is allowed: green, "re-attach here", and the loop is drawn (plan 8 §5)', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const p = await pointOnWire(panel, `${b}->${c}`);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator('.design-handle.end[data-end="target"]'));
  const target = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, a)).toHaveClass(/drop-ok/);
  await expect(panel.locator('.design-drop-label')).toHaveText('re-attach here');
  await page.mouse.up();
  await expect(wire(panel, `${b}->${a}`)).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});
```

In `a new entry wire from the hub, Delete, and a step left unreached is parked; Undo and Redo` rename it to `… and a step left unreached looks like any step; Undo and Redo` and replace `await expect(node(panel, b).getByText('PARKED', { exact: true })).toBeVisible();` with:

```ts
  await expect(node(panel, b).getByText('PARKED', { exact: true })).toHaveCount(0);
  await expect(node(panel, b).locator('.blk.parked')).toHaveCount(0);
```

In `closing a designed workflow asks; Cancel keeps it` the dialog name becomes `'Save design changes?'`.

Replace `a dragged wire end lands on a step's border, never inside; on its own step it moves its contact point; on empty canvas it snaps back` with:

```ts
test('a dragged wire end lands on a step\'s border, never inside; on its own step it moves its contact point; on empty canvas it becomes a loose wire', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  const id = `${a}->${b}`;
  const grab = async () => {
    const p = await pointOnWire(panel, id);
    await page.mouse.click(p.x, p.y);
    const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="target"]`));
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    return head;
  };
  const before = await pathOf(panel, id);

  // its own step, higher up: the wire stays outside it, and the contact point moves there
  await grab();
  const bb = (await node(panel, b).boundingBox())!;
  await page.mouse.move(bb.x + 6, bb.y + bb.height * 0.3, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('move contact here');
  expect(await blocksCrossed(panel, id)).toEqual([]);
  await page.mouse.up();
  await expect.poll(() => pathOf(panel, id)).not.toBe(before);
  expect(await blocksCrossed(panel, id)).toEqual([]);

  // empty canvas: grey "loose wire"; released, the wire leaves the wiring and stays drawn with an open end
  const head = await grab();
  await page.mouse.move(head.x - 40, head.y + 220, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('loose wire');
  await page.mouse.up();
  await expect(wire(panel, id)).toHaveCount(0);
  await expect(panel.locator('.react-flow__edge[data-id^="loose:"] circle.nx-open')).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});
```

Replace `a wire's arrow over a line of another colour is refused and snaps back` with:

```ts
test('a wire\'s arrow over a line of another colour is a loose-wire drop: grey halo, "loose wire"; released there the wire becomes loose', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null || !j.wires.some((x) => j.wires.some((y) => otherColour(x, y))), 'no wire of another colour');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a: c, b, between } = (await nearestPair(panel, j!.wires, otherColour))!;
  await zoomInOn(page, panel, between);
  await dragArrowOnto(page, panel, c, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('loose wire');
  await expect(wire(panel, b).locator('.wire.halo-loose')).toHaveCount(1);
  await page.mouse.up();
  await expect(wire(panel, c)).toHaveCount(0);
  await expect(panel.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});
```

In `a wire's arrow dragged over a cache tag is refused out loud: red "not a step", the cache outlined red, and it snaps back` rename it to `a wire's arrow dragged over a cache tag is a loose-wire drop: grey "loose wire", the cache outlined grey; released there the wire becomes loose` and replace everything from `await expect(panel.locator('.design-drop-label')).toHaveText('not a step');` to the end with:

```ts
  await expect(panel.locator('.design-drop-label')).toHaveText('loose wire');
  await expect(cache).toHaveClass(/drop-loose/);
  await page.mouse.up();
  await expect(cache).not.toHaveClass(/drop-/);
  await expect(wire(panel, id!)).toHaveCount(0);
  await expect(panel.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(1);
});
```

(and delete its now unused `before` line). Append:

```ts
test('a new wire dropped on empty canvas is a loose wire: grey, dashed, an open end; a refresh keeps it; its end dropped on a step wires it (plan 8 §5)', async ({ page }) => {
  const panel = await open(page);
  const { a, c } = chain!;
  await node(panel, c).hover();
  const port = await centreOf(node(panel, c).locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  const empty = { x: area.x + area.width - 80, y: area.y + area.height - 120 };
  await drag(page, port, empty);
  const loose = panel.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(loose).toHaveCount(1);
  const line = loose.locator('path.w');
  expect(await line.evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe('none');
  expect(await line.getAttribute('stroke')).toBe('#8A97A8');
  await expect(loose.locator('circle.nx-open')).toHaveCount(1);
  await expect(loose.locator('.nx-head')).toHaveCount(0);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  const kept = again.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(kept).toHaveCount(1);

  // its open end onto a step it may wire to: an ordinary wire
  const end = await centreOf(kept.locator('.nx-open-hit'));
  const target = await centreOf(node(again, a).locator('.nx-sn'));
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await expect(again.locator('.design-drop-label')).toHaveText('connect here');
  await page.mouse.up();
  await expect(wire(again, `${c}->${a}`)).toHaveCount(1);
  await expect(again.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(0);
});
```

Any other designer test that still expects a removed label ("would make a loop", "other colour", "already wired", "not a step", "drop on a step") follows the table in Task 14 Step 1.

- [ ] **Step 5: Run on the dev server** (PowerShell, `src/WorkflowStudio`; the BaseApi port-forward `localhost:18080` must be up, with Task 7's BaseApi deployed)

Run: `npx playwright test e2e/save.spec.ts e2e/inspector.spec.ts e2e/designer.spec.ts`
Expected: all PASS (designer tests that find no qualifying live workflow skip, as before).

- [ ] **Step 6: Fix any failure at its root (superpowers:systematic-debugging), then run everything**

Run: `npx tsc -b; Remove-Item tsconfig.tsbuildinfo; npx vitest run; npx playwright test`
Expected: clean; all unit tests PASS; Playwright all passed plus the 2 expected `art.spec.ts` skips. After the run, `GET /api/v1/workflows` lists no `e2e-8-…` workflow (teardown removed it).

- [ ] **Step 7: Commit**

```powershell
git add src/WorkflowStudio/e2e src/WorkflowStudio/playwright.config.ts
git commit -m "test(studio): Playwright saves a throwaway workflow (invalid, then fixed), edits the design in the Inspector, and drops loose wires (plan 8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Deploy the studio and verify on the deployed studio; handover

**Files:**
- Modify: `docs/HANDOVER-2026-10-07-skp-studio-plan4-trial.md` (a "Built: plan 8" section)

- [ ] **Step 1: Deploy (ask the user first: it restarts the shared dev studio)**

PowerShell, repo root:

```powershell
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
kind load docker-image workflow-studio:local --name desktop
kubectl -n skp rollout restart deploy/workflow-studio
kubectl -n skp rollout status deploy/workflow-studio --timeout=180s
```

Expected: the rollout completes.

- [ ] **Step 2: Run the e2e suite against the deployed studio**

Start the studio port-forward detached (`kubectl port-forward -n skp svc/workflow-studio 18081:8080`), then write a temporary config `playwright.deployed.tmp.config.ts` (not committed) that imports the default config, sets `use.baseURL` to `http://localhost:18081` and has no `webServer`:

```ts
import base from './playwright.config';
export default { ...base, use: { ...base.use, baseURL: 'http://localhost:18081' }, webServer: undefined };
```

Run: `npx playwright test --config playwright.deployed.tmp.config.ts e2e/save.spec.ts e2e/inspector.spec.ts e2e/designer.spec.ts`
Expected: all PASS (the same skips as on the dev server). Delete `playwright.deployed.tmp.config.ts`; stop the port-forward.

- [ ] **Step 3: Update the handover and commit**

Add a section "Built: plan 8 virtual design" to `docs/HANDOVER-2026-10-07-skp-studio-plan4-trial.md`: the commit range (first and last commit of this plan), the BaseApi migration name (`AddWorkflowDesign`), the studio bundle name (`dist/assets/index-*.js` from the image build output), the test counts (BaseApi hermetic, BaseApi live `WorkflowDesignLiveTests`, Vitest, Playwright dev and deployed), and the open spec gaps listed at the end of this plan.

```powershell
git add docs/HANDOVER-2026-10-07-skp-studio-plan4-trial.md
git commit -m "docs(studio): handover records plan 8 (virtual design, save by store + dry run + align) built and deployed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage** (spec section → task):
- §1.1 load with GETs only, no validate → Task 9 (loader, `opens with GETs only` test; read-only e2e guard in Task 15). Live polls untouched.
- §1.2 every edit virtual → Tasks 8, 11, 12 (Inspector), 14 (canvas). §1.3 ownership / last write wins → Tasks 4 (shared), 5-6 (owned). §1.4 update only, assignments c/u/d → Tasks 6, 8, 12. §1.5 schema background copy → Tasks 4 (server), 8 (`setField` schema), 12 (Inspector, `＋ Define`). §1.6 store regardless, dry run, align → Tasks 3-7, 13. §1.7 wires anywhere, loose wire, legend → Task 14. §1.8 same ids → Task 9 (base from GETs), Task 8 (`newId` only for copies, created assignments and loose wires). §1.9 session keeps unsaved edits → Task 11.
- §2 scope → no step/processor/cache/schema create or delete anywhere; no start checks; Toolbox untouched.
- §3.1 load, base + stored + session → Tasks 9, 10 (`applyDesign`), 11 (`loaded`, `restored`). §3.2 what the design holds, Discard → Tasks 8, 11. §3.3 the Inspector → Task 12.
- §4.1 Save, read-only, outcomes, Problems/Output, errors' lifetime → Tasks 11 (`saveAnswered`, `discardDesign` clears errors, `close` drops them), 13. §4.2 endpoint, `Design` column, body → Tasks 1, 2, 3, 13 (`buildDesignRequest`). §4.3 store, stages, rules, answer, 400/404 → Tasks 2-6, 7 (Postgres). §4.4 schema copy version unchanged → Tasks 4, 7.
- §5 wires dropped anywhere → Task 14; e2e Task 15. §6 edge cases: 6.1 → Tasks 3, 7; 6.2 → Tasks 5, 7; 6.3 → Tasks 3, 4, 7; 6.4 → Task 13 (Review Focus 5), 15; 6.5 → Tasks 4, 7; 6.6 → Task 6; 6.7 → Tasks 6, 7; 6.8 → Tasks 11, 15.
- §7 structure → File structure above. §8 testing: BaseApi unit per stage (Tasks 4-6), Postgres list (Task 7, all ten), Vitest list (Tasks 8-14), Playwright on dev server and deployed with a throwaway workflow (Tasks 15-16).

**Placeholder scan:** every code step carries the code; the only deferred lookups are mechanical (Task 9 Step 4's compile fixes, Task 14's label table for existing tests), each with the exact rule to apply.

**Type consistency:** `DesignSaveRequest`/`DesignOutcomeDto`/`DesignErrorDto` (C#, Task 2) ↔ regenerated TS aliases (Task 9) ↔ `DesignRequest` (Task 13, cast at the client call). `EntityEdits`, `Design`, `FieldValue`, `EditTarget` (Task 8) are used unchanged by Tasks 10-13. `OpenDocument.edits`/`errors` (Task 9) and `stored`/`restored`/`saving` (Task 11) are read by Tasks 12-13. `DropHint.tone` (Task 14) replaces `ok` in `withHint`, `DesignOverlay` and `WorkflowCanvas` in the same task. `LOOSE_PREFIX` (Task 8) is used by Tasks 11, 14.

**Review Focus:** 1 → Task 3 `StoringDoesNotMoveTheWorkflowsUpdatedAt` + Task 6 `AWorkflowChangeWithTheLoadedStampAppliesAfterTheStore`; 2 → Task 5; 3 → Task 11; 4 → Task 11; 5 → Task 13.

## Spec gaps and contradictions found

1. **A released tail cannot become a loose wire.** §5 says any end released anywhere else becomes loose "with its tail on its source", which a dragged tail does not have. This plan snaps a tail back ("cannot start here").
2. **A stale stamp in a stored design repeats its conflict.** §6.2 offers "Discard design (reload)", but Discard returns to the last saved design (§3.2), which still carries the old `updatedAt`; every Save then fails the same way. Here the user clears it with the Inspector's Revert on that entity (the stamp goes with it).
3. **Broken-wire marks disappear.** They came from validate's schema-edge problems; with validate removed nothing is ever drawn broken, yet the legend keeps "broken" (the spec only says "parked" goes).
4. **"Save enabled when the design differs from the base"** is read as: unsaved edits, or a stored design not yet applied.
5. Cosmetic: decision numbers in §1 run 1-6, 9, 8, 7 and edge cases in §6 run 1-4, 8, 5-7.

