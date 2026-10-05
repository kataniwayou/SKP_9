# SKP Studio, Plan 1 of 7: Backend Layout and Atomic Graph Save -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BaseApi gains a nullable jsonb `Layout` column on workflows with `GET`/`PUT /workflows/{id}/layout`, a `GET /workflows/{id}/graph` read, and an atomic `PUT /workflows/{id}/graph` that creates or replaces a whole workflow graph in one save.

**Architecture:** The graph endpoints live on the existing `WorkflowsController` and delegate to two public interfaces (`IWorkflowGraphReader`, `IWorkflowGraphSaver`) implemented by internal classes in a new `Features/Workflow/Graph/` folder. The saver reuses the existing FluentValidation validators and Mapperly mappers, and the junction-sync logic is extracted from `StepService` / `WorkflowService` into two static helpers so the services and the saver share one implementation. Every staged change commits in **one `SaveChangesAsync`**: EF orders inserts and deletes by the foreign keys in the model, which is what the spec's "rows, then wires" two passes require, and one save is atomic without an explicit transaction. The reader wraps the existing `WorkflowGraphLoader`.

**Tech Stack:** .NET 8, EF Core 8 (Npgsql, `jsonb`), FluentValidation, Riok.Mapperly, xUnit v3 on Microsoft.Testing.Platform, EF InMemory for hermetic tests, the kind "RealStack" for Postgres tests.

**Spec:** `docs/superpowers/specs/2026-10-05-skp-studio-design.md` (sections 2, 3.2, 4, 8, 9 and 10 slice 1).

## Global Constraints

- **No backend validator changes.** The saver calls the existing validators (`WorkflowUpdateDtoValidator`, `StepCreateDtoValidator`, `StepUpdateDtoValidator`, `AssignmentCreateDtoValidator`, `SchemaCreateDtoValidator`); it never re-implements their rules.
- **The editor never blocks a design.** The save performs no cycle, schema-edge, payload-vs-config-schema or liveness check. The only graph precondition is a non-empty `EntryStepIds`, which `WorkflowUpdateDtoValidator` already enforces.
- **`Layout` holds positions only and the server treats it as opaque.** It must be a JSON **object** of at most **1 048 576** characters (the `AssignmentEntity.Payload` cap). The server never reads inside it.
- **Concurrency is by `updatedAt`.** 409 if the stored workflow, or any changed step, has an `UpdatedAt` newer than the one the request carries. The existing `xmin` token still guards the window between the check and the save, and its `DbUpdateConcurrencyException` already maps to 409.
- **At most one assignment per (workflow, step).** Resolving an intent leaves exactly zero or one row linked for that step.
- **No navigation properties, anywhere.** Relationships stay `HasOne<T>().WithMany()` with no lambdas.
- **`BaseApi.Core` is a NuGet package.** This plan does not modify it; if a task ever needs to, `bash scripts/pack-all.sh` must run before building consumers.
- **Mapperly diagnostics are errors.** A new `WorkflowEntity` property needs explicit ignore attributes on all three mapper methods, or the build fails.
- **Test commands.** Build: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`. Run one class: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "<FQN>"`. Full hermetic suite: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"`. Use **fully-qualified** class names: a bare name matches zero tests and exits 0, which looks like a pass. **Do not use `dotnet test`**: it hides which tests failed.
- **Live tests** run only with `SKP_REALSTACK=1` and `k8s/port-forward-realstack.ps1` running; BaseApi answers at `http://localhost:18080`.

## Review Focus

1. **A request that names a step as "new" when that id already exists** (two tabs creating the same step, or a retried save). Expected: 409 naming the step, nothing written. Test added in Task 5.
2. **An assignment intent for a step created in the same request.** Expected: the step and its assignment both land, in FK order, in one save. Hermetic test in Task 6; Postgres ordering proven in Task 9.
3. **Removing an assignment that another workflow still links.** Expected: this workflow's link goes, the row stays. Test added in Task 6.
4. **A schema edit on a processor whose slot was empty.** Expected: a fresh schema row named `<processor>-<slot>`, version `1.0.0`. Test added in Task 7.
5. **A save that fails half-way in Postgres** (an FK violation from a step pointing at a missing processor). Expected: 422, and nothing from the request is persisted: no new steps, no layout change. Live test in Task 9.

---

## File Structure

**New: `src/BaseApi.Service/Features/Workflow/Graph/`**

| File | Responsibility |
|---|---|
| `WorkflowGraphDtos.cs` | Public request/response records: `GraphSaveRequest`, `GraphWorkflowDto`, `GraphStepDto`, `GraphAssignmentIntent`, `GraphSchemaEdit`, `WorkflowGraphDto` |
| `IWorkflowGraphReader.cs` | Public read interface |
| `IWorkflowGraphSaver.cs` | Public save interface |
| `WorkflowGraphReader.cs` | Wraps `IWorkflowGraphLoader`, adds `Layout`, flattens to `WorkflowGraphDto` |
| `WorkflowLayout.cs` | The one layout rule: JSON object, ≤ 1 048 576 chars |
| `GraphConflictException.cs` | Thrown on a stale `updatedAt`; carries the kind and id |
| `GraphConflictExceptionHandler.cs` | Maps it to a 409 that names the stale entity |
| `GraphAssignmentResolver.cs` | Update-in-place / copy-on-shared / create / unlink-and-orphan-delete |
| `GraphSchemaEditor.cs` | New schema row + re-point, or clear a slot |
| `WorkflowGraphSaver.cs` | The ordered save: validate, concurrency, schemas, steps, assignments, workflow, layout, one save |

**New: shared junction helpers**

| File | Responsibility |
|---|---|
| `src/BaseApi.Service/Features/Step/StepJunctions.cs` | `SyncNextStepsAsync`, extracted from `StepService` |
| `src/BaseApi.Service/Features/Workflow/WorkflowJunctions.cs` | `SyncAsync` for the three workflow junctions, extracted from `WorkflowService` |

**Modified**

| File | Change |
|---|---|
| `Features/Workflow/WorkflowEntity.cs` | `public string? Layout { get; set; }` |
| `Features/Workflow/WorkflowEntityMapper.cs` | Ignore `Layout` on all three methods |
| `Persistence/Configurations/WorkflowEntityConfiguration.cs` | `Layout` as `jsonb` |
| `Persistence/Migrations/<stamp>_AddWorkflowLayout.cs` (+ Designer, snapshot) | EF-generated |
| `Features/Step/StepService.cs` | Calls `StepJunctions` |
| `Features/Workflow/WorkflowService.cs` | Calls `WorkflowJunctions` |
| `Features/Workflow/WorkflowController.cs` | Four actions: `GetLayout`, `PutLayout`, `GetGraph`, `PutGraph` |
| `Features/Workflow/WorkflowServiceCollectionExtensions.cs` | Registers the graph classes and the 409 handler |

**New tests: `src/tests/BaseApi.Tests/WorkflowGraph/`**

| File | Covers |
|---|---|
| `GraphHarness.cs` | Builds an InMemory `AppDbContext` with the audit interceptor and a fake clock, plus every graph class |
| `WorkflowLayoutTests.cs` | The layout rule and the two layout actions |
| `JunctionHelperTests.cs` | The extracted helpers |
| `WorkflowGraphReaderTests.cs` | `GET /graph` shape |
| `WorkflowGraphSaverTests.cs` | Create, replace, validation, concurrency |
| `GraphAssignmentResolverTests.cs` | The four assignment rules |
| `GraphSchemaEditorTests.cs` | New version, re-point, clear |
| `WorkflowGraphControllerTests.cs` | The two graph actions and the 409 handler |
| `src/tests/BaseApi.Tests/Live/WorkflowGraphLiveTests.cs` | Postgres: rollback, 409, FK ordering, assignments, schema re-point, layout round trip |

---

### Task 1: `Layout` column

**Files:**
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowEntity.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowEntityMapper.cs`
- Modify: `src/BaseApi.Service/Persistence/Configurations/WorkflowEntityConfiguration.cs`
- Create: `src/BaseApi.Service/Persistence/Migrations/<stamp>_AddWorkflowLayout.cs` (EF-generated, with Designer and snapshot)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowLayoutTests.cs`

**Interfaces:**
- Produces: `WorkflowEntity.Layout` (`string?`, column `layout`, `jsonb`, nullable).

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowLayoutTests.cs`:

```csharp
using BaseApi.Service;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// The workflow's canvas layout: positions only, opaque to the server, stored beside the workflow
/// row so a graph save can write it in the same commit as the graph it describes.
/// </summary>
public sealed class WorkflowLayoutTests
{
    private static AppDbContext NewContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"layout-{Guid.NewGuid():N}")
            .Options);

    [Fact]
    public void LayoutIsANullableJsonbColumn()
    {
        using var db = NewContext();
        var property = db.Model.FindEntityType(typeof(WorkflowEntity))!.FindProperty(nameof(WorkflowEntity.Layout))!;

        Assert.True(property.IsNullable);
        Assert.Equal("jsonb", property.GetColumnType());
    }

    [Fact]
    public void TheReadMapperDoesNotCarryTheLayout()
    {
        // Layout travels only through the layout and graph actions, never through CRUD.
        var read = new WorkflowEntityMapper().ToRead(new WorkflowEntity
        {
            Name = "wf", Version = "1.0.0", Layout = """{"nodes":{}}""",
        });

        Assert.DoesNotContain(typeof(WorkflowReadDto).GetProperties(),
            p => p.Name == nameof(WorkflowEntity.Layout));
        Assert.Equal("wf", read.Name);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `'WorkflowEntity' does not contain a definition for 'Layout'`.

- [ ] **Step 3: Add the property, the mapper ignores and the column type**

In `WorkflowEntity.cs`, after the `Diagram` property, add:

```csharp
    /// <summary>
    /// The SKP Studio canvas layout as JSON, or null when the workflow has never been laid out.
    /// <para>
    /// <b>Positions only, never graph facts.</b> It holds where the sphere, steps, caches, parked blocks
    /// and junctions are drawn. What exists is decided by the tables on every load; an id in here that
    /// no longer exists is ignored by the editor. The server treats it as opaque and checks only that
    /// it is a JSON object within the size cap (<see cref="Graph.WorkflowLayout"/>).
    /// </para>
    /// <para>
    /// Like <see cref="Diagram"/>, it is absent from every DTO and travels only through the dedicated
    /// layout and graph actions on <c>WorkflowsController</c>.
    /// </para>
    /// </summary>
    public string? Layout { get; set; }
```

In `WorkflowEntityMapper.cs`, add `[MapperIgnoreTarget(nameof(WorkflowEntity.Layout))]` directly under the existing `[MapperIgnoreTarget(nameof(WorkflowEntity.Diagram))]` on **both** `ToEntity` and `Update`, and add `[MapperIgnoreSource(nameof(WorkflowEntity.Layout))]` directly under the existing `[MapperIgnoreSource(nameof(WorkflowEntity.Diagram))]` on `ToRead`.

In `WorkflowEntityConfiguration.cs`, after the `Diagram` block, add:

```csharp
        // jsonb like Assignment.Payload: the layout is a JSON object, and storing it as jsonb makes
        // Postgres reject anything that is not JSON even if a caller bypasses the action's check.
        entity.Property(e => e.Layout)
            .HasColumnType("jsonb");
```

The `WorkflowLayout` cref in the doc comment refers to a class Task 2 creates. Until then, write it as `<c>WorkflowLayout</c>` instead of a `<see cref>`, and switch it to the cref in Task 2.

- [ ] **Step 4: Generate the migration**

```bash
dotnet ef migrations add AddWorkflowLayout \
  --project src/BaseApi.Service/BaseApi.Service.csproj \
  --output-dir Persistence/Migrations
```

Open the new `<stamp>_AddWorkflowLayout.cs` and confirm by eye that `Up` contains exactly one call:

```csharp
migrationBuilder.AddColumn<string>(
    name: "layout",
    table: "workflows",
    type: "jsonb",
    nullable: true);
```

and `Down` drops it. Any other `AlterColumn`/`DropIndex` means the model drifted: stop and investigate rather than hand-edit.

Then:

```bash
dotnet ef migrations has-pending-model-changes --project src/BaseApi.Service/BaseApi.Service.csproj
```

Expected: `No changes have been made to the model since the last migration.`

- [ ] **Step 5: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowLayoutTests"
```

Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/BaseApi.Service/Features/Workflow/WorkflowEntity.cs src/BaseApi.Service/Features/Workflow/WorkflowEntityMapper.cs src/BaseApi.Service/Persistence src/tests/BaseApi.Tests/WorkflowGraph/WorkflowLayoutTests.cs
git commit -m "feat(studio): nullable jsonb Layout column on workflows"
```

---

### Task 2: Layout rule and `GET`/`PUT /workflows/{id}/layout`

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/Graph/WorkflowLayout.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowController.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowEntity.cs` (switch the doc reference to `<see cref="Graph.WorkflowLayout"/>`)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowLayoutTests.cs`

**Interfaces:**
- Consumes: `WorkflowEntity.Layout` (Task 1).
- Produces:
  - `internal static class WorkflowLayout { internal const int MaxChars = 1_048_576; internal static string? Validate(JsonElement layout); }`: it returns an error message, or null when the layout is valid.
  - `WorkflowsController.GetLayout(Guid id, CancellationToken ct)`: 200 with `application/json` (the stored layout, or the JSON literal `null`), or 404.
  - `WorkflowsController.PutLayout(Guid id, JsonElement layout, CancellationToken ct)`: 204, 400 or 404.

- [ ] **Step 1: Write the failing tests**

Append to `WorkflowLayoutTests.cs` (add `using System.Text.Json;`, `using BaseApi.Service.Features.Workflow.Graph;`, `using BaseApi.Core.Persistence.Repositories;`, `using Microsoft.AspNetCore.Mvc;`):

```csharp
    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    [Fact]
    public void AnObjectWithinTheCapIsValid() =>
        Assert.Null(WorkflowLayout.Validate(Json("""{"nodes":{"a":{"x":8,"y":16}}}""")));

    [Theory]
    [InlineData("[]")]
    [InlineData("42")]
    [InlineData("\"text\"")]
    [InlineData("null")]
    public void ANonObjectIsRejected(string text) =>
        Assert.NotNull(WorkflowLayout.Validate(Json(text)));

    [Fact]
    public void AnObjectOverTheCapIsRejected()
    {
        var big = "{\"pad\":\"" + new string('x', WorkflowLayout.MaxChars) + "\"}";
        Assert.NotNull(WorkflowLayout.Validate(Json(big)));
    }

    private static (AppDbContext Db, WorkflowsController Controller) NewController()
    {
        var db = NewContext();
        var service = new WorkflowService(
            new WorkflowCreateDtoValidator(), new WorkflowUpdateDtoValidator(),
            new WorkflowEntityMapper(), new Repository<WorkflowEntity>(db), db);
        return (db, new WorkflowsController(service, db, graphReader: null!, graphSaver: null!));
    }

    [Fact]
    public async Task PutThenGetRoundTripsTheLayout()
    {
        var (db, controller) = NewController();
        var id = Guid.NewGuid();
        db.Add(new WorkflowEntity { Id = id, Name = "wf", Version = "1.0.0" });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var put = await controller.PutLayout(id, Json("""{"nodes":{"s1":{"x":8,"y":16}}}"""), TestContext.Current.CancellationToken);
        var get = await controller.GetLayout(id, TestContext.Current.CancellationToken);

        Assert.IsType<NoContentResult>(put);
        var content = Assert.IsType<ContentResult>(get);
        Assert.Equal("application/json", content.ContentType);
        Assert.Equal(16, JsonDocument.Parse(content.Content!).RootElement.GetProperty("nodes").GetProperty("s1").GetProperty("y").GetInt32());
    }

    [Fact]
    public async Task GetOnAWorkflowNeverLaidOutAnswersJsonNull()
    {
        var (db, controller) = NewController();
        var id = Guid.NewGuid();
        db.Add(new WorkflowEntity { Id = id, Name = "wf", Version = "1.0.0" });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        var content = Assert.IsType<ContentResult>(await controller.GetLayout(id, TestContext.Current.CancellationToken));
        Assert.Equal("null", content.Content);
    }

    [Fact]
    public async Task AMissingWorkflowIs404OnBothVerbs()
    {
        var (_, controller) = NewController();
        Assert.IsType<NotFoundResult>(await controller.GetLayout(Guid.NewGuid(), TestContext.Current.CancellationToken));
        Assert.IsType<NotFoundResult>(await controller.PutLayout(Guid.NewGuid(), Json("{}"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task PutRejectsANonObjectWith400()
    {
        var (db, controller) = NewController();
        var id = Guid.NewGuid();
        db.Add(new WorkflowEntity { Id = id, Name = "wf", Version = "1.0.0" });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        Assert.IsType<BadRequestObjectResult>(await controller.PutLayout(id, Json("[]"), TestContext.Current.CancellationToken));
    }
```

The controller constructor gains its two graph parameters in Task 8. For **this** task, add them now as optional so the tests compile: `IWorkflowGraphReader? graphReader = null, IWorkflowGraphSaver? graphSaver = null`. Task 8 makes them required. Their interfaces are created in Step 3 below.

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `The name 'WorkflowLayout' does not exist`.

- [ ] **Step 3: Implement the layout rule, the two interfaces' shells and the actions**

Create `src/BaseApi.Service/Features/Workflow/Graph/WorkflowLayout.cs`:

```csharp
using System.Text.Json;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// The one rule the server applies to a canvas layout. Everything else about it belongs to the
/// editor: the server never reads inside it, so a layout naming a step that no longer exists is not
/// an error here -- the editor ignores stale ids on load.
/// </summary>
internal static class WorkflowLayout
{
    /// <summary>The same cap as an assignment payload, roughly 1 MB.</summary>
    internal const int MaxChars = 1_048_576;

    /// <summary>Returns why the layout is unacceptable, or null when it is fine.</summary>
    internal static string? Validate(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object)
            return "Layout must be a JSON object.";

        if (layout.GetRawText().Length > MaxChars)
            return $"Layout must be at most {MaxChars} characters.";

        return null;
    }
}
```

Create `src/BaseApi.Service/Features/Workflow/Graph/IWorkflowGraphReader.cs` and `IWorkflowGraphSaver.cs` with the signatures Task 3 and Task 5 implement, so the controller compiles now:

```csharp
namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>Reads a workflow's whole graph for the editor.</summary>
public interface IWorkflowGraphReader
{
    /// <summary>The graph, or <see cref="BaseApi.Core.Exceptions.NotFoundException"/> when the workflow does not exist.</summary>
    Task<WorkflowGraphDto> ReadAsync(Guid workflowId, CancellationToken ct);
}
```

```csharp
namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>Creates or replaces a workflow's whole graph in one commit.</summary>
public interface IWorkflowGraphSaver
{
    /// <summary>Saves the graph and returns it re-read.</summary>
    Task<WorkflowGraphDto> SaveAsync(Guid workflowId, GraphSaveRequest request, CancellationToken ct);
}
```

Create `src/BaseApi.Service/Features/Workflow/Graph/WorkflowGraphDtos.cs` now as well (Task 3 relies on it unchanged):

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// The body of <c>PUT /workflows/{id}/graph</c>. Ids for a new workflow and new steps are generated
/// by the client, so the request can wire a new step to another new step before either exists.
/// </summary>
/// <param name="Workflow">The workflow fields, with the <c>UpdatedAt</c> the client loaded (null when creating).</param>
/// <param name="Steps">Only the new or changed steps; an untouched step is not sent.</param>
/// <param name="Assignments">At most one intent per step: a payload to set, or null to remove.</param>
/// <param name="SchemaEdits">Processor slot edits: a new definition, or null to clear the slot.</param>
/// <param name="Layout">The canvas layout; null leaves the stored layout unchanged.</param>
public sealed record GraphSaveRequest(
    GraphWorkflowDto Workflow,
    List<GraphStepDto>? Steps,
    List<GraphAssignmentIntent>? Assignments,
    List<GraphSchemaEdit>? SchemaEdits,
    JsonElement? Layout);

/// <summary>The workflow's own fields. Assignment ids are absent: the server derives them from the intents.</summary>
public sealed record GraphWorkflowDto(
    string Name,
    string Version,
    string? Description,
    string? CronExpression,
    DateTime? UpdatedAt,
    List<Guid> EntryStepIds,
    List<Guid>? CacheIds);

/// <summary>A new or changed step. <c>UpdatedAt</c> is null for a new step and the loaded value for a changed one.</summary>
public sealed record GraphStepDto(
    Guid Id,
    DateTime? UpdatedAt,
    string Name,
    string Version,
    string? Description,
    Guid ProcessorId,
    List<Guid>? NextStepIds,
    StepEntryCondition EntryCondition);

/// <summary>Set (<c>Payload</c> non-null) or remove (<c>Payload</c> null) this workflow's assignment for one step.</summary>
public sealed record GraphAssignmentIntent(Guid StepId, string? Payload);

/// <summary>
/// Replace one processor schema slot. <c>Slot</c> is <c>input</c>, <c>output</c> or <c>config</c>.
/// A non-null <c>Definition</c> always becomes a new schema row, because a referenced schema's
/// definition is frozen; null clears the slot.
/// </summary>
public sealed record GraphSchemaEdit(Guid ProcessorId, string Slot, string? Definition);

/// <summary>
/// A workflow's graph as the editor loads it: the workflow, every step reachable from its entry
/// steps, their processors and schemas, the workflow's assignments and caches, and its layout.
/// Parked steps (placed but unwired) are not reachable, so they are not here; the editor reads their
/// ids from the layout and fetches them through <c>GET /steps/{id}</c>.
/// </summary>
public sealed record WorkflowGraphDto(
    WorkflowReadDto Workflow,
    List<StepReadDto> Steps,
    List<ProcessorReadDto> Processors,
    List<SchemaReadDto> Schemas,
    List<AssignmentReadDto> Assignments,
    List<CacheReadDto> Caches,
    JsonElement? Layout);
```

In `WorkflowController.cs`:
- add `using System.Text.Json;` and `using BaseApi.Service.Features.Workflow.Graph;`;
- add fields `private readonly IWorkflowGraphReader? _graphReader; private readonly IWorkflowGraphSaver? _graphSaver;`;
- replace the constructor with:

```csharp
    public WorkflowsController(
        BaseService<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> service,
        AppDbContext db,
        IWorkflowGraphReader? graphReader = null,
        IWorkflowGraphSaver? graphSaver = null)
        : base(service)
    {
        _db = db;
        _graphReader = graphReader;
        _graphSaver = graphSaver;
    }
```

- add the two actions after `PutDiagram`:

```csharp
    /// <summary>
    /// Returns the workflow's canvas layout as JSON, or the JSON literal <c>null</c> when it has never
    /// been laid out. A missing workflow is 404, so "never laid out" stays distinguishable from a wrong id.
    /// </summary>
    [HttpGet("{id:guid}/layout")]
    [Produces("application/json")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetLayout(Guid id, CancellationToken ct)
    {
        var row = await _db.Set<WorkflowEntity>()
            .Where(w => w.Id == id)
            .Select(w => new { w.Layout })
            .FirstOrDefaultAsync(ct);

        if (row is null)
            return NotFound();

        return Content(row.Layout ?? "null", "application/json");
    }

    /// <summary>
    /// Stores the workflow's canvas layout. It moves blocks without touching the graph, so the editor
    /// can keep positions when nothing else changed. The graph save writes the layout too.
    /// </summary>
    [HttpPut("{id:guid}/layout")]
    [Consumes("application/json")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> PutLayout(Guid id, [FromBody] JsonElement layout, CancellationToken ct)
    {
        if (WorkflowLayout.Validate(layout) is { } error)
            return BadRequest(error);

        var workflow = await _db.Set<WorkflowEntity>().FirstOrDefaultAsync(w => w.Id == id, ct);
        if (workflow is null)
            return NotFound();

        workflow.Layout = layout.GetRawText();
        await _db.SaveChangesAsync(ct);
        return NoContent();
    }
```

In `WorkflowEntity.cs`, change the `<c>WorkflowLayout</c>` reference from Task 1 to `<see cref="Graph.WorkflowLayout"/>`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowLayoutTests"
```

Expected: 12 passed (2 + 1 + 4 + 1 + 4 test cases: the theory counts 4).

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Workflow src/tests/BaseApi.Tests/WorkflowGraph/WorkflowLayoutTests.cs
git commit -m "feat(studio): GET/PUT /workflows/{id}/layout and the graph DTOs"
```

---

### Task 3: Extract the junction sync into shared helpers

**Files:**
- Create: `src/BaseApi.Service/Features/Step/StepJunctions.cs`
- Create: `src/BaseApi.Service/Features/Workflow/WorkflowJunctions.cs`
- Modify: `src/BaseApi.Service/Features/Step/StepService.cs` (the body of `SyncJunctionsAsync`)
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowService.cs` (the body of `SyncJunctionsAsync`)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/JunctionHelperTests.cs`

**Interfaces:**
- Produces:
  - `internal static Task StepJunctions.SyncNextStepsAsync(BaseDbContext db, Guid stepId, IReadOnlyCollection<Guid>? nextStepIds, bool replaceExisting, CancellationToken ct)`
  - `internal static Task WorkflowJunctions.SyncAsync(BaseDbContext db, Guid workflowId, IReadOnlyCollection<Guid> entryStepIds, IReadOnlyCollection<Guid>? assignmentIds, IReadOnlyCollection<Guid>? cacheIds, bool replaceExisting, CancellationToken ct)`

These are behaviour-preserving moves. The existing `WorkflowReadEnrichmentTests`, `WorkflowCacheJunctionTests` and `StepReadEnrichmentTests` already pin what the services do; the new tests pin the helpers directly so the saver can rely on them.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/WorkflowGraph/JunctionHelperTests.cs`:

```csharp
using BaseApi.Service;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// The junction sync shared by the CRUD services and the graph saver. One implementation, so a
/// graph save and a plain PUT can never disagree about what "replace the wires" means.
/// </summary>
public sealed class JunctionHelperTests
{
    private static AppDbContext NewContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"junctions-{Guid.NewGuid():N}")
            .Options);

    [Fact]
    public async Task ReplacingNextStepsRemovesTheOldWiresAndAddsTheNew()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var db = NewContext();
        var step = Guid.NewGuid();
        var (a, b, c) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        db.AddRange(new StepNextSteps { StepId = step, NextStepId = a }, new StepNextSteps { StepId = step, NextStepId = b });
        await db.SaveChangesAsync(ct);

        await StepJunctions.SyncNextStepsAsync(db, step, [b, c], replaceExisting: true, ct);
        await db.SaveChangesAsync(ct);

        var now = await db.StepNextSteps.Where(j => j.StepId == step).Select(j => j.NextStepId).ToListAsync(ct);
        Assert.Equal(new[] { b, c }.OrderBy(x => x), now.OrderBy(x => x));
    }

    [Fact]
    public async Task WithoutReplaceTheExistingWiresAreLeftAlone()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var db = NewContext();
        var step = Guid.NewGuid();
        var (a, b) = (Guid.NewGuid(), Guid.NewGuid());
        db.Add(new StepNextSteps { StepId = step, NextStepId = a });
        await db.SaveChangesAsync(ct);

        await StepJunctions.SyncNextStepsAsync(db, step, [b], replaceExisting: false, ct);
        await db.SaveChangesAsync(ct);

        Assert.Equal(2, await db.StepNextSteps.CountAsync(j => j.StepId == step, ct));
    }

    [Fact]
    public async Task ReplacingTheWorkflowJunctionsReplacesAllThree()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var db = NewContext();
        var wf = Guid.NewGuid();
        var (oldEntry, newEntry, oldAsg, newCache) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        db.AddRange(
            new WorkflowEntrySteps { WorkflowId = wf, StepId = oldEntry },
            new WorkflowAssignments { WorkflowId = wf, AssignmentId = oldAsg });
        await db.SaveChangesAsync(ct);

        await WorkflowJunctions.SyncAsync(db, wf, [newEntry], assignmentIds: null, cacheIds: [newCache], replaceExisting: true, ct);
        await db.SaveChangesAsync(ct);

        Assert.Equal([newEntry], await db.WorkflowEntrySteps.Where(j => j.WorkflowId == wf).Select(j => j.StepId).ToListAsync(ct));
        Assert.Empty(await db.WorkflowAssignments.Where(j => j.WorkflowId == wf).ToListAsync(ct));
        Assert.Equal([newCache], await db.WorkflowCaches.Where(j => j.WorkflowId == wf).Select(j => j.CacheId).ToListAsync(ct));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `The name 'StepJunctions' does not exist`.

- [ ] **Step 3: Create the helpers and point the services at them**

Create `src/BaseApi.Service/Features/Step/StepJunctions.cs`:

```csharp
using BaseApi.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// The next-step junction sync, shared by <see cref="StepService"/> and the graph saver so a graph
/// save and a plain step PUT write wires the same way. Stages changes only; the caller saves.
/// </summary>
internal static class StepJunctions
{
    /// <summary>
    /// Stages the step's outgoing wires. With <paramref name="replaceExisting"/> every stored wire of
    /// the step is removed first (remove-and-replace, as on update); without it the new wires are
    /// only added (as on create, where none exist yet).
    /// </summary>
    internal static async Task SyncNextStepsAsync(
        BaseDbContext db,
        Guid stepId,
        IReadOnlyCollection<Guid>? nextStepIds,
        bool replaceExisting,
        CancellationToken ct)
    {
        var set = db.Set<StepNextSteps>();

        if (replaceExisting)
        {
            var existing = await set.Where(j => j.StepId == stepId).ToListAsync(ct);
            if (existing.Count > 0)
            {
                set.RemoveRange(existing);
            }
        }

        if (nextStepIds is { Count: > 0 })
        {
            await set.AddRangeAsync(
                nextStepIds.Select(nextId => new StepNextSteps { StepId = stepId, NextStepId = nextId }), ct);
        }
    }
}
```

Replace the body of `StepService.SyncJunctionsAsync` (keep its doc comment and signature) with:

```csharp
        => StepJunctions.SyncNextStepsAsync(
            DbContext,
            entity.Id,
            createDto?.NextStepIds ?? updateDto?.NextStepIds,
            replaceExisting: updateDto is not null,
            ct);
```

Remove the method's `async` keyword, since it now returns the helper's task directly. Remove `using Microsoft.EntityFrameworkCore;` only if nothing else in the file uses it. `EnrichReadAsync` still does, so it stays.

Create `src/BaseApi.Service/Features/Workflow/WorkflowJunctions.cs`:

```csharp
using BaseApi.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// The sync of a workflow's three junctions (entry steps, assignments, caches), shared by
/// <see cref="WorkflowService"/> and the graph saver. Stages changes only; the caller saves.
/// </summary>
internal static class WorkflowJunctions
{
    /// <summary>
    /// Stages the workflow's junction rows. With <paramref name="replaceExisting"/> every stored row
    /// on all three junctions is removed first, so the arguments are the complete final state.
    /// </summary>
    internal static async Task SyncAsync(
        BaseDbContext db,
        Guid workflowId,
        IReadOnlyCollection<Guid> entryStepIds,
        IReadOnlyCollection<Guid>? assignmentIds,
        IReadOnlyCollection<Guid>? cacheIds,
        bool replaceExisting,
        CancellationToken ct)
    {
        var entryStepsSet = db.Set<WorkflowEntrySteps>();
        var assignmentsSet = db.Set<WorkflowAssignments>();
        var cachesSet = db.Set<WorkflowCaches>();

        if (replaceExisting)
        {
            var existingEntrySteps = await entryStepsSet.Where(j => j.WorkflowId == workflowId).ToListAsync(ct);
            if (existingEntrySteps.Count > 0)
            {
                entryStepsSet.RemoveRange(existingEntrySteps);
            }

            var existingAssignments = await assignmentsSet.Where(j => j.WorkflowId == workflowId).ToListAsync(ct);
            if (existingAssignments.Count > 0)
            {
                assignmentsSet.RemoveRange(existingAssignments);
            }

            var existingCaches = await cachesSet.Where(j => j.WorkflowId == workflowId).ToListAsync(ct);
            if (existingCaches.Count > 0)
            {
                cachesSet.RemoveRange(existingCaches);
            }
        }

        if (entryStepIds.Count > 0)
        {
            await entryStepsSet.AddRangeAsync(
                entryStepIds.Select(stepId => new WorkflowEntrySteps { WorkflowId = workflowId, StepId = stepId }), ct);
        }

        if (assignmentIds is { Count: > 0 })
        {
            await assignmentsSet.AddRangeAsync(
                assignmentIds.Select(id => new WorkflowAssignments { WorkflowId = workflowId, AssignmentId = id }), ct);
        }

        if (cacheIds is { Count: > 0 })
        {
            await cachesSet.AddRangeAsync(
                cacheIds.Select(id => new WorkflowCaches { WorkflowId = workflowId, CacheId = id }), ct);
        }
    }
}
```

Replace the body of `WorkflowService.SyncJunctionsAsync` (keep its doc comment and signature, drop `async`) with:

```csharp
        => WorkflowJunctions.SyncAsync(
            DbContext,
            entity.Id,
            createDto?.EntryStepIds ?? updateDto?.EntryStepIds ?? new List<Guid>(),
            createDto?.AssignmentIds ?? updateDto?.AssignmentIds,
            createDto?.CacheIds ?? updateDto?.CacheIds,
            replaceExisting: updateDto is not null,
            ct);
```

- [ ] **Step 4: Run the new tests and the services' existing tests**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.JunctionHelperTests" --filter-class "BaseApi.Tests.Orchestration.WorkflowReadEnrichmentTests" --filter-class "BaseApi.Tests.Orchestration.StepReadEnrichmentTests" --filter-class "BaseApi.Tests.Cache.WorkflowCacheJunctionTests"
```

Expected: all pass, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Step src/BaseApi.Service/Features/Workflow src/tests/BaseApi.Tests/WorkflowGraph/JunctionHelperTests.cs
git commit -m "refactor(baseapi): share the step and workflow junction sync through static helpers"
```

---

### Task 4: Test harness and `GET /workflows/{id}/graph` reader

**Files:**
- Create: `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs`
- Create: `src/BaseApi.Service/Features/Workflow/Graph/WorkflowGraphReader.cs`
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowGraphReaderTests.cs`

**Interfaces:**
- Consumes: `IWorkflowGraphReader`, `WorkflowGraphDto` (Task 2); `IWorkflowGraphLoader.LoadL1Async(IReadOnlyList<Guid>, CancellationToken)` (existing, internal).
- Produces:
  - `internal sealed class WorkflowGraphReader(BaseDbContext db, IWorkflowGraphLoader loader) : IWorkflowGraphReader`
  - test helper `GraphHarness` with `Db`, `Clock`, `Reader`, and the seeding helpers `SchemaAsync`, `ProcessorAsync`, `StepAsync`, `WorkflowAsync`, `AssignmentAsync`, which later tasks add to.

- [ ] **Step 1: Write the harness and the failing tests**

Create `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs`:

```csharp
using BaseApi.Core.Persistence.Interceptors;
using BaseApi.Service;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// An InMemory context with the real audit interceptor on a fake clock, so <c>UpdatedAt</c> moves
/// exactly as it does in production and the concurrency tests can step time deliberately. InMemory
/// enforces no foreign keys and no transactions; what depends on Postgres is proven by
/// <c>WorkflowGraphLiveTests</c>.
/// </summary>
internal sealed class GraphHarness : IAsyncDisposable
{
    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 10, 5, 12, 0, 0, TimeSpan.Zero));
    public AppDbContext Db { get; }
    public IWorkflowGraphReader Reader { get; }

    public GraphHarness()
    {
        Db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"graph-{Guid.NewGuid():N}")
            .AddInterceptors(new AuditInterceptor(new HttpContextAccessor(), Clock))
            .Options);

        var loader = new WorkflowGraphLoader(
            Db, NullLogger<WorkflowGraphSnapshot>.Instance,
            new SchemaEntityMapper(), new ProcessorEntityMapper(), new StepEntityMapper(),
            new AssignmentEntityMapper(), new WorkflowEntityMapper(), new CacheEntityMapper());
        Reader = new WorkflowGraphReader(Db, loader);
    }

    public CancellationToken Ct => Xunit.TestContext.Current.CancellationToken;

    /// <summary>Moves the clock a second, so the next save stamps a later UpdatedAt.</summary>
    public void Tick() => Clock.Advance(TimeSpan.FromSeconds(1));

    public async Task<Guid> SchemaAsync(string name = "schema", string version = "1.0.0", string definition = """{"type":"object"}""")
    {
        var s = new SchemaEntity { Id = Guid.NewGuid(), Name = name, Version = version, Definition = definition };
        Db.Add(s);
        await Db.SaveChangesAsync(Ct);
        return s.Id;
    }

    public async Task<Guid> ProcessorAsync(string name = "proc", Guid? input = null, Guid? output = null, Guid? config = null)
    {
        var p = new ProcessorEntity
        {
            Id = Guid.NewGuid(), Name = name, Version = "1.0.0", SourceHash = Guid.NewGuid().ToString("N"),
            InputSchemaId = input, OutputSchemaId = output, ConfigSchemaId = config,
        };
        Db.Add(p);
        await Db.SaveChangesAsync(Ct);
        return p.Id;
    }

    public async Task<Guid> StepAsync(Guid processorId, string name = "step", params Guid[] next)
    {
        var s = new StepEntity
        {
            Id = Guid.NewGuid(), Name = name, Version = "1.0.0", ProcessorId = processorId,
            EntryCondition = StepEntryCondition.PreviousCompleted,
        };
        Db.Add(s);
        foreach (var n in next) Db.Add(new StepNextSteps { StepId = s.Id, NextStepId = n });
        await Db.SaveChangesAsync(Ct);
        return s.Id;
    }

    public async Task<Guid> WorkflowAsync(string name, Guid[] entry, Guid[]? assignments = null, string? layout = null)
    {
        var w = new WorkflowEntity { Id = Guid.NewGuid(), Name = name, Version = "1.0.0", Layout = layout };
        Db.Add(w);
        foreach (var e in entry) Db.Add(new WorkflowEntrySteps { WorkflowId = w.Id, StepId = e });
        foreach (var a in assignments ?? []) Db.Add(new WorkflowAssignments { WorkflowId = w.Id, AssignmentId = a });
        await Db.SaveChangesAsync(Ct);
        return w.Id;
    }

    public async Task<Guid> AssignmentAsync(Guid stepId, string payload = """{"k":1}""")
    {
        var a = new AssignmentEntity { Id = Guid.NewGuid(), Name = "asg", Version = "1.0.0", StepId = stepId, Payload = payload };
        Db.Add(a);
        await Db.SaveChangesAsync(Ct);
        return a.Id;
    }

    /// <summary>Forgets every tracked entity, so the next read sees the store rather than the tracker.</summary>
    public void Forget() => Db.ChangeTracker.Clear();

    public ValueTask DisposeAsync() => Db.DisposeAsync();
}
```

Create `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowGraphReaderTests.cs`:

```csharp
using BaseApi.Core.Exceptions;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class WorkflowGraphReaderTests
{
    [Fact]
    public async Task ReadsTheReachableStepsTheirProcessorsSchemasAndTheLayout()
    {
        await using var h = new GraphHarness();
        var outSchema = await h.SchemaAsync("out");
        var proc = await h.ProcessorAsync("p", output: outSchema);
        var tail = await h.StepAsync(proc, "tail");
        var head = await h.StepAsync(proc, "head", tail);
        var parked = await h.StepAsync(proc, "parked");
        var asg = await h.AssignmentAsync(head);
        var wf = await h.WorkflowAsync("wf", [head], [asg], layout: """{"parked":["x"]}""");

        var graph = await h.Reader.ReadAsync(wf, h.Ct);

        Assert.Equal(wf, graph.Workflow.Id);
        Assert.Equal([head], graph.Workflow.EntryStepIds!);
        Assert.Equal(new[] { head, tail }.OrderBy(x => x), graph.Steps.Select(s => s.Id).OrderBy(x => x));
        Assert.DoesNotContain(graph.Steps, s => s.Id == parked);
        Assert.Equal([tail], graph.Steps.Single(s => s.Id == head).NextStepIds!);
        Assert.Equal([proc], graph.Processors.Select(p => p.Id));
        Assert.Equal([outSchema], graph.Schemas.Select(s => s.Id));
        Assert.Equal([asg], graph.Assignments.Select(a => a.Id));
        Assert.Equal("x", graph.Layout!.Value.GetProperty("parked")[0].GetString());
    }

    [Fact]
    public async Task AWorkflowNeverLaidOutHasANullLayout()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        Assert.Null((await h.Reader.ReadAsync(wf, h.Ct)).Layout);
    }

    [Fact]
    public async Task AMissingWorkflowIsNotFound()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<NotFoundException>(() => h.Reader.ReadAsync(Guid.NewGuid(), h.Ct));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `The type or namespace name 'WorkflowGraphReader' could not be found`.

- [ ] **Step 3: Implement the reader**

Create `src/BaseApi.Service/Features/Workflow/Graph/WorkflowGraphReader.cs`:

```csharp
using System.Text.Json;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Loading;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Reads a workflow's graph through the same <see cref="IWorkflowGraphLoader"/> the orchestrator's
/// start path uses, so the editor sees exactly the step set a start would see: everything reachable
/// from the entry steps over the next-step junction. Adds the layout, which the loader does not read.
/// </summary>
internal sealed class WorkflowGraphReader : IWorkflowGraphReader
{
    private readonly BaseDbContext _db;
    private readonly IWorkflowGraphLoader _loader;

    public WorkflowGraphReader(BaseDbContext db, IWorkflowGraphLoader loader)
    {
        _db = db ?? throw new ArgumentNullException(nameof(db));
        _loader = loader ?? throw new ArgumentNullException(nameof(loader));
    }

    public async Task<WorkflowGraphDto> ReadAsync(Guid workflowId, CancellationToken ct)
    {
        var row = await _db.Set<WorkflowEntity>().AsNoTracking()
            .Where(w => w.Id == workflowId)
            .Select(w => new { w.Layout })
            .FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException(nameof(WorkflowEntity), workflowId);

        JsonElement? layout = null;
        if (row.Layout is not null)
        {
            using var doc = JsonDocument.Parse(row.Layout);
            layout = doc.RootElement.Clone();
        }

        // The snapshot clears itself on dispose, so everything is copied out before it goes.
        using var snapshot = await _loader.LoadL1Async([workflowId], ct);

        return new WorkflowGraphDto(
            snapshot.Workflows[workflowId],
            snapshot.Steps.Values.OrderBy(s => s.Name, StringComparer.Ordinal).ThenBy(s => s.Id).ToList(),
            snapshot.Processors.Values.OrderBy(p => p.Name, StringComparer.Ordinal).ThenBy(p => p.Id).ToList(),
            snapshot.Schemas.Values.OrderBy(s => s.Name, StringComparer.Ordinal).ThenBy(s => s.Id).ToList(),
            snapshot.Assignments.Values.OrderBy(a => a.StepId).ThenBy(a => a.Id).ToList(),
            snapshot.Caches.Values.OrderBy(c => c.Name, StringComparer.Ordinal).ThenBy(c => c.Id).ToList(),
            layout);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowGraphReaderTests"
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Workflow/Graph/WorkflowGraphReader.cs src/tests/BaseApi.Tests/WorkflowGraph
git commit -m "feat(studio): workflow graph reader over the orchestration loader"
```

---

### Task 5: Graph saver: create, replace, validation and concurrency

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/Graph/GraphConflictException.cs`
- Create: `src/BaseApi.Service/Features/Workflow/Graph/WorkflowGraphSaver.cs`
- Modify: `src/tests/BaseApi.Tests/WorkflowGraph/GraphHarness.cs` (add `Saver`)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowGraphSaverTests.cs`

**Interfaces:**
- Consumes: `IWorkflowGraphSaver`, the request DTOs (Task 2); `StepJunctions`, `WorkflowJunctions` (Task 3); `IWorkflowGraphReader` (Task 4).
- Produces:
  - `public sealed class GraphConflictException(string kind, Guid id) : Exception` with `Kind` and `Id` properties. `kind` is `"workflow"` or `"step"`.
  - `internal sealed class WorkflowGraphSaver : IWorkflowGraphSaver` with constructor `(BaseDbContext db, IWorkflowGraphReader reader, IValidator<WorkflowUpdateDto> workflowValidator, IValidator<StepCreateDto> stepCreateValidator, IValidator<StepUpdateDto> stepUpdateValidator, IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> workflowMapper, IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> stepMapper, GraphAssignmentResolver assignments, GraphSchemaEditor schemas)`.

  `GraphAssignmentResolver` and `GraphSchemaEditor` are built in Tasks 6 and 7. In **this** task, create them as minimal classes so the saver compiles and assignments and schema edits are no-ops:

  ```csharp
  internal sealed class GraphAssignmentResolver
  {
      public GraphAssignmentResolver(BaseDbContext db, IValidator<AssignmentCreateDto> payloadValidator) { }
      public Task<List<Guid>> ResolveAsync(Guid workflowId, string workflowName, IReadOnlyList<GraphAssignmentIntent> intents, CancellationToken ct)
          => throw new NotImplementedException("Task 6");
  }
  internal sealed class GraphSchemaEditor
  {
      public GraphSchemaEditor(BaseDbContext db, IValidator<SchemaCreateDto> schemaValidator) { }
      public Task ApplyAsync(IReadOnlyList<GraphSchemaEdit> edits, CancellationToken ct) => Task.CompletedTask;
  }
  ```

  The saver in this task must therefore not call `ResolveAsync` when the request has no intents. It computes the workflow's assignment set as "unchanged" (its current links) when `Assignments` is null or empty, which is the final behaviour anyway.

- [ ] **Step 1: Extend the harness and write the failing tests**

In `GraphHarness`, add this property:

```csharp
    public IWorkflowGraphSaver Saver { get; }
```

and at the end of the constructor:

```csharp
        Saver = new WorkflowGraphSaver(
            Db, Reader,
            new WorkflowUpdateDtoValidator(),
            new StepCreateDtoValidator(), new StepUpdateDtoValidator(),
            new WorkflowEntityMapper(), new StepEntityMapper(),
            new GraphAssignmentResolver(Db, new AssignmentCreateDtoValidator()),
            new GraphSchemaEditor(Db, new SchemaCreateDtoValidator()));
```

Add a request builder to the harness:

```csharp
    public static GraphSaveRequest Request(
        Guid[] entry,
        DateTime? workflowUpdatedAt = null,
        GraphStepDto[]? steps = null,
        GraphAssignmentIntent[]? assignments = null,
        GraphSchemaEdit[]? schemaEdits = null,
        string? layout = null,
        string name = "wf") =>
        new(new GraphWorkflowDto(name, "1.0.0", null, null, workflowUpdatedAt, entry.ToList(), null),
            steps?.ToList(), assignments?.ToList(), schemaEdits?.ToList(),
            layout is null ? null : System.Text.Json.JsonDocument.Parse(layout).RootElement.Clone());

    public static GraphStepDto NewStep(Guid id, Guid processorId, string name = "step", params Guid[] next) =>
        new(id, null, name, "1.0.0", null, processorId, next.ToList(), StepEntryCondition.PreviousCompleted);
```

Create `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowGraphSaverTests.cs`:

```csharp
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class WorkflowGraphSaverTests
{
    [Fact]
    public async Task CreatesANewWorkflowWithClientIdsAndWiresBetweenNewSteps()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());

        var graph = await h.Saver.SaveAsync(wf, GraphHarness.Request(
            entry: [a],
            steps: [GraphHarness.NewStep(a, proc, "a", b), GraphHarness.NewStep(b, proc, "b")],
            layout: """{"nodes":{}}"""), h.Ct);

        Assert.Equal(wf, graph.Workflow.Id);
        Assert.Equal(new[] { a, b }.OrderBy(x => x), graph.Steps.Select(s => s.Id).OrderBy(x => x));
        Assert.Equal([b], graph.Steps.Single(s => s.Id == a).NextStepIds!);
        Assert.True(graph.Layout!.Value.TryGetProperty("nodes", out _));
    }

    [Fact]
    public async Task ReplacingRewiresAChangedStepAndKeepsUntouchedSteps()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var c = await h.StepAsync(proc, "c");
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var aLoaded = loaded.Steps.Single(s => s.Id == a);
        h.Forget();

        // a -> b becomes a -> c. b is untouched, so it is not sent.
        var graph = await h.Saver.SaveAsync(wf, GraphHarness.Request(
            entry: [a],
            workflowUpdatedAt: loaded.Workflow.UpdatedAt,
            steps: [new GraphStepDto(a, aLoaded.UpdatedAt, "a", "1.0.0", null, proc, [c], StepEntryCondition.PreviousCompleted)]), h.Ct);

        Assert.Equal([c], graph.Steps.Single(s => s.Id == a).NextStepIds!);
        Assert.True(await h.Db.Steps.AnyAsync(s => s.Id == b, h.Ct), "unlinking never deletes the step row");
    }

    [Fact]
    public async Task ALayoutOfNullLeavesTheStoredLayoutAlone()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step], layout: """{"keep":true}""");
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var graph = await h.Saver.SaveAsync(wf, GraphHarness.Request([step], loaded.Workflow.UpdatedAt), h.Ct);

        Assert.True(graph.Layout!.Value.GetProperty("keep").GetBoolean());
    }

    [Fact]
    public async Task NoEntryStepIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request(entry: []), h.Ct));
    }

    [Fact]
    public async Task AnEntryConditionOfZeroIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = Guid.NewGuid();
        var bad = new GraphStepDto(a, null, "a", "1.0.0", null, proc, null, StepEntryCondition.PreviousProcessing);

        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([a], steps: [bad]), h.Ct));
    }

    [Fact]
    public async Task ANonObjectLayoutIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([step], layout: "[]"), h.Ct));
    }

    [Fact]
    public async Task TheSameStepTwiceInOneRequestIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = Guid.NewGuid();
        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([a],
                steps: [GraphHarness.NewStep(a, proc), GraphHarness.NewStep(a, proc)]), h.Ct));
    }

    [Fact]
    public async Task AStaleWorkflowIsAConflictNamingTheWorkflow()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);

        // Someone else saves after we loaded.
        h.Tick();
        var row = await h.Db.Workflows.SingleAsync(w => w.Id == wf, h.Ct);
        row.Description = "changed elsewhere";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var ex = await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(wf, GraphHarness.Request([step], loaded.Workflow.UpdatedAt), h.Ct));
        Assert.Equal(("workflow", wf), (ex.Kind, ex.Id));
    }

    [Fact]
    public async Task AStaleChangedStepIsAConflictNamingTheStep()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var step = await h.StepAsync(proc, "s");
        var wf = await h.WorkflowAsync("wf", [step]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stepLoaded = loaded.Steps.Single();

        h.Tick();
        var row = await h.Db.Steps.SingleAsync(s => s.Id == step, h.Ct);
        row.Description = "changed elsewhere";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var ex = await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(wf, GraphHarness.Request([step], loaded.Workflow.UpdatedAt,
                steps: [new GraphStepDto(step, stepLoaded.UpdatedAt, "s2", "1.0.0", null, proc, null, StepEntryCondition.PreviousCompleted)]), h.Ct));
        Assert.Equal(("step", step), (ex.Kind, ex.Id));
    }

    [Fact]
    public async Task ANewStepWhoseIdAlreadyExistsIsAConflict()
    {
        // Review focus 1: a retried save, or two tabs creating the same step.
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var existing = await h.StepAsync(proc);
        h.Forget();

        var ex = await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([existing],
                steps: [GraphHarness.NewStep(existing, proc)]), h.Ct));
        Assert.Equal(("step", existing), (ex.Kind, ex.Id));
        Assert.Equal(0, await h.Db.Workflows.CountAsync(h.Ct));
    }

    [Fact]
    public async Task CreatingOverAnExistingWorkflowWithoutItsUpdatedAtIsAConflict()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);
        h.Forget();

        var ex = await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(wf, GraphHarness.Request([step], workflowUpdatedAt: null), h.Ct));
        Assert.Equal(("workflow", wf), (ex.Kind, ex.Id));
    }

    [Fact]
    public async Task NothingIsWrittenWhenTheConflictIsFound()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var existing = await h.StepAsync(proc);
        h.Forget();
        var fresh = Guid.NewGuid();

        await Assert.ThrowsAsync<GraphConflictException>(() =>
            h.Saver.SaveAsync(Guid.NewGuid(), GraphHarness.Request([fresh],
                steps: [GraphHarness.NewStep(fresh, proc), GraphHarness.NewStep(existing, proc)]), h.Ct));
        h.Forget();

        Assert.False(await h.Db.Steps.AnyAsync(s => s.Id == fresh, h.Ct));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `The type or namespace name 'WorkflowGraphSaver' could not be found`.

- [ ] **Step 3: Implement the exception and the saver**

Create `src/BaseApi.Service/Features/Workflow/Graph/GraphConflictException.cs`:

```csharp
namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// A graph save carried an <c>updatedAt</c> older than the stored row (or claimed a row was new when
/// it already exists), so applying it would silently overwrite someone else's change. Becomes a 409
/// that names the entity, so the editor can say what went stale.
/// </summary>
public sealed class GraphConflictException : Exception
{
    /// <summary><c>workflow</c> or <c>step</c>.</summary>
    public string Kind { get; }

    public Guid Id { get; }

    public GraphConflictException(string kind, Guid id)
        : base($"The {kind} '{id}' was changed since it was loaded.")
    {
        Kind = kind;
        Id = id;
    }
}
```

Create `src/BaseApi.Service/Features/Workflow/Graph/WorkflowGraphSaver.cs`. Put the two placeholder classes from the Interfaces block above in their own files, `GraphAssignmentResolver.cs` and `GraphSchemaEditor.cs`, in the same folder and namespace, with `using BaseApi.Core.Persistence; using BaseApi.Service.Features.Assignment; using BaseApi.Service.Features.Schema; using FluentValidation;`.

```csharp
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Step;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Creates or replaces a workflow's whole graph in one commit, in the spec's order: validate,
/// check concurrency, apply schema edits, write steps, resolve assignments, write the workflow and
/// its layout, then one <c>SaveChangesAsync</c>.
/// <para>
/// <b>One save, not a transaction around several.</b> EF orders the inserts and deletes of a
/// single save by the foreign keys in the model -- step rows before the wires between them, a new
/// schema before the processor that points at it, a junction delete before the orphaned assignment
/// -- which is what the spec's "rows, then wires" two passes need, and a single save is atomic. A
/// Postgres FK violation therefore rolls back everything and surfaces as the existing 422.
/// </para>
/// <para>
/// <b>Nothing here judges the design.</b> No cycle, schema-edge, payload or liveness check: those
/// are start checks. The validators run only the field rules the CRUD endpoints already enforce.
/// </para>
/// </summary>
internal sealed class WorkflowGraphSaver : IWorkflowGraphSaver
{
    private readonly BaseDbContext _db;
    private readonly IWorkflowGraphReader _reader;
    private readonly IValidator<WorkflowUpdateDto> _workflowValidator;
    private readonly IValidator<StepCreateDto> _stepCreateValidator;
    private readonly IValidator<StepUpdateDto> _stepUpdateValidator;
    private readonly IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> _workflowMapper;
    private readonly IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> _stepMapper;
    private readonly GraphAssignmentResolver _assignments;
    private readonly GraphSchemaEditor _schemas;

    public WorkflowGraphSaver(
        BaseDbContext db,
        IWorkflowGraphReader reader,
        IValidator<WorkflowUpdateDto> workflowValidator,
        IValidator<StepCreateDto> stepCreateValidator,
        IValidator<StepUpdateDto> stepUpdateValidator,
        IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> workflowMapper,
        IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> stepMapper,
        GraphAssignmentResolver assignments,
        GraphSchemaEditor schemas)
    {
        _db = db;
        _reader = reader;
        _workflowValidator = workflowValidator;
        _stepCreateValidator = stepCreateValidator;
        _stepUpdateValidator = stepUpdateValidator;
        _workflowMapper = workflowMapper;
        _stepMapper = stepMapper;
        _assignments = assignments;
        _schemas = schemas;
    }

    public async Task<WorkflowGraphDto> SaveAsync(Guid workflowId, GraphSaveRequest request, CancellationToken ct)
    {
        var wf = request.Workflow;
        var steps = request.Steps ?? [];
        var intents = request.Assignments ?? [];
        var edits = request.SchemaEdits ?? [];

        // ---- 1. Validate: the request's own shape, then the existing validators. -----------------
        var failures = new List<ValidationFailure>();

        if (request.Layout is { } layout && WorkflowLayout.Validate(layout) is { } layoutError)
            failures.Add(new ValidationFailure(nameof(GraphSaveRequest.Layout), layoutError));

        if (steps.Select(s => s.Id).Distinct().Count() != steps.Count)
            failures.Add(new ValidationFailure(nameof(GraphSaveRequest.Steps), "Each step may appear once."));

        if (steps.Any(s => s.Id == Guid.Empty))
            failures.Add(new ValidationFailure(nameof(GraphSaveRequest.Steps), "A step id must not be Guid.Empty."));

        if (intents.Select(i => i.StepId).Distinct().Count() != intents.Count)
            failures.Add(new ValidationFailure(nameof(GraphSaveRequest.Assignments), "Each step may have one assignment intent."));

        var workflowDto = new WorkflowUpdateDto(
            wf.Name, wf.Version, wf.Description, wf.EntryStepIds, null, wf.CacheIds, wf.CronExpression);
        failures.AddRange((await _workflowValidator.ValidateAsync(workflowDto, ct)).Errors);

        var stepIds = steps.Select(s => s.Id).ToList();
        var storedSteps = await _db.Set<StepEntity>()
            .Where(s => stepIds.Contains(s.Id))
            .ToDictionaryAsync(s => s.Id, ct);

        foreach (var s in steps)
        {
            var result = storedSteps.ContainsKey(s.Id)
                ? await _stepUpdateValidator.ValidateAsync(ToUpdate(s), ct)
                : await _stepCreateValidator.ValidateAsync(ToCreate(s), ct);
            failures.AddRange(result.Errors.Select(e =>
                new ValidationFailure($"Steps[{s.Id}].{e.PropertyName}", e.ErrorMessage)));
        }

        if (failures.Count > 0)
            throw new ValidationException(failures);

        // ---- 2. Concurrency: 409 before anything is staged. --------------------------------------
        var storedWorkflow = await _db.Set<WorkflowEntity>().FirstOrDefaultAsync(w => w.Id == workflowId, ct);

        if (storedWorkflow is null ? wf.UpdatedAt is not null : IsStale(storedWorkflow.UpdatedAt, wf.UpdatedAt))
            throw new GraphConflictException("workflow", workflowId);

        foreach (var s in steps)
        {
            var stale = storedSteps.TryGetValue(s.Id, out var stored)
                ? IsStale(stored.UpdatedAt, s.UpdatedAt)
                : s.UpdatedAt is not null;     // claimed to exist, but it is gone
            if (stale)
                throw new GraphConflictException("step", s.Id);
        }

        // ---- 3. Schema edits: a new schema row, then re-point the slot. --------------------------
        await _schemas.ApplyAsync(edits, ct);

        // ---- 4. Steps: rows and wires, ordered by EF at save time. -------------------------------
        foreach (var s in steps)
        {
            if (storedSteps.TryGetValue(s.Id, out var stored))
            {
                _stepMapper.Update(ToUpdate(s), stored);
                await StepJunctions.SyncNextStepsAsync(_db, s.Id, s.NextStepIds, replaceExisting: true, ct);
            }
            else
            {
                var entity = _stepMapper.ToEntity(ToCreate(s));
                entity.Id = s.Id;
                _db.Add(entity);
                await StepJunctions.SyncNextStepsAsync(_db, s.Id, s.NextStepIds, replaceExisting: false, ct);
            }
        }

        // ---- 5. Assignments: the workflow's final assignment set. --------------------------------
        List<Guid> assignmentIds = intents.Count > 0
            ? await _assignments.ResolveAsync(workflowId, wf.Name, intents, ct)
            : await _db.Set<WorkflowAssignments>()
                .Where(j => j.WorkflowId == workflowId)
                .Select(j => j.AssignmentId)
                .ToListAsync(ct);

        // ---- 6. The workflow row, its junctions and its layout, then one save. -------------------
        if (storedWorkflow is null)
        {
            storedWorkflow = _workflowMapper.ToEntity(new WorkflowCreateDto(
                wf.Name, wf.Version, wf.Description, wf.EntryStepIds, assignmentIds, wf.CacheIds, wf.CronExpression));
            storedWorkflow.Id = workflowId;
            _db.Add(storedWorkflow);
        }
        else
        {
            _workflowMapper.Update(workflowDto with { AssignmentIds = assignmentIds }, storedWorkflow);
        }

        if (request.Layout is { } newLayout)
            storedWorkflow.Layout = newLayout.GetRawText();

        await WorkflowJunctions.SyncAsync(
            _db, workflowId, wf.EntryStepIds, assignmentIds, wf.CacheIds,
            replaceExisting: _db.Entry(storedWorkflow).State != EntityState.Added, ct);

        await _db.SaveChangesAsync(ct);

        return await _reader.ReadAsync(workflowId, ct);
    }

    /// <summary>Stale when the stored row is newer than what the client loaded, or the client sent no stamp.</summary>
    private static bool IsStale(DateTime stored, DateTime? loaded) => loaded is null || stored > loaded.Value;

    private static StepCreateDto ToCreate(GraphStepDto s) =>
        new(s.Name, s.Version, s.Description, s.ProcessorId, s.NextStepIds, s.EntryCondition);

    private static StepUpdateDto ToUpdate(GraphStepDto s) =>
        new(s.Name, s.Version, s.Description, s.ProcessorId, s.NextStepIds, s.EntryCondition);
}
```

A stored `UpdatedAt` from Npgsql and one parsed from JSON both carry `DateTimeKind.Utc`, so `>` compares like with like. A client that round-trips the value it read sends back exactly the stored microseconds.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowGraphSaverTests"
```

Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Workflow/Graph src/tests/BaseApi.Tests/WorkflowGraph
git commit -m "feat(studio): atomic graph saver with validation and updatedAt concurrency"
```

---

### Task 6: Assignment resolution

**Files:**
- Modify: `src/BaseApi.Service/Features/Workflow/Graph/GraphAssignmentResolver.cs` (replace the placeholder)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/GraphAssignmentResolverTests.cs`

**Interfaces:**
- Consumes: the saver's call `ResolveAsync(workflowId, workflowName, intents, ct)` (Task 5).
- Produces: `Task<List<Guid>> GraphAssignmentResolver.ResolveAsync(Guid workflowId, string workflowName, IReadOnlyList<GraphAssignmentIntent> intents, CancellationToken ct)`. It returns the workflow's **complete** final assignment-id set: links for steps without an intent are kept unchanged.

The rules (spec section 4.2, step 5). For each intent on step S, R is the workflow's currently linked assignments whose `StepId == S`:

| Intent | R | Result |
|---|---|---|
| payload | empty | create a row (`Name` = `"{workflow} / {step}"`, at most 200 characters; `Version` = `1.0.0`) and link it |
| payload | one row, linked only by this workflow | update its payload in place |
| payload | one row, also linked by another workflow | create a copy (the same Name, Version and Description, the new payload), unlink the original, link the copy |
| null | any | unlink every row in R; delete each one no other workflow links |

If R holds more than one row (legacy data), the first by `Id` is the one the rule applies to, and the rest are treated as "null" (unlinked, and deleted if orphaned), which restores at most one.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/WorkflowGraph/GraphAssignmentResolverTests.cs`:

```csharp
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class GraphAssignmentResolverTests
{
    private static async Task<(GraphHarness H, Guid Proc, Guid Step)> SetupAsync()
    {
        var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var step = await h.StepAsync(proc, "fetch");
        return (h, proc, step);
    }

    private static async Task<WorkflowGraphDto> SaveAsync(GraphHarness h, Guid wf, Guid entry, params GraphAssignmentIntent[] intents)
    {
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        return await h.Saver.SaveAsync(wf, GraphHarness.Request([entry], loaded.Workflow.UpdatedAt, assignments: intents), h.Ct);
    }

    [Fact]
    public async Task APayloadForAnUnassignedStepCreatesAndLinksARow()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var wf = await h.WorkflowAsync("orders", [step]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, """{"url":"x"}"""));

        var asg = Assert.Single(graph.Assignments);
        Assert.Equal(step, asg.StepId);
        Assert.Equal("orders / fetch", asg.Name);
        Assert.Equal("1.0.0", asg.Version);
        Assert.Contains("\"url\"", asg.Payload);
    }

    [Fact]
    public async Task APayloadForARowOnlyThisWorkflowUsesUpdatesItInPlace()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var asg = await h.AssignmentAsync(step, """{"v":1}""");
        var wf = await h.WorkflowAsync("orders", [step], [asg]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, """{"v":2}"""));

        var only = Assert.Single(graph.Assignments);
        Assert.Equal(asg, only.Id);
        Assert.Contains("2", only.Payload);
    }

    [Fact]
    public async Task APayloadForASharedRowCopiesItAndLeavesTheOtherWorkflowAlone()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var shared = await h.AssignmentAsync(step, """{"v":1}""");
        var mine = await h.WorkflowAsync("mine", [step], [shared]);
        var theirs = await h.WorkflowAsync("theirs", [step], [shared]);

        var graph = await SaveAsync(h, mine, step, new GraphAssignmentIntent(step, """{"v":2}"""));

        var copy = Assert.Single(graph.Assignments);
        Assert.NotEqual(shared, copy.Id);
        Assert.Contains("2", copy.Payload);
        h.Forget();
        var theirGraph = await h.Reader.ReadAsync(theirs, h.Ct);
        Assert.Equal(shared, Assert.Single(theirGraph.Assignments).Id);
        Assert.Contains("1", theirGraph.Assignments[0].Payload);
    }

    [Fact]
    public async Task ANullIntentUnlinksAndDeletesAnOrphanedRow()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var asg = await h.AssignmentAsync(step);
        var wf = await h.WorkflowAsync("orders", [step], [asg]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, null));

        Assert.Empty(graph.Assignments);
        h.Forget();
        Assert.False(await h.Db.Assignments.AnyAsync(a => a.Id == asg, h.Ct));
    }

    [Fact]
    public async Task ANullIntentOnASharedRowUnlinksButKeepsTheRow()
    {
        // Review focus 3.
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var shared = await h.AssignmentAsync(step);
        var mine = await h.WorkflowAsync("mine", [step], [shared]);
        await h.WorkflowAsync("theirs", [step], [shared]);

        var graph = await SaveAsync(h, mine, step, new GraphAssignmentIntent(step, null));

        Assert.Empty(graph.Assignments);
        h.Forget();
        Assert.True(await h.Db.Assignments.AnyAsync(a => a.Id == shared, h.Ct));
    }

    [Fact]
    public async Task LinksForStepsWithoutAnIntentAreKept()
    {
        var (h, proc, step) = await SetupAsync();
        await using var _h = h;
        var other = await h.StepAsync(proc, "other");
        var keep = await h.AssignmentAsync(other);
        var wf = await h.WorkflowAsync("orders", [step], [keep]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, """{"v":1}"""));

        Assert.Contains(graph.Workflow.AssignmentIds!, id => id == keep);
        Assert.Equal(2, graph.Workflow.AssignmentIds!.Count);
    }

    [Fact]
    public async Task AnIntentForAStepCreatedInTheSameRequestLands()
    {
        // Review focus 2. InMemory proves the staging; WorkflowGraphLiveTests proves the FK order.
        var (h, proc, _) = await SetupAsync();
        await using var _h = h;
        var (wf, fresh) = (Guid.NewGuid(), Guid.NewGuid());

        var graph = await h.Saver.SaveAsync(wf, GraphHarness.Request([fresh],
            steps: [GraphHarness.NewStep(fresh, proc, "fresh")],
            assignments: [new GraphAssignmentIntent(fresh, """{"v":1}""")]), h.Ct);

        Assert.Equal(fresh, Assert.Single(graph.Assignments).StepId);
    }

    [Fact]
    public async Task AnInvalidJsonPayloadIsAValidationFailure()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var wf = await h.WorkflowAsync("orders", [step]);

        await Assert.ThrowsAsync<ValidationException>(() =>
            SaveAsync(h, wf, step, new GraphAssignmentIntent(step, "{not json")));
    }

    [Fact]
    public async Task DuplicateLegacyRowsCollapseToOne()
    {
        var (h, _, step) = await SetupAsync();
        await using var _h = h;
        var first = await h.AssignmentAsync(step, """{"v":1}""");
        var second = await h.AssignmentAsync(step, """{"v":1}""");
        var wf = await h.WorkflowAsync("orders", [step], [first, second]);

        var graph = await SaveAsync(h, wf, step, new GraphAssignmentIntent(step, """{"v":2}"""));

        Assert.Single(graph.Assignments);
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.GraphAssignmentResolverTests"
```

Expected: all 9 fail with `NotImplementedException: Task 6`, because every test sends at least one intent.

- [ ] **Step 3: Implement the resolver**

Replace `GraphAssignmentResolver.cs` with:

```csharp
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Step;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Turns per-step assignment intents into the workflow's final assignment set, applying the rules
/// the editor hides from the user: an assignment is edited per (workflow, step), but a row may be
/// linked by several workflows, so editing a shared row must not change the others.
/// Stages changes only; the saver saves.
/// </summary>
internal sealed class GraphAssignmentResolver
{
    private const int MaxNameLength = 200;

    private readonly BaseDbContext _db;
    private readonly IValidator<AssignmentCreateDto> _payloadValidator;

    public GraphAssignmentResolver(BaseDbContext db, IValidator<AssignmentCreateDto> payloadValidator)
    {
        _db = db;
        _payloadValidator = payloadValidator;
    }

    public async Task<List<Guid>> ResolveAsync(
        Guid workflowId, string workflowName, IReadOnlyList<GraphAssignmentIntent> intents, CancellationToken ct)
    {
        // The payload rules (non-empty, at most 1 MB, parses as JSON) are the CRUD validator's.
        var failures = new List<ValidationFailure>();
        foreach (var intent in intents.Where(i => i.Payload is not null))
        {
            var probe = new AssignmentCreateDto("validation", "1.0.0", null, intent.StepId, intent.Payload!);
            failures.AddRange((await _payloadValidator.ValidateAsync(probe, ct)).Errors.Select(e =>
                new ValidationFailure($"Assignments[{intent.StepId}].{e.PropertyName}", e.ErrorMessage)));
        }
        if (failures.Count > 0)
            throw new ValidationException(failures);

        var linkedIds = await _db.Set<WorkflowAssignments>()
            .Where(j => j.WorkflowId == workflowId)
            .Select(j => j.AssignmentId)
            .ToListAsync(ct);

        var linked = await _db.Set<AssignmentEntity>()
            .Where(a => linkedIds.Contains(a.Id))
            .OrderBy(a => a.Id)
            .ToListAsync(ct);

        var final = linkedIds.ToHashSet();

        foreach (var intent in intents)
        {
            var current = linked.Where(a => a.StepId == intent.StepId).ToList();
            var target = intent.Payload is null ? null : current.FirstOrDefault();

            // Everything for this step except the row the intent keeps is unlinked, and deleted when
            // no other workflow still links it. This also collapses legacy duplicates to one.
            foreach (var row in current.Where(r => r != target))
            {
                final.Remove(row.Id);
                if (!await IsLinkedElsewhereAsync(row.Id, workflowId, ct))
                    _db.Remove(row);
            }

            if (intent.Payload is null)
                continue;

            if (target is null)
            {
                var created = new AssignmentEntity
                {
                    Id = Guid.NewGuid(),
                    StepId = intent.StepId,
                    Name = await NameAsync(workflowName, intent.StepId, ct),
                    Version = "1.0.0",
                    Payload = intent.Payload,
                };
                _db.Add(created);
                final.Add(created.Id);
            }
            else if (await IsLinkedElsewhereAsync(target.Id, workflowId, ct))
            {
                var copy = new AssignmentEntity
                {
                    Id = Guid.NewGuid(),
                    StepId = target.StepId,
                    Name = target.Name,
                    Version = target.Version,
                    Description = target.Description,
                    Payload = intent.Payload,
                };
                _db.Add(copy);
                final.Remove(target.Id);
                final.Add(copy.Id);
            }
            else
            {
                target.Payload = intent.Payload;
            }
        }

        return final.ToList();
    }

    private Task<bool> IsLinkedElsewhereAsync(Guid assignmentId, Guid workflowId, CancellationToken ct) =>
        _db.Set<WorkflowAssignments>().AnyAsync(j => j.AssignmentId == assignmentId && j.WorkflowId != workflowId, ct);

    /// <summary><c>"{workflow} / {step}"</c>; FindAsync also sees a step staged earlier in this same save.</summary>
    private async Task<string> NameAsync(string workflowName, Guid stepId, CancellationToken ct)
    {
        var step = await _db.Set<StepEntity>().FindAsync([stepId], ct);
        var name = $"{workflowName} / {step?.Name ?? stepId.ToString("N")}";
        return name.Length <= MaxNameLength ? name : name[..MaxNameLength];
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.GraphAssignmentResolverTests" --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowGraphSaverTests"
```

Expected: 9 + 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Workflow/Graph/GraphAssignmentResolver.cs src/tests/BaseApi.Tests/WorkflowGraph/GraphAssignmentResolverTests.cs
git commit -m "feat(studio): graph save resolves assignments per (workflow, step)"
```

---

### Task 7: Processor schema edits

**Files:**
- Modify: `src/BaseApi.Service/Features/Workflow/Graph/GraphSchemaEditor.cs` (replace the placeholder)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/GraphSchemaEditorTests.cs`

**Interfaces:**
- Consumes: the saver's call `ApplyAsync(edits, ct)` (Task 5).
- Produces: `Task GraphSchemaEditor.ApplyAsync(IReadOnlyList<GraphSchemaEdit> edits, CancellationToken ct)`, which throws `ValidationException` for a bad slot or definition and `NotFoundException` for a missing processor.

Rules: a non-null `Definition` always becomes a **new** schema row, because a referenced definition is frozen. The new row's `Name` is the current slot schema's name, or `"{processor}-{slot}"` when the slot is empty (at most 200 characters). Its `Version` is the current version with the patch number bumped, or `1.0.0` when the slot is empty or the version is not `a.b.c`. Its `Description` is copied. The processor slot is re-pointed to the new row. A null `Definition` sets the slot to null. The old schema row is never deleted; other processors may use it.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/WorkflowGraph/GraphSchemaEditorTests.cs`:

```csharp
using BaseApi.Core.Exceptions;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class GraphSchemaEditorTests
{
    private const string NewDefinition = """{"type":"object","required":["id"]}""";

    private static async Task<(GraphHarness H, Guid Wf, Guid Proc, Guid Step, Guid OldSchema)> SetupAsync()
    {
        var h = new GraphHarness();
        var old = await h.SchemaAsync("orders-out", "1.4.2");
        var proc = await h.ProcessorAsync("fetcher", output: old);
        var step = await h.StepAsync(proc);
        var wf = await h.WorkflowAsync("wf", [step]);
        return (h, wf, proc, step, old);
    }

    private static async Task<WorkflowGraphDto> SaveAsync(GraphHarness h, Guid wf, Guid entry, params GraphSchemaEdit[] edits)
    {
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        return await h.Saver.SaveAsync(wf, GraphHarness.Request([entry], loaded.Workflow.UpdatedAt, schemaEdits: edits), h.Ct);
    }

    [Fact]
    public async Task AnEditCreatesANewVersionAndRepointsTheSlot()
    {
        var (h, wf, proc, step, old) = await SetupAsync();
        await using var _h = h;

        var graph = await SaveAsync(h, wf, step, new GraphSchemaEdit(proc, "output", NewDefinition));

        var p = Assert.Single(graph.Processors);
        Assert.NotEqual(old, p.OutputSchemaId);
        var fresh = graph.Schemas.Single(s => s.Id == p.OutputSchemaId);
        Assert.Equal("orders-out", fresh.Name);
        Assert.Equal("1.4.3", fresh.Version);
        Assert.True(await h.Db.Schemas.AnyAsync(s => s.Id == old, h.Ct), "the old version is kept for other processors");
    }

    [Fact]
    public async Task AnEditOnAnEmptySlotNamesTheSchemaAfterTheProcessor()
    {
        // Review focus 4.
        var (h, wf, proc, step, _) = await SetupAsync();
        await using var _h = h;

        var graph = await SaveAsync(h, wf, step, new GraphSchemaEdit(proc, "config", NewDefinition));

        var fresh = graph.Schemas.Single(s => s.Id == graph.Processors[0].ConfigSchemaId);
        Assert.Equal("fetcher-config", fresh.Name);
        Assert.Equal("1.0.0", fresh.Version);
    }

    [Fact]
    public async Task ANullDefinitionClearsTheSlot()
    {
        var (h, wf, proc, step, _) = await SetupAsync();
        await using var _h = h;

        var graph = await SaveAsync(h, wf, step, new GraphSchemaEdit(proc, "output", null));

        Assert.Null(graph.Processors[0].OutputSchemaId);
    }

    [Theory]
    [InlineData("inbound", NewDefinition)]
    [InlineData("output", "{not json")]
    [InlineData("output", """{"type":42}""")]
    public async Task ABadSlotOrDefinitionIsAValidationFailure(string slot, string definition)
    {
        var (h, wf, proc, step, _) = await SetupAsync();
        await using var _h = h;

        await Assert.ThrowsAsync<ValidationException>(() =>
            SaveAsync(h, wf, step, new GraphSchemaEdit(proc, slot, definition)));
    }

    [Fact]
    public async Task AMissingProcessorIsNotFound()
    {
        var (h, wf, _, step, _) = await SetupAsync();
        await using var _h = h;

        await Assert.ThrowsAsync<NotFoundException>(() =>
            SaveAsync(h, wf, step, new GraphSchemaEdit(Guid.NewGuid(), "output", NewDefinition)));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.GraphSchemaEditorTests"
```

Expected: FAIL. The placeholder ignores edits, so the slot assertions fail and no exception is thrown.

- [ ] **Step 3: Implement the editor**

Replace `GraphSchemaEditor.cs` with:

```csharp
using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Applies processor schema-slot edits. A referenced schema's definition is frozen
/// (<see cref="SchemaService.UpdateAsync"/> answers 409), so an edit never updates a schema: it
/// inserts a new version and re-points the slot. Running replicas keep the schema they started with
/// until they restart; each workflow re-checks its own wires when the editor loads it.
/// Stages changes only; the saver saves.
/// </summary>
internal sealed class GraphSchemaEditor
{
    private const int MaxNameLength = 200;
    private static readonly string[] Slots = ["input", "output", "config"];

    private readonly BaseDbContext _db;
    private readonly IValidator<SchemaCreateDto> _schemaValidator;

    public GraphSchemaEditor(BaseDbContext db, IValidator<SchemaCreateDto> schemaValidator)
    {
        _db = db;
        _schemaValidator = schemaValidator;
    }

    public async Task ApplyAsync(IReadOnlyList<GraphSchemaEdit> edits, CancellationToken ct)
    {
        var failures = new List<ValidationFailure>();
        foreach (var edit in edits)
        {
            if (!Slots.Contains(edit.Slot))
            {
                failures.Add(new ValidationFailure($"SchemaEdits[{edit.ProcessorId}].Slot",
                    "Slot must be input, output or config."));
                continue;
            }
            if (edit.Definition is null)
                continue;

            // The definition rules (JSON, a valid draft 2020-12 schema) are the CRUD validator's.
            var probe = new SchemaCreateDto("validation", "1.0.0", null, edit.Definition);
            failures.AddRange((await _schemaValidator.ValidateAsync(probe, ct)).Errors.Select(e =>
                new ValidationFailure($"SchemaEdits[{edit.ProcessorId}].{e.PropertyName}", e.ErrorMessage)));
        }
        if (failures.Count > 0)
            throw new ValidationException(failures);

        foreach (var edit in edits)
        {
            var processor = await _db.Set<ProcessorEntity>().FirstOrDefaultAsync(p => p.Id == edit.ProcessorId, ct)
                ?? throw new NotFoundException(nameof(ProcessorEntity), edit.ProcessorId);

            if (edit.Definition is null)
            {
                SetSlot(processor, edit.Slot, null);
                continue;
            }

            var currentId = GetSlot(processor, edit.Slot);
            var current = currentId is { } id
                ? await _db.Set<SchemaEntity>().AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct)
                : null;

            var name = current?.Name ?? $"{processor.Name}-{edit.Slot}";
            var schema = new SchemaEntity
            {
                Id = Guid.NewGuid(),
                Name = name.Length <= MaxNameLength ? name : name[..MaxNameLength],
                Version = current is null ? "1.0.0" : BumpPatch(current.Version),
                Description = current?.Description,
                Definition = edit.Definition,
            };
            _db.Add(schema);
            SetSlot(processor, edit.Slot, schema.Id);
        }
    }

    private static Guid? GetSlot(ProcessorEntity p, string slot) => slot switch
    {
        "input" => p.InputSchemaId,
        "output" => p.OutputSchemaId,
        _ => p.ConfigSchemaId,
    };

    private static void SetSlot(ProcessorEntity p, string slot, Guid? schemaId)
    {
        switch (slot)
        {
            case "input": p.InputSchemaId = schemaId; break;
            case "output": p.OutputSchemaId = schemaId; break;
            default: p.ConfigSchemaId = schemaId; break;
        }
    }

    /// <summary><c>a.b.c</c> becomes <c>a.b.(c+1)</c>; anything else restarts at <c>1.0.0</c>.</summary>
    private static string BumpPatch(string version)
    {
        var parts = version.Split('.');
        return parts.Length == 3
               && int.TryParse(parts[0], out var major)
               && int.TryParse(parts[1], out var minor)
               && int.TryParse(parts[2], out var patch)
            ? $"{major}.{minor}.{patch + 1}"
            : "1.0.0";
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.GraphSchemaEditorTests"
```

Expected: 7 passed (the theory counts 3).

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Workflow/Graph/GraphSchemaEditor.cs src/tests/BaseApi.Tests/WorkflowGraph/GraphSchemaEditorTests.cs
git commit -m "feat(studio): graph save versions processor schemas and re-points the slot"
```

---

### Task 8: Graph actions, 409 handler and registration

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/Graph/GraphConflictExceptionHandler.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowController.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowServiceCollectionExtensions.cs`
- Modify: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowLayoutTests.cs` (the constructor call)
- Test: `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowGraphControllerTests.cs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `GET /api/v1/workflows/{id}/graph`: 200 `WorkflowGraphDto`, or 404.
  - `PUT /api/v1/workflows/{id}/graph`: 200 `WorkflowGraphDto`; 400 on validation; 404 for a missing processor; **409** `{ title: "Graph is stale", kind, id }` on a stale row; 409 (generic) when `xmin` catches a race; 422 on an FK violation.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/WorkflowGraph/WorkflowGraphControllerTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Graph;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class WorkflowGraphControllerTests
{
    private static WorkflowsController Controller(GraphHarness h) =>
        new(new WorkflowService(
                new WorkflowCreateDtoValidator(), new WorkflowUpdateDtoValidator(),
                new WorkflowEntityMapper(), new Repository<WorkflowEntity>(h.Db), h.Db),
            h.Db, h.Reader, h.Saver);

    [Fact]
    public async Task GetGraphReturnsTheGraph()
    {
        await using var h = new GraphHarness();
        var step = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [step]);

        var ok = Assert.IsType<OkObjectResult>(await Controller(h).GetGraph(wf, h.Ct));
        Assert.Equal(wf, Assert.IsType<WorkflowGraphDto>(ok.Value).Workflow.Id);
    }

    [Fact]
    public async Task PutGraphReturnsTheSavedGraph()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());

        var ok = Assert.IsType<OkObjectResult>(await Controller(h).PutGraph(wf,
            GraphHarness.Request([a], steps: [GraphHarness.NewStep(a, proc)]), h.Ct));
        Assert.Equal([a], Assert.IsType<WorkflowGraphDto>(ok.Value).Workflow.EntryStepIds!);
    }

    [Fact]
    public async Task TheConflictHandlerWritesA409NamingTheEntity()
    {
        var services = new ServiceCollection().AddProblemDetails().BuildServiceProvider();
        var http = new DefaultHttpContext { RequestServices = services };
        http.Response.Body = new MemoryStream();
        var handler = new GraphConflictExceptionHandler(services.GetRequiredService<IProblemDetailsService>());
        var id = Guid.NewGuid();

        var handled = await handler.TryHandleAsync(http, new GraphConflictException("step", id), CancellationToken.None);

        Assert.True(handled);
        Assert.Equal(StatusCodes.Status409Conflict, http.Response.StatusCode);
        http.Response.Body.Position = 0;
        var body = await JsonDocument.ParseAsync(http.Response.Body);
        Assert.Equal("step", body.RootElement.GetProperty("kind").GetString());
        Assert.Equal(id, body.RootElement.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task TheConflictHandlerIgnoresOtherExceptions()
    {
        var services = new ServiceCollection().AddProblemDetails().BuildServiceProvider();
        var handler = new GraphConflictExceptionHandler(services.GetRequiredService<IProblemDetailsService>());

        Assert.False(await handler.TryHandleAsync(new DefaultHttpContext(), new InvalidOperationException(), CancellationToken.None));
    }
}
```

In `WorkflowLayoutTests.NewController`, the constructor call becomes `new WorkflowsController(service, db, graphReader: null!, graphSaver: null!)`. It already compiles against the final signature once Step 3 makes the parameters required.

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`
Expected: build error `'WorkflowsController' does not contain a definition for 'GetGraph'`.

- [ ] **Step 3: Implement the handler, the actions and the registration**

Create `src/BaseApi.Service/Features/Workflow/Graph/GraphConflictExceptionHandler.cs`:

```csharp
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Turns <see cref="GraphConflictException"/> into a 409 that names the stale entity, so the editor
/// can tell the user which workflow or step changed under them. The detail carries only the kind
/// and id the caller itself sent.
/// </summary>
public sealed class GraphConflictExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _pdSvc;

    public GraphConflictExceptionHandler(IProblemDetailsService pdSvc) => _pdSvc = pdSvc;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not GraphConflictException ex) return false;  // bail fast

        httpContext.Response.StatusCode = StatusCodes.Status409Conflict;

        var problem = new ProblemDetails
        {
            Status = StatusCodes.Status409Conflict,
            Title = "Graph is stale",
            Detail = $"The {ex.Kind} '{ex.Id}' was changed since it was loaded. Reload the workflow and re-apply your edits.",
        };
        problem.Extensions["kind"] = ex.Kind;
        problem.Extensions["id"] = ex.Id;

        return await _pdSvc.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
            Exception = exception,
        });
    }
}
```

In `WorkflowController.cs`, make the two graph parameters required and non-nullable:

```csharp
    private readonly IWorkflowGraphReader _graphReader;
    private readonly IWorkflowGraphSaver _graphSaver;

    public WorkflowsController(
        BaseService<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> service,
        AppDbContext db,
        IWorkflowGraphReader graphReader,
        IWorkflowGraphSaver graphSaver)
        : base(service)
    {
        _db = db;
        _graphReader = graphReader;
        _graphSaver = graphSaver;
    }
```

and add the two actions after `PutLayout`:

```csharp
    /// <summary>
    /// The workflow's graph for the editor: the steps reachable from its entry steps, their
    /// processors and schemas, its assignments and caches, and its layout.
    /// </summary>
    [HttpGet("{id:guid}/graph")]
    [ProducesResponseType(typeof(WorkflowGraphDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetGraph(Guid id, CancellationToken ct)
        => Ok(await _graphReader.ReadAsync(id, ct));

    /// <summary>
    /// Creates or replaces the workflow's whole graph in one commit and returns it re-read. The
    /// editor never blocks a design, so this checks field rules and staleness only; cycles, broken
    /// wires and payload-vs-schema are start checks.
    /// </summary>
    [HttpPut("{id:guid}/graph")]
    [ProducesResponseType(typeof(WorkflowGraphDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    [ProducesResponseType(StatusCodes.Status422UnprocessableEntity)]
    public async Task<IActionResult> PutGraph(Guid id, [FromBody] GraphSaveRequest request, CancellationToken ct)
        => Ok(await _graphSaver.SaveAsync(id, request, ct));
```

Update the controller's class doc comment: the paragraph "These two actions take the AppDbContext directly" now applies to the diagram **and layout** actions, and add one sentence saying the graph actions delegate to `IWorkflowGraphReader` / `IWorkflowGraphSaver`.

In `WorkflowServiceCollectionExtensions.AddWorkflowFeature`, before `return services;`, add (with `using BaseApi.Service.Features.Workflow.Graph;`):

```csharp
        // The SKP Studio graph endpoints. IWorkflowGraphLoader comes from AddOrchestrationFeature.
        services.AddScoped<IWorkflowGraphReader, WorkflowGraphReader>();
        services.AddScoped<GraphAssignmentResolver>();
        services.AddScoped<GraphSchemaEditor>();
        services.AddScoped<IWorkflowGraphSaver, WorkflowGraphSaver>();

        // Runs via AddAppFeatures, so it lands after the core handlers and before the catch-all.
        services.AddExceptionHandler<GraphConflictExceptionHandler>();
```

- [ ] **Step 4: Run the new tests, then the full hermetic suite**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.WorkflowGraph.WorkflowGraphControllerTests"
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 4 passed, then the full suite reports 0 failed.

The hermetic tests construct the controller by hand, so they cannot catch a missing DI registration. Task 9's deployment does: an unresolvable `WorkflowsController` fails every workflow request, and the live tests fail on their first call.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Features/Workflow src/tests/BaseApi.Tests/WorkflowGraph
git commit -m "feat(studio): GET/PUT /workflows/{id}/graph and the stale-graph 409"
```

---

### Task 9: Postgres proof (RealStack)

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/WorkflowGraphLiveTests.cs`

**Interfaces:**
- Consumes: the deployed endpoints from Task 8; `RealStack.SkipUnlessEnabled()`, `RealStack.BaseApiUrl`, `RealStack.Category`.

These are what InMemory cannot prove: FK ordering inside one save, the rollback, and the real 422.

- [ ] **Step 1: Write the live tests**

Create `src/tests/BaseApi.Tests/Live/WorkflowGraphLiveTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The graph save against the real Postgres: what EF InMemory cannot show, because it has no
/// foreign keys and no transactions. Each test builds its own rows and removes them afterwards.
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class WorkflowGraphLiveTests : IAsyncLifetime
{
    private readonly HttpClient _http = new() { BaseAddress = new Uri(RealStack.BaseApiUrl), Timeout = TimeSpan.FromSeconds(20) };
    private readonly List<string> _cleanup = [];
    private Guid _processor;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled) return;
        var hash = Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();
        _processor = await PostAsync("processors", new { SourceHash = hash, Name = $"graph-live-{Guid.NewGuid():N}", Version = "1.0.0" });
    }

    public async ValueTask DisposeAsync()
    {
        // Best effort, in FK order. Workflows cascade their own junction rows. Assignments go next,
        // because they restrict their step. A step's wires restrict BOTH ends (step_next_steps has no
        // cascade), so every step is unwired before any is deleted. Schemas go last, because the
        // processor slot pointing at them was cleared by the test itself.
        static int Rank(string p) => p.StartsWith("workflows") ? 0 : p.StartsWith("assignments") ? 1 : p.StartsWith("steps") ? 2 : 3;
        var ordered = _cleanup.OrderBy(Rank).ToList();

        foreach (var path in ordered.Where(p => Rank(p) < 2))
        {
            try { await _http.DeleteAsync($"/api/v1/{path}"); } catch (HttpRequestException) { }
        }
        foreach (var path in ordered.Where(p => Rank(p) == 2))
        {
            try
            {
                using var get = await _http.GetAsync($"/api/v1/{path}");
                if (!get.IsSuccessStatusCode) continue;
                var s = JsonDocument.Parse(await get.Content.ReadAsStringAsync()).RootElement;
                await _http.PutAsJsonAsync($"/api/v1/{path}", new
                {
                    name = s.GetProperty("name").GetString(), version = s.GetProperty("version").GetString(),
                    description = (string?)null, processorId = s.GetProperty("processorId").GetGuid(),
                    nextStepIds = Array.Empty<Guid>(), entryCondition = s.GetProperty("entryCondition").GetInt32(),
                });
            }
            catch (HttpRequestException) { }
        }
        foreach (var path in ordered.Where(p => Rank(p) >= 2))
        {
            try { await _http.DeleteAsync($"/api/v1/{path}"); } catch (HttpRequestException) { }
        }
        if (_processor != Guid.Empty)
        {
            try { await _http.DeleteAsync($"/api/v1/processors/{_processor}"); } catch (HttpRequestException) { }
        }
        _http.Dispose();
    }

    private async Task<Guid> PostAsync(string resource, object body)
    {
        using var response = await _http.PostAsJsonAsync($"/api/v1/{resource}", body, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.IsSuccessStatusCode, $"POST {resource} -> {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.GetProperty("id").GetGuid();
    }

    private static object Step(Guid id, Guid processor, string? updatedAt = null, params Guid[] next) => new
    {
        id, updatedAt, name = $"s-{id:N}"[..12], version = "1.0.0", description = (string?)null,
        processorId = processor, nextStepIds = next, entryCondition = 1,
    };

    private static object Body(string? updatedAt, Guid[] entry, object[]? steps = null, object[]? assignments = null,
        object[]? schemaEdits = null, object? layout = null) => new
    {
        workflow = new { name = $"graph-live-{Guid.NewGuid():N}"[..24], version = "1.0.0", description = (string?)null,
            cronExpression = (string?)null, updatedAt, entryStepIds = entry, cacheIds = Array.Empty<Guid>() },
        steps, assignments, schemaEdits, layout,
    };

    private async Task<(HttpStatusCode Status, JsonElement Body)> PutGraphAsync(Guid wf, object body)
    {
        using var response = await _http.PutAsJsonAsync($"/api/v1/workflows/{wf}/graph", body, Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        return (response.StatusCode, text.Length == 0 ? default : JsonDocument.Parse(text).RootElement.Clone());
    }

    private void Track(Guid wf, params Guid[] steps)
    {
        _cleanup.Add($"workflows/{wf}");
        _cleanup.AddRange(steps.Select(s => $"steps/{s}"));
    }

    [Fact]
    public async Task NewStepsWiredToEachOtherAndAnAssignmentLandInOneSave()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a, b);

        var (status, graph) = await PutGraphAsync(wf, Body(null, [a],
            steps: [Step(a, _processor, null, b), Step(b, _processor)],
            assignments: [new { stepId = b, payload = """{"v":1}""" }],
            layout: new { nodes = new { } }));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(2, graph.GetProperty("steps").GetArrayLength());
        var asg = graph.GetProperty("assignments")[0];
        _cleanup.Add($"assignments/{asg.GetProperty("id").GetGuid()}");
        Assert.Equal(b, asg.GetProperty("stepId").GetGuid());
    }

    [Fact]
    public async Task AnFkViolationRollsBackTheWholeSave()
    {
        // Review focus 5: the new step b points at a processor that does not exist.
        RealStack.SkipUnlessEnabled();
        var (wf, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a, b);

        var (status, _) = await PutGraphAsync(wf, Body(null, [a],
            steps: [Step(a, _processor, null, b), Step(b, Guid.NewGuid())],
            layout: new { nodes = new { } }));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, status);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/steps/{a}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync($"/api/v1/workflows/{wf}", Ct)).StatusCode);
    }

    [Fact]
    public async Task AStaleWorkflowIs409AndNamesIt()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a);
        var (_, first) = await PutGraphAsync(wf, Body(null, [a], steps: [Step(a, _processor)]));
        var loadedAt = first.GetProperty("workflow").GetProperty("updatedAt").GetString();

        // A second save moves updatedAt on; replaying the first stamp is now stale.
        var (ok, _) = await PutGraphAsync(wf, Body(loadedAt, [a]));
        var (status, problem) = await PutGraphAsync(wf, Body(loadedAt, [a]));

        Assert.Equal(HttpStatusCode.OK, ok);
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("workflow", problem.GetProperty("kind").GetString());
        Assert.Equal(wf, problem.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task ASchemaEditInsertsAVersionAndRepointsTheSlot()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a);
        var (_, first) = await PutGraphAsync(wf, Body(null, [a], steps: [Step(a, _processor)]));
        var loadedAt = first.GetProperty("workflow").GetProperty("updatedAt").GetString();

        var (status, graph) = await PutGraphAsync(wf, Body(loadedAt, [a],
            schemaEdits: [new { processorId = _processor, slot = "config", definition = """{"type":"object"}""" }]));

        Assert.Equal(HttpStatusCode.OK, status);
        var configId = graph.GetProperty("processors")[0].GetProperty("configSchemaId").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await _http.GetAsync($"/api/v1/schemas/{configId}", Ct)).StatusCode);

        // Leave the processor deletable: clear the slot, then remove the schema.
        var reloaded = graph.GetProperty("workflow").GetProperty("updatedAt").GetString();
        await PutGraphAsync(wf, Body(reloaded, [a], schemaEdits: [new { processorId = _processor, slot = "config", definition = (string?)null }]));
        _cleanup.Add($"schemas/{configId}");
    }

    [Fact]
    public async Task TheLayoutRoundTripsThroughBothEndpoints()
    {
        RealStack.SkipUnlessEnabled();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());
        Track(wf, a);
        await PutGraphAsync(wf, Body(null, [a], steps: [Step(a, _processor)], layout: new { nodes = new { s = new { x = 8, y = 16 } } }));

        using var put = await _http.PutAsJsonAsync($"/api/v1/workflows/{wf}/layout", new { nodes = new { s = new { x = 24, y = 16 } } }, Ct);
        var layout = JsonDocument.Parse(await _http.GetStringAsync($"/api/v1/workflows/{wf}/layout", Ct)).RootElement;

        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);
        Assert.Equal(24, layout.GetProperty("nodes").GetProperty("s").GetProperty("x").GetInt32());
    }
}
```

- [ ] **Step 2: Build, deploy and run the live tests**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .
kind load docker-image baseapi-service:local
kubectl -n skp rollout restart deploy/baseapi-service
kubectl -n skp rollout status deploy/baseapi-service
```

In a separate PowerShell window, run `k8s/port-forward-realstack.ps1` and leave it running. Then:

```bash
SKP_REALSTACK=1 src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Live.WorkflowGraphLiveTests"
```

Expected: 5 passed. The pod applies the `AddWorkflowLayout` migration on startup; if `rollout status` stalls, `kubectl -n skp logs deploy/baseapi-service` shows the migration error.

- [ ] **Step 3: Run the full hermetic suite once more**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed.

- [ ] **Step 4: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/WorkflowGraphLiveTests.cs
git commit -m "test(studio): graph save against Postgres -- FK order, rollback, 409, schema re-point, layout"
```

---

## Roadmap: plans 2–7

Each later plan is written when the plan before it has landed, against the code that then exists. Each produces working software on its own.

| Plan | Slice (spec §10) | Delivers | Depends on |
|---|---|---|---|
| 2 | Read-only canvas | `src/WorkflowStudio` scaffold (Vite, React, TS, nginx same-origin proxy, `openapi-typescript` types), `model/` and `layout/` with Vitest suites mirroring the backend validators, React Flow canvas that loads `GET /graph` and renders the section 5 visuals | Plan 1 |
| 3 | Editing | Wiring, moving, snap, multi-select, undo/redo, parked blocks, the draft store, the save request builder, `PUT /graph`, 409/422 surfaced in Output | Plan 2 |
| 4 | Inspectors | Step, Assignment (vanilla-jsoneditor + Ajv 2020-12), Processor (schema slots + impact panel), Workflow (cron preview), Cache (TanStack table, independent `PUT /caches/{id}`), Problems pane | Plan 3 |
| 5 | Dock chrome | dockview-core 8.4 shell, menus, window-position menu, in-house auto-hide, re-dock memory, document-area drop rule, `renderer:'always'`, `ownerDocument` in pop-outs, overlay layer tokens, Playwright e2e for the dock | Plan 4 |
| 6 | Toolbox | Drag-and-drop of processors, steps and caches onto the canvas; toolbox DELETE with the 422 "still referenced by" list | Plan 5 |
| 7 | Junctions and polish | ≥ 4-wire junctions stored in `Layout`, label shortening with real-font measurement, the remaining Playwright e2e | Plan 6 |

Before plan 2: install the `react-flow-skill` and `tanstack-table` skills, with the user's approval.
