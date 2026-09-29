# Entity Names From L2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator and the processors stamp `WorkflowName`, `StepName` and `ProcessorName`
on their own log records, resolved from `skp:name:{id}` keys in L2. BaseApi loses its
Elasticsearch coupling (the Lookup feature, the enrich policy and the `logs@custom` pipeline).

**Architecture:**
- **Names in:** BaseApi formats every entity's name once at start (`{name}_{version}-{last two GUID
  groups}`), carries the map on `WorkflowL1.Names`, and writes it to L2 beside the projection.
- **Names out:** a resolver in `BaseConsole.Core` reads those keys through a read-only name source.
  It caches hits for good, never caches misses, and never throws.
- **Where names attach:** a log scope opened by the gated consumer around each delivery (enclosing
  the park line too), plus explicit scopes at the orchestrator's and processors' log sites that run
  outside a delivery.
- **Readers:** Kibana, the verify script and a new offline pin script read names from the records
  and from Redis, never from an Elasticsearch index.

**Tech Stack:** .NET 8, xUnit v3, NSubstitute, StackExchange.Redis, RabbitMQ transport, Python 3 with
`requests` (no `redis` package; a small RESP client is written), Kibana saved objects.

**Spec:** `docs/superpowers/specs/2026-09-29-log-entity-names-from-l2-design.md`. Read it before
starting.

## Global Constraints

- **Name format (D1):** `{name}_{version}-{suffix}`, where the suffix is the GUID's last two groups
  (`id.ToString("D")[19..]`), e.g. `analyst-monitor_1.0.0-9aff-a7f22ee09224` for
  `208cba76-d635-4721-9aff-a7f22ee09224`. **Fallback (D2):** the suffix alone, e.g. `9aff-a7f22ee09224`.
- **One place defines the rule:** `Messaging.Contracts.EntityNames` (`Format`, `Fallback`). C# code
  never builds a name any other way.
- **Scope attribute keys, exactly:** `WorkflowName`, `StepName`, `ProcessorName`, plus `WorkflowNames`
  for the reap line.
- **L2 key:** `skp:name:{id:D}`, a plain String. It is written on every start and **never deleted**
  (D8). No production code may SCAN or KEYS a pattern that matches it.
- **D3, separate resolution:** each of the three ids is resolved on its own. `ProcessorId` also
  goes through L2 inside its own processor.
- **D4:** dispatch messages carry ids only.
- **D5:** BaseApi's logging code does not change. `BaseApi.Core`'s own `GatedQueueConsumer` is not
  touched.
- **D6:** the resolver lives in `BaseConsole.Core`.
- **D7:** `WhitelistOwner` is dropped.
- **Names never fail anything.** A name-read fault or a miss yields the fallback. It never throws,
  never requeues, and never trips the gate. Misses are not cached; hits are cached with no expiry.
- **Every existing log template stays byte for byte.** Names travel as scope attributes only, the
  reap line included.
- **`WorkflowL1.Names` is optional and defaults to null.** An old-shaped `StartOrchestration`
  deserializes and starts.
- **Framework packages:** after ANY edit under `src/Messaging.Contracts`, `src/BaseConsole.Core`,
  `src/BaseProcessor.Core` or `src/BaseApi.Core`, run `bash scripts/pack-all.sh` before building the
  tests, and commit the `.nupkg` and `packages.lock.json` churn with the task (`git add -A src
  scripts`). The Orchestrator, processors and BaseApi.Service are project references and need only a
  rebuild.
- **Run tests through the executable**, not `dotnet test`:
  `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q`, then
  `cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe --filter-class "<Namespace.Class>"`.
  Never pass `--filter`. **Hermetic gate:** 0 failed, exit 0, every skip under `Live/`.
- `TreatWarningsAsErrors` and `Nullable` are on.
- **Do not touch any cluster, Elasticsearch, Kibana or remote.** Rollout is a separate procedure (see
  the end of this plan).
- **Workspace:** a fresh worktree on branch `feature/log-entity-names`, created from
  `feature/remove-edge-bases` at `7969f38` (this change ships in the same rebuild and builds on its
  record shapes).
- **Commit messages** use `type(scope): sentence` and end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A delivery whose handler throws a deterministic fault.** The park line (`RefusalTemplates.Parked`,
   logged in the consumer's `catch`) still carries all three names. Test in Task 4.
2. **Redis unreachable while resolving.** The delivery is still handled and acked, the record carries
   the fallback, and the gate is not tripped. Test in Task 4.
3. **A name that is missing on the first read and written later.** The second resolution returns the
   full name, because misses were not cached. Test in Task 3.
4. **A delivery with no id headers at all** (a control message stamped with nothing). No names scope
   entries, no exception. Test in Task 4.
5. **The same processor id serving several steps.** It appears once in `Names`, and `L2ProjectionWriter`
   writes one key for it. Test in Task 2.

---

### Task 1: Contracts: the name rule, the key, reading ids from headers, the optional map

**Files:**
- Create: `src/Messaging.Contracts/EntityNames.cs`
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` (add `Name`)
- Modify: `src/Messaging.Contracts/MessageIdHeaders.cs` (add `ReadIds`)
- Modify: `src/Messaging.Contracts/WorkflowL1.cs` (add optional `Names`)
- Test: `src/tests/BaseApi.Tests/Naming/EntityNamesTests.cs`

**Interfaces:**
- Produces:
  - `public static class EntityNames` with `const string WorkflowName = "WorkflowName"`, `StepName`,
    `ProcessorName`, `WorkflowNames = "WorkflowNames"`;
    `static string Format(string name, string version, Guid id)`; `static string Fallback(Guid id)`.
  - `L2ProjectionKeys.Name(Guid id)` returns `"skp:name:{id:D}"`.
  - `MessageIdHeaders.ReadIds(IDictionary<string, object?>? headers)` returns
    `(Guid WorkflowId, Guid StepId, Guid ProcessorId)`, using `Guid.Empty` for any absent or unparsable
    header.
  - `WorkflowL1(..., List<CacheL1> Caches, Dictionary<Guid, string>? Names = null)`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Naming/EntityNamesTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class EntityNamesTests
{
    private static readonly Guid Id = Guid.Parse("208cba76-d635-4721-9aff-a7f22ee09224");

    [Fact]
    public void FormatsNameVersionAndTheLastTwoGuidGroups() =>
        Assert.Equal("analyst-monitor_1.0.0-9aff-a7f22ee09224", EntityNames.Format("analyst-monitor", "1.0.0", Id));

    [Fact]
    public void TheFallbackIsTheSuffixAlone() =>
        Assert.Equal("9aff-a7f22ee09224", EntityNames.Fallback(Id));

    [Fact]
    public void AFullNameEndsWithItsOwnFallbackSoOneWildcardMatchesBoth() =>
        Assert.EndsWith("-" + EntityNames.Fallback(Id), EntityNames.Format("x", "2.0.0", Id), StringComparison.Ordinal);

    [Fact]
    public void TheNameKeyIsItsOwnNamespace() =>
        Assert.Equal("skp:name:208cba76-d635-4721-9aff-a7f22ee09224", L2ProjectionKeys.Name(Id));

    [Fact]
    public void ReadsTheThreeIdsFromStringAndByteHeaders()
    {
        var w = Guid.NewGuid();
        var s = Guid.NewGuid();
        var headers = new Dictionary<string, object?>
        {
            [MessageIdHeaders.WorkflowId] = w.ToString("D"),
            [MessageIdHeaders.StepId] = Encoding.UTF8.GetBytes(s.ToString("D")),
        };

        var ids = MessageIdHeaders.ReadIds(headers);

        Assert.Equal(w, ids.WorkflowId);
        Assert.Equal(s, ids.StepId);
        Assert.Equal(Guid.Empty, ids.ProcessorId);
    }

    [Fact]
    public void ReadsNothingFromNoHeaders()
    {
        Assert.Equal((Guid.Empty, Guid.Empty, Guid.Empty), MessageIdHeaders.ReadIds(null));
        Assert.Equal((Guid.Empty, Guid.Empty, Guid.Empty),
            MessageIdHeaders.ReadIds(new Dictionary<string, object?> { [MessageIdHeaders.WorkflowId] = "not-a-guid" }));
    }

    [Fact]
    public void AWorkflowL1WithoutNamesStillDeserializes()
    {
        const string json = """
            {"workflowId":"208cba76-d635-4721-9aff-a7f22ee09224","entryStepIds":[],"cron":null,"steps":[],"caches":[]}
            """;

        var definition = JsonSerializer.Deserialize<WorkflowL1>(json, MessagingJson.Options);

        Assert.NotNull(definition);
        Assert.Null(definition.Names);
    }

    [Fact]
    public void NamesRoundTripKeyedById()
    {
        var definition = new WorkflowL1(Id, [], null, [], [], new Dictionary<Guid, string> { [Id] = "wf_1.0.0-9aff-a7f22ee09224" });

        var back = JsonSerializer.Deserialize<WorkflowL1>(
            JsonSerializer.Serialize(definition, MessagingJson.Options), MessagingJson.Options);

        Assert.Equal("wf_1.0.0-9aff-a7f22ee09224", back!.Names![Id]);
    }
}
```

If `MessagingJson.Options` uses a naming policy other than camelCase, change the property names in
`json` to match it. Check `src/Messaging.Contracts/MessagingJson.cs`.

- [ ] **Step 2: Run the tests and watch them fail**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
```

Expected: the build fails because `EntityNames`, `L2ProjectionKeys.Name`, `MessageIdHeaders.ReadIds`
and the sixth `WorkflowL1` argument do not exist.

- [ ] **Step 3: Implement**

`src/Messaging.Contracts/EntityNames.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// The one place the entity-name rule exists. A name is <c>{name}_{version}-{suffix}</c>, where the
/// suffix is the id's last two groups: 64 bits, so a name is unique on its own and no
/// (name, version) constraint is needed. An unresolved entity logs the suffix alone. It carries no
/// <c>_</c> and no version, so it is easy to filter, and <c>*{suffix}</c> matches both forms of the
/// same entity. The fallback is derived from the same method as the full name, so the two cannot drift.
/// </summary>
public static class EntityNames
{
    public const string WorkflowName  = "WorkflowName";
    public const string StepName      = "StepName";
    public const string ProcessorName = "ProcessorName";

    /// <summary>The reap line's attribute: one record names several workflows.</summary>
    public const string WorkflowNames = "WorkflowNames";

    public static string Format(string name, string version, Guid id) => $"{name}_{version}-{Suffix(id)}";

    public static string Fallback(Guid id) => Suffix(id);

    // "D" is 8-4-4-4-12; index 19 starts the fourth group.
    private static string Suffix(Guid id) => id.ToString("D")[19..];
}
```

In `L2ProjectionKeys.cs`, after `ExecutionData`:

```csharp
    /// <summary>
    /// An entity's display name, <c>skp:name:{id}</c>: written by BaseApi on every start, read by the
    /// orchestrator and processors when they log. Its own namespace, so the orphan sweeper (which scans
    /// only <c>skp:proc:*</c> Sets) cannot see it, and it never collides with a workflow root
    /// (<c>skp:{id}</c>). Never deleted: entities are shared across workflows, and records keep
    /// arriving after a stop.
    /// </summary>
    public static string Name(Guid id) => $"{Prefix}name:{id:D}";
```

In `MessageIdHeaders.cs`, after `ReadScope`:

```csharp
    /// <summary>
    /// The three entity ids a delivery is about, read from the same headers <see cref="ReadScope"/>
    /// lifts. An absent or unparsable header reads as <see cref="Guid.Empty"/>: names are resolved
    /// best-effort and must never fail a delivery.
    /// </summary>
    public static (Guid WorkflowId, Guid StepId, Guid ProcessorId) ReadIds(IDictionary<string, object?>? headers)
    {
        if (headers is null)
        {
            return (Guid.Empty, Guid.Empty, Guid.Empty);
        }

        return (Read(headers, WorkflowId), Read(headers, StepId), Read(headers, ProcessorId));
    }

    private static Guid Read(IDictionary<string, object?> headers, string header)
    {
        if (!headers.TryGetValue(header, out var raw))
        {
            return Guid.Empty;
        }

        var text = raw switch
        {
            byte[] b => System.Text.Encoding.UTF8.GetString(b),
            string s => s,
            _ => null,
        };

        return Guid.TryParse(text, out var id) ? id : Guid.Empty;
    }
```

In `WorkflowL1.cs`, extend the record, keeping the other parameters as they are:

```csharp
public sealed record WorkflowL1(
    Guid WorkflowId,
    List<Guid> EntryStepIds,
    string? Cron,
    List<StepL1> Steps,
    List<CacheL1> Caches,
    Dictionary<Guid, string>? Names = null);
```

Add to the record's doc comment: "`Names` maps every workflow, step and processor id in the started
graph to its display name (see `EntityNames`). It rides this control message only, never a dispatch
message. It is optional: a message published before it existed deserializes with null, and the
workflow starts without names."

- [ ] **Step 4: Repack, build, run**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Naming.EntityNamesTests"
```

Expected: 8 passed. Then run the full hermetic suite once. The new optional parameter must not
break any existing `new WorkflowL1(...)` call.

- [ ] **Step 5: Commit**

```bash
git add -A src scripts
git commit -m "feat(contracts): one rule for entity names, their L2 key and the optional name map

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: BaseApi writes names to L2 and drops the Elasticsearch lookup

**Files:**
- Modify: `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs` (constructor, `StartAsync` ~line 144, `ToDefinition` ~line 198)
- Modify: `src/BaseApi.Service/Features/Orchestration/OrchestrationServiceCollectionExtensions.cs:41-50`
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs` (inside `WriteAsync`, before `batch.Execute()`)
- Modify: `src/BaseApi.Service/Composition/AppFeatures.cs:36` (remove `services.AddLookupFeature(cfg);`)
- Modify: `src/BaseApi.Service/appsettings.json:25-35` (remove the `Elasticsearch` section and its comment)
- Modify: `k8s/30-baseapi-service.yaml:92-98` (remove the comment block and `Elasticsearch__BaseUrl`)
- Delete: `src/BaseApi.Service/Features/Lookup/` (all 7 files)
- Delete: `src/tests/BaseApi.Tests/Lookup/` (`ElasticLookupPublisherTests.cs`, `LookupRowExtractorTests.cs`, `StartPublishesLookupBeforeSendTests.cs`)
- Test: `src/tests/BaseApi.Tests/Naming/NameProjectionTests.cs`

**Interfaces:**
- Consumes: `EntityNames.Format`, `L2ProjectionKeys.Name`, `WorkflowL1.Names` (Task 1).
- Produces: every start writes `skp:name:{id}` for the workflow, each step and each processor in the
  snapshot. `OrchestrationService`'s internal constructor loses its `IEntityLookupPublisher` parameter.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Naming/NameProjectionTests.cs`:

```csharp
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class NameProjectionTests
{
    private static readonly Guid W  = Guid.Parse("11111111-1111-1111-aaaa-111111111111");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-bbbb-222222222222");
    private static readonly Guid S2 = Guid.Parse("33333333-3333-3333-cccc-333333333333");
    private static readonly Guid P  = Guid.Parse("44444444-4444-4444-dddd-444444444444");

    private static WorkflowGraphSnapshot Snapshot()
    {
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        var now = DateTime.UtcNow;

        snapshot.Workflows[W] = new WorkflowReadDto(
            W, "chain", "1.0.0", null, [S1], [], [], null, now, now, null, null);
        snapshot.Steps[S1] = new StepReadDto(S1, "step-a", "1.0.0", null, P, [S2], default, now, now, null, null);
        snapshot.Steps[S2] = new StepReadDto(S2, "step-b", "2.0.0", null, P, [], default, now, now, null, null);
        snapshot.Processors[P] = new ProcessorReadDto(
            P, "shared-proc", "1.2.0", null, "hash", null, null, null, null, now, now, null, null);

        return snapshot;
    }

    [Fact]
    public void TheDefinitionNamesEveryEntityOnce()
    {
        using var snapshot = Snapshot();

        var names = OrchestrationService.ToDefinitionForTests(snapshot, W).Names!;

        Assert.Equal(4, names.Count);   // one workflow, two steps, and ONE processor although two steps use it
        Assert.Equal(EntityNames.Format("chain", "1.0.0", W), names[W]);
        Assert.Equal(EntityNames.Format("step-b", "2.0.0", S2), names[S2]);
        Assert.Equal(EntityNames.Format("shared-proc", "1.2.0", P), names[P]);
    }

    [Fact]
    public async Task TheWriterPutsEveryNameUnderItsOwnKeyAndLeavesTheRootAlone()
    {
        using var snapshot = Snapshot();
        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);
        var l2 = new InMemoryL2();

        await new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider()).WriteAsync(definition, CancellationToken.None);

        Assert.Equal(definition.Names![P], l2.Value(L2ProjectionKeys.Name(P)));
        Assert.Equal(definition.Names![S1], l2.Value(L2ProjectionKeys.Name(S1)));
        Assert.Equal(4, l2.Keys().Count(k => k.StartsWith("skp:name:", StringComparison.Ordinal)));
        Assert.DoesNotContain("chain_1.0.0", l2.Value(L2ProjectionKeys.Root(W)));
    }

    [Fact]
    public async Task ADefinitionWithoutNamesWritesNoNameKeys()
    {
        var l2 = new InMemoryL2();

        await new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider())
            .WriteAsync(new WorkflowL1(W, [], null, [], []), CancellationToken.None);

        Assert.DoesNotContain(l2.Keys(), k => k.StartsWith("skp:name:", StringComparison.Ordinal));
        Assert.True(l2.Has(L2ProjectionKeys.Root(W)));
    }
}
```

`StepEntryCondition` is the enum in `StepReadDto`. `default` compiles to its zero value, and the
entry condition plays no part in naming. If `WorkflowGraphSnapshot.Steps`/`Processors` are exposed
under different names, follow `WorkflowGraphSnapshot`'s own members. `LookupRowExtractor` reads
`snapshot.Workflows`, `.Steps` and `.Processors`.

Also add one fact to `src/tests/BaseApi.Tests/Naming/NameProjectionTests.cs` that pins the sweeper's
blindness:

```csharp
    [Fact]
    public void NoProductionSourceScansTheKeySpace()
    {
        // Component 3's safety claim: the only KEYS/SCAN in production code is the orphan sweeper's
        // skp:proc:* pattern, which cannot match skp:name:*.
        var src = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var hits = Directory.EnumerateFiles(src, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}")
                        && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                        && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .SelectMany(f => File.ReadLines(f).Select(l => (f, l)))
            .Where(t => t.l.Contains(".Keys(pattern", StringComparison.Ordinal) || t.l.Contains("KeysAsync(", StringComparison.Ordinal))
            .ToList();

        var only = Assert.Single(hits);
        Assert.Contains("skp:proc:*", only.l);
    }
```

The path climbs from `src/tests/BaseApi.Tests/bin/Debug/net8.0/` to `src/` (five levels). It must
stop at `src/`: the repo root also holds `references/`, a copy of a prior repo with its own `Keys(`
calls. Confirm that with
`ls` and adjust the number of `..` segments if the output directory differs. Keep the assertion.

- [ ] **Step 2: Run and watch them fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Naming.NameProjectionTests"
```

Expected: `TheDefinitionNamesEveryEntityOnce` fails (`Names` is null), and
`TheWriterPutsEveryName…` fails (no `skp:name:` keys). `NoProductionSourceScansTheKeySpace`
should already pass: it pins a property that must not regress.

- [ ] **Step 3: Build the map in `ToDefinition`**

Replace the `return new WorkflowL1(...)` at the end of `ToDefinition` with:

```csharp
        // Every entity the start covers, each id once: a processor serving several steps is one entry.
        // Built here, from the snapshot the gates just approved, so the names projected are the names
        // of the state that was validated -- not a second read that could see a later edit.
        var names = new Dictionary<Guid, string>();
        foreach (var w in snapshot.Workflows.Values)
        {
            names[w.Id] = EntityNames.Format(w.Name, w.Version, w.Id);
        }

        foreach (var s in snapshot.Steps.Values)
        {
            names[s.Id] = EntityNames.Format(s.Name, s.Version, s.Id);
        }

        foreach (var p in snapshot.Processors.Values)
        {
            names[p.Id] = EntityNames.Format(p.Name, p.Version, p.Id);
        }

        return new WorkflowL1(
            WorkflowId: workflowId,
            EntryStepIds: workflow.EntryStepIds ?? new List<Guid>(),
            Cron: workflow.CronExpression,
            Steps: steps,
            Caches: caches,
            Names: names);
```

- [ ] **Step 4: Write the names in the projection batch**

In `L2ProjectionWriter.WriteAsync`, immediately before `batch.Execute();`:

```csharp
        // THE NAMES, in the same pipelined batch. Not a transaction: if any write fails the message is
        // redelivered and this whole method runs again, exactly as for the keys above. Never cleaned up
        // on stop -- entities are shared across workflows and records keep arriving after a stop -- so
        // they are deliberately absent from the root and from L2Cleanup's key list.
        foreach (var (id, name) in workflow.Names ?? new Dictionary<Guid, string>())
        {
            writes.Add(batch.StringSetAsync(L2ProjectionKeys.Name(id), name));
        }
```

- [ ] **Step 5: Remove the Lookup feature**

```bash
git rm -r src/BaseApi.Service/Features/Lookup src/tests/BaseApi.Tests/Lookup
```

Then make these edits:
- In `OrchestrationService.cs`:
  - delete the `_lookup` field, the `IEntityLookupPublisher lookup` constructor parameter and its
    assignment;
  - delete the line `await _lookup.PublishAsync(LookupRowExtractor.From(snapshot), ct);` and any
    comment block directly above it that explains the names-before-start ordering;
  - delete the `using BaseApi.Service.Features.Lookup;` directive.
- In `OrchestrationServiceCollectionExtensions.cs`, delete the argument line
  `sp.GetRequiredService<BaseApi.Service.Features.Lookup.IEntityLookupPublisher>(),`.
- In `AppFeatures.cs`, delete `services.AddLookupFeature(cfg);`. If `cfg` becomes unused, keep the
  parameter; other features may use it.
- In `appsettings.json`, delete the `"Elasticsearch": { … }` object and the comment lines directly
  above it. Keep the JSON valid.
- In `k8s/30-baseapi-service.yaml`, delete the comment block starting `# The entity id -> name table
  lives in Elasticsearch` and the two lines `- name: Elasticsearch__BaseUrl` /
  `value: http://elasticsearch:9200`.

Check that nothing is left:

```bash
grep -rn "Lookup\b\|IEntityLookupPublisher\|ElasticLookup\|LookupRow\|Elasticsearch__BaseUrl\|skp-entity-lookup" --include=*.cs --include=*.json --include=*.yaml src k8s | grep -v "/obj/\|/bin/\|ProcessorLookup\|Live/ArchiveCollapser"
```

Expected: no output. `ProcessorLookup` in `ArchiveCollapserLiveTests` is an unrelated local record.

- [ ] **Step 6: Build and run**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Naming.NameProjectionTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.CacheDefinitionTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.CacheProjectionWriteTests"
./BaseApi.Tests.exe
```

Expected: 0 failed everywhere. The full run shows the three deleted Lookup test classes gone.

- [ ] **Step 7: Commit**

```bash
git add -A src k8s
git commit -m "feat(api): project entity names into L2 and drop the Elasticsearch lookup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The resolver in BaseConsole.Core

**Files:**
- Create: `src/BaseConsole.Core/Naming/IEntityNameSource.cs`
- Create: `src/BaseConsole.Core/Naming/RedisEntityNameSource.cs`
- Create: `src/BaseConsole.Core/Naming/EntityNameResolver.cs`
- Create: `src/BaseConsole.Core/Naming/EntityNameScopeExtensions.cs`
- Modify: `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs` (`AddBaseConsoleGating`)
- Modify: `src/tests/BaseApi.Tests/Support/InMemoryL2.cs` (`Wire`: add the MGET overload)
- Create: `src/tests/BaseApi.Tests/Support/FakeNameSource.cs`
- Test: `src/tests/BaseApi.Tests/Naming/EntityNameResolverTests.cs`

**Interfaces:**
- Consumes: `EntityNames`, `L2ProjectionKeys.Name` (Task 1).
- Produces (namespace `BaseConsole.Core.Naming`):
  - `public interface IEntityNameSource { Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<Guid> ids); }`
    returns only the ids that were found, and may throw.
  - `public sealed class RedisEntityNameSource(IConnectionMultiplexer redis) : IEntityNameSource`, plus
    `public static Task<IReadOnlyDictionary<Guid, string>> ReadAsync(IDatabaseAsync db, IReadOnlyCollection<Guid> ids)`.
  - `public sealed class EntityNameResolver(IEntityNameSource source, ILogger<EntityNameResolver> logger)` with:
    - `Task<Dictionary<string, object>> ScopeAsync(Guid workflowId, Guid stepId, Guid processorId)`
    - `Dictionary<string, object> CachedScope(Guid workflowId, Guid stepId, Guid processorId)`
    - `string NameOrFallback(Guid id)`
  - `public static class EntityNameScopeExtensions`:
    - `Task<IDisposable?> BeginNamesScopeAsync(this ILogger logger, EntityNameResolver? names, Guid workflowId, Guid stepId, Guid processorId)`
    - `IDisposable? BeginCachedNamesScope(this ILogger logger, EntityNameResolver? names, Guid workflowId, Guid stepId, Guid processorId)`
  - DI: `AddBaseConsoleGating` `TryAdd`s `IEntityNameSource` → `RedisEntityNameSource` and
    `EntityNameResolver`, both singletons.
  - Test support `BaseApi.Tests.Support.FakeNameSource`.

- [ ] **Step 1: Add the test support**

In `InMemoryL2.Wire`, after the single-key `StringGetAsync` wiring, add:

```csharp
        // MGET. The name resolver reads all of a record's ids in one round trip.
        target.StringGetAsync(Arg.Any<RedisKey[]>())
            .Returns(ci => ci.ArgAt<RedisKey[]>(0)
                .Select(k => _strings.TryGetValue(k.ToString(), out var value) ? (RedisValue)value : RedisValue.Null)
                .ToArray());
```

Create `src/tests/BaseApi.Tests/Support/FakeNameSource.cs`:

```csharp
using BaseConsole.Core.Naming;

namespace BaseApi.Tests.Support;

/// <summary>A name source over a dictionary that counts its reads and can be told to fault.</summary>
internal sealed class FakeNameSource(Dictionary<Guid, string>? names = null) : IEntityNameSource
{
    public Dictionary<Guid, string> Names { get; } = names ?? new();

    public Exception? Fault { get; set; }

    public int Reads { get; private set; }

    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<Guid> ids)
    {
        Reads++;
        if (Fault is not null)
        {
            return Task.FromException<IReadOnlyDictionary<Guid, string>>(Fault);
        }

        IReadOnlyDictionary<Guid, string> found = ids.Where(Names.ContainsKey).ToDictionary(id => id, id => Names[id]);
        return Task.FromResult(found);
    }
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/tests/BaseApi.Tests/Naming/EntityNameResolverTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class EntityNameResolverTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-aaaa-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-bbbb-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-cccc-333333333333");

    private static EntityNameResolver Resolver(IEntityNameSource source) =>
        new(source, NullLogger<EntityNameResolver>.Instance);

    [Fact]
    public async Task AHitNamesTheRecordAndIsReadOnce()
    {
        var source = new FakeNameSource(new() { [W] = "wf_1.0.0-aaaa-111111111111" });
        var resolver = Resolver(source);

        var first = await resolver.ScopeAsync(W, Guid.Empty, Guid.Empty);
        var second = await resolver.ScopeAsync(W, Guid.Empty, Guid.Empty);

        Assert.Equal("wf_1.0.0-aaaa-111111111111", first[EntityNames.WorkflowName]);
        Assert.Equal(first, second);
        Assert.Equal(1, source.Reads);
        Assert.False(first.ContainsKey(EntityNames.StepName));   // Guid.Empty is not an entity
    }

    [Fact]
    public async Task AMissLogsTheFallbackAndIsNotCached()
    {
        // Review focus 3: a key written after the first read is picked up by the next one.
        var source = new FakeNameSource();
        var resolver = Resolver(source);

        var miss = await resolver.ScopeAsync(Guid.Empty, S, Guid.Empty);
        source.Names[S] = "step_1.0.0-bbbb-222222222222";
        var hit = await resolver.ScopeAsync(Guid.Empty, S, Guid.Empty);

        Assert.Equal(EntityNames.Fallback(S), miss[EntityNames.StepName]);
        Assert.Equal("step_1.0.0-bbbb-222222222222", hit[EntityNames.StepName]);
        Assert.Equal(2, source.Reads);
    }

    [Fact]
    public async Task ASourceFaultYieldsFallbacksAndNeverThrows()
    {
        var source = new FakeNameSource { Fault = new RedisConnectionException(ConnectionFailureType.SocketFailure, "down") };

        var scope = await Resolver(source).ScopeAsync(W, S, P);

        Assert.Equal(EntityNames.Fallback(W), scope[EntityNames.WorkflowName]);
        Assert.Equal(EntityNames.Fallback(S), scope[EntityNames.StepName]);
        Assert.Equal(EntityNames.Fallback(P), scope[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task EachIdResolvesOnItsOwn()
    {
        // D3: a missing workflow name does not stop the processor's being found.
        var resolver = Resolver(new FakeNameSource(new() { [P] = "proc_1.0.0-cccc-333333333333" }));

        var scope = await resolver.ScopeAsync(W, Guid.Empty, P);

        Assert.Equal(EntityNames.Fallback(W), scope[EntityNames.WorkflowName]);
        Assert.Equal("proc_1.0.0-cccc-333333333333", scope[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task TheCachedViewNeverReadsTheSource()
    {
        var source = new FakeNameSource(new() { [W] = "wf_1.0.0-aaaa-111111111111" });
        var resolver = Resolver(source);

        Assert.Equal(EntityNames.Fallback(W), resolver.NameOrFallback(W));
        await resolver.ScopeAsync(W, Guid.Empty, Guid.Empty);

        Assert.Equal("wf_1.0.0-aaaa-111111111111", resolver.NameOrFallback(W));
        Assert.Equal("wf_1.0.0-aaaa-111111111111", resolver.CachedScope(W, Guid.Empty, Guid.Empty)[EntityNames.WorkflowName]);
        Assert.Equal(1, source.Reads);
    }

    [Fact]
    public async Task ConcurrentFirstLookupsAllGetTheName()
    {
        var resolver = Resolver(new FakeNameSource(new() { [W] = "wf_1.0.0-aaaa-111111111111" }));

        var scopes = await Task.WhenAll(Enumerable.Range(0, 32)
            .Select(_ => Task.Run(() => resolver.ScopeAsync(W, Guid.Empty, Guid.Empty))));

        Assert.All(scopes, s => Assert.Equal("wf_1.0.0-aaaa-111111111111", s[EntityNames.WorkflowName]));
    }

    [Fact]
    public async Task TheRedisSourceReadsNameKeysInOneMget()
    {
        var l2 = new InMemoryL2();
        await l2.Db.StringSetAsync(L2ProjectionKeys.Name(W), "wf_1.0.0-aaaa-111111111111");

        var found = await new RedisEntityNameSource(l2.Multiplexer).ReadNamesAsync([W, S]);

        Assert.Equal("wf_1.0.0-aaaa-111111111111", Assert.Single(found).Value);
        await l2.Db.Received(1).StringGetAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task TheNoOpHelpersAcceptNoResolver()
    {
        var logger = NullLogger.Instance;

        Assert.Null(await logger.BeginNamesScopeAsync(null, W, S, P));
        Assert.Null(logger.BeginCachedNamesScope(null, W, S, P));
    }
}
```

Add `using NSubstitute;` for `Received`.

- [ ] **Step 3: Run and watch them fail**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
```

Expected: the build fails because `BaseConsole.Core.Naming` does not exist.

- [ ] **Step 4: Implement**

`src/BaseConsole.Core/Naming/IEntityNameSource.cs`:

```csharp
namespace BaseConsole.Core.Naming;

/// <summary>
/// Where display names come from: the <c>skp:name:{id}</c> keys BaseApi writes on every start.
/// Read-only. Returns only the ids it found. It may throw; the resolver above it never does.
/// </summary>
public interface IEntityNameSource
{
    Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<Guid> ids);
}
```

`src/BaseConsole.Core/Naming/RedisEntityNameSource.cs`:

```csharp
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseConsole.Core.Naming;

/// <summary>The processors' name source: one MGET over the name keys.</summary>
public sealed class RedisEntityNameSource(IConnectionMultiplexer redis) : IEntityNameSource
{
    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<Guid> ids) =>
        ReadAsync(redis.GetDatabase(), ids);

    /// <summary>
    /// The read itself, shared with the orchestrator's <c>L2WorkflowReader</c> so the two sources
    /// cannot read names differently.
    /// </summary>
    public static async Task<IReadOnlyDictionary<Guid, string>> ReadAsync(IDatabaseAsync db, IReadOnlyCollection<Guid> ids)
    {
        var list = ids.ToArray();
        var values = await db.StringGetAsync(list.Select(id => (RedisKey)L2ProjectionKeys.Name(id)).ToArray())
            .ConfigureAwait(false);

        var found = new Dictionary<Guid, string>(list.Length);
        for (var i = 0; i < list.Length; i++)
        {
            if (!values[i].IsNullOrEmpty)
            {
                found[list[i]] = values[i].ToString();
            }
        }

        return found;
    }
}
```

`src/BaseConsole.Core/Naming/EntityNameResolver.cs`:

```csharp
using System.Collections.Concurrent;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Naming;

/// <summary>
/// Resolves entity ids to display names for log records, from L2, once, held in memory.
/// <para>
/// <b>It never fails anything.</b> A missing key or an unreachable store yields the id's fallback
/// (<see cref="EntityNames.Fallback"/>). A read fault is caught HERE: it must never requeue a
/// delivery, fail a step or trip the gate the way a projection-read fault deliberately does.
/// </para>
/// <para>
/// <b>Hits are cached forever and misses never.</b> A name is fixed for an entity's life except
/// across a rename and restart, which is the accepted limit (a processor keeps the old name until
/// its pod restarts). A miss is often a start still in flight, so it is re-read next time.
/// </para>
/// </summary>
public sealed class EntityNameResolver(IEntityNameSource source, ILogger<EntityNameResolver> logger)
{
    private readonly ConcurrentDictionary<Guid, string> _names = new();

    /// <summary>
    /// The names scope for a record about these ids, reading any that are not cached in one call.
    /// <see cref="Guid.Empty"/> means "no such entity on this record" and adds no attribute.
    /// </summary>
    public async Task<Dictionary<string, object>> ScopeAsync(Guid workflowId, Guid stepId, Guid processorId)
    {
        var unknown = new[] { workflowId, stepId, processorId }
            .Where(id => id != Guid.Empty && !_names.ContainsKey(id))
            .Distinct()
            .ToArray();

        if (unknown.Length > 0)
        {
            try
            {
                foreach (var (id, name) in await source.ReadNamesAsync(unknown).ConfigureAwait(false))
                {
                    _names[id] = name;
                }
            }
            catch (Exception ex)
            {
                // Debug, not Warning: a store outage is already reported loudly by the gate, and a
                // line per delivery here would bury it. The records still carry the fallbacks.
                logger.LogDebug(ex, "entity names could not be read; logging the id suffix instead");
            }
        }

        return CachedScope(workflowId, stepId, processorId);
    }

    /// <summary>The same scope from the cache alone, for synchronous sites. It never reads the store.</summary>
    public Dictionary<string, object> CachedScope(Guid workflowId, Guid stepId, Guid processorId)
    {
        var scope = new Dictionary<string, object>(3);
        Put(scope, EntityNames.WorkflowName, workflowId);
        Put(scope, EntityNames.StepName, stepId);
        Put(scope, EntityNames.ProcessorName, processorId);
        return scope;
    }

    /// <summary>The cached name, or the fallback. It never reads the store.</summary>
    public string NameOrFallback(Guid id) => _names.TryGetValue(id, out var name) ? name : EntityNames.Fallback(id);

    private void Put(Dictionary<string, object> scope, string key, Guid id)
    {
        if (id != Guid.Empty)
        {
            scope[key] = NameOrFallback(id);
        }
    }
}
```

`src/BaseConsole.Core/Naming/EntityNameScopeExtensions.cs`:

```csharp
using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Naming;

/// <summary>
/// The one helper every site uses to put names on its records: the gated consumer around each
/// delivery, and each orchestrator or processor log site that runs outside a delivery. A null
/// resolver opens nothing, so a host or test that wires none still logs, just without names.
/// </summary>
public static class EntityNameScopeExtensions
{
    public static async Task<IDisposable?> BeginNamesScopeAsync(
        this ILogger logger, EntityNameResolver? names, Guid workflowId, Guid stepId, Guid processorId) =>
        names is null
            ? null
            : logger.BeginScope(await names.ScopeAsync(workflowId, stepId, processorId).ConfigureAwait(false));

    public static IDisposable? BeginCachedNamesScope(
        this ILogger logger, EntityNameResolver? names, Guid workflowId, Guid stepId, Guid processorId) =>
        names is null ? null : logger.BeginScope(names.CachedScope(workflowId, stepId, processorId));
}
```

In `AddBaseConsoleGating`, directly before `services.TryAddSingleton<IConsumerAdmission, AlwaysOpenAdmission>();`:

```csharp
        // Names for log records. TryAdd, so a host with a better source registered earlier keeps it:
        // the orchestrator reads names through L2WorkflowReader, its single point of Redis access.
        services.TryAddSingleton<IEntityNameSource, RedisEntityNameSource>();
        services.TryAddSingleton<EntityNameResolver>();
```

Add `using BaseConsole.Core.Naming;` to that file.

- [ ] **Step 5: Repack, build, run**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Naming.EntityNameResolverTests"
```

Expected: 8 passed. Then run the full hermetic suite once.

- [ ] **Step 6: Commit**

```bash
git add -A src scripts
git commit -m "feat(console): resolve entity names from L2 without ever failing a delivery

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Every delivery's records carry the names, the park line included

**Files:**
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs` (constructor ~line 65; `OnReceivedAsync` after the gate check ~line 330)
- Modify: `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs` (`AddGatedQueue`, ~line 174)
- Create: `src/tests/BaseApi.Tests/Support/SharedLog.cs`
- Test: `src/tests/BaseApi.Tests/Naming/ConsumerNamesTests.cs`

**Interfaces:**
- Consumes: `EntityNameResolver`, `BeginNamesScopeAsync` (Task 3), and `MessageIdHeaders.ReadIds` (Task 1).
- Produces:
  - `GatedQueueConsumer(..., ILogger<GatedQueueConsumer> logger, EntityNameResolver? names = null)`.
    The optional last parameter is filled from DI; tests that pass none are unaffected.
  - Test support `SharedLog`: one record list and one scope chain shared by every `ILogger<T>` it
    hands out, the way the production logger factory shares scopes across categories.

- [ ] **Step 1: Add `SharedLog`**

Create `src/tests/BaseApi.Tests/Support/SharedLog.cs`:

```csharp
using Microsoft.Extensions.Logging;

namespace BaseApi.Tests.Support;

/// <summary>
/// Loggers that share one scope chain and one record list, as loggers from a real LoggerFactory do.
/// A scope begun on one category (the consumer) must appear on records written by another (the
/// handler), and a RecordingLogger per type cannot show that.
/// </summary>
internal sealed class SharedLog
{
    private readonly AsyncLocal<Node?> _active = new();
    private readonly object _gate = new();
    private readonly List<(string Category, LogLevel Level, string? Template, string Message, IReadOnlyDictionary<string, object> Scope)> _records = [];

    public IReadOnlyList<(string Category, LogLevel Level, string? Template, string Message, IReadOnlyDictionary<string, object> Scope)> Records
    {
        get { lock (_gate) { return _records.ToList(); } }
    }

    public ILogger<T> For<T>() => new Logger<T>(this);

    /// <summary>The flattened scope of the one record whose template or message contains <paramref name="text"/>.</summary>
    public IReadOnlyDictionary<string, object> ScopeOf(string text) =>
        Records.Single(r => (r.Template ?? r.Message).Contains(text, StringComparison.Ordinal)).Scope;

    private sealed record Node(IReadOnlyDictionary<string, object>? Values, Node? Parent);

    private sealed class Logger<T>(SharedLog log) : ILogger<T>
    {
        public IDisposable BeginScope<TState>(TState state) where TState : notnull
        {
            var values = state is IEnumerable<KeyValuePair<string, object>> pairs
                ? pairs.ToDictionary(p => p.Key, p => p.Value)
                : null;
            var restore = log._active.Value;
            log._active.Value = new Node(values, restore);
            return new Restore(log, restore);
        }

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var template = state is IEnumerable<KeyValuePair<string, object?>> values
                ? values.FirstOrDefault(v => v.Key == "{OriginalFormat}").Value?.ToString()
                : null;

            var chain = new List<Node>();
            for (var n = log._active.Value; n is not null; n = n.Parent)
            {
                chain.Add(n);
            }

            var merged = new Dictionary<string, object>(StringComparer.Ordinal);
            for (var i = chain.Count - 1; i >= 0; i--)
            {
                foreach (var pair in chain[i].Values ?? new Dictionary<string, object>())
                {
                    merged[pair.Key] = pair.Value;
                }
            }

            lock (log._gate)
            {
                log._records.Add((typeof(T).Name, level, template, formatter(state, exception), merged));
            }
        }
    }

    private sealed class Restore(SharedLog log, Node? restore) : IDisposable
    {
        public void Dispose() => log._active.Value = restore;
    }
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/tests/BaseApi.Tests/Naming/ConsumerNamesTests.cs`. It builds the consumer exactly as
`src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs` does (`BuildConsumer`, `GateAsync`,
`Handler`, `Latch`). Copy those helpers, and change the consumer's logger to
`log.For<GatedQueueConsumer>()` and its last argument to a resolver.

```csharp
using System.Text;
using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Messaging;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class ConsumerNamesTests
{
    private const string Queue = "names-test";
    private const string Type = "step-outcome";

    private static readonly Guid W = Guid.Parse("11111111-1111-1111-aaaa-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-bbbb-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-cccc-333333333333");

    private static readonly Dictionary<Guid, string> Known = new()
    {
        [W] = "chain_1.0.0-aaaa-111111111111",
        [S] = "step-a_1.0.0-bbbb-222222222222",
        [P] = "proc_1.2.0-cccc-333333333333",
    };

    /// <summary>A handler that logs through its OWN category, as real handlers do, then does what the test asks.</summary>
    private sealed class Handler(ILogger logger, Func<Task> body) : IQueueMessageHandler
    {
        public string MessageType => Type;

        public async Task HandleAsync(ReadOnlyMemory<byte> body_, CancellationToken ct)
        {
            logger.LogInformation("the handler ran");
            await body();
        }
    }

    private sealed class Latch : IConsumerAdmission
    {
        public bool IsOpen => true;
        public event Action? Opened { add { } remove { } }
    }

    private static BasicDeliverEventArgs Delivery(IDictionary<string, object?>? headers) =>
        new("consumer-tag", deliveryTag: 1UL, redelivered: false, exchange: "", routingKey: Queue,
            properties: new BasicProperties { Type = Type, Headers = headers },
            body: ReadOnlyMemory<byte>.Empty);

    private static Dictionary<string, object?> AllIds() => new()
    {
        [MessageIdHeaders.WorkflowId] = W.ToString("D"),
        [MessageIdHeaders.StepId] = Encoding.UTF8.GetBytes(S.ToString("D")),
        [MessageIdHeaders.ProcessorId] = P.ToString("D"),
    };

    private static async Task<GatedQueueConsumer> Consumer(SharedLog log, IEntityNameSource source, Func<Task> body)
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        await gate.ReportHealthyAsync();

        var services = new ServiceCollection();
        services.AddSingleton<IQueueMessageHandler>(new Handler(log.For<Handler>(), body));

        return new GatedQueueConsumer(
            new RabbitMqConnection(Options.Create(new RabbitMqOptions()), Array.Empty<IRabbitMqTopology>(),
                NullLogger<RabbitMqConnection>.Instance),
            gate,
            services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new GatedConsumerOptions { Queue = Queue }),
            new Latch(),
            log.For<GatedQueueConsumer>(),
            new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance));
    }

    [Fact]
    public async Task ARecordInsideTheHandlerCarriesAllThreeNames()
    {
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)), () => Task.CompletedTask);

        await consumer.OnReceivedAsync(this, Delivery(AllIds()));

        var scope = log.ScopeOf("the handler ran");
        Assert.Equal(Known[W], scope[EntityNames.WorkflowName]);
        Assert.Equal(Known[S], scope[EntityNames.StepName]);
        Assert.Equal(Known[P], scope[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task TheParkLineCarriesTheNamesAfterTheHandlerThrew()
    {
        // Review focus 1: logged in the consumer's catch, after the unwinding exception disposed every
        // scope opened inside the try.
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)),
            () => throw new InvalidOperationException("deterministic"));

        await consumer.OnReceivedAsync(this, Delivery(AllIds()));

        var scope = log.ScopeOf(RefusalTemplates.Parked.Split('{')[0]);
        Assert.Equal(Known[W], scope[EntityNames.WorkflowName]);
        Assert.Equal(Known[S], scope[EntityNames.StepName]);
        Assert.Equal(Known[P], scope[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task AFanoutControlMessageCarriesOnlyTheWorkflowName()
    {
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)), () => Task.CompletedTask);

        await consumer.OnReceivedAsync(this,
            Delivery(new Dictionary<string, object?> { [MessageIdHeaders.WorkflowId] = W.ToString("D") }));

        var scope = log.ScopeOf("the handler ran");
        Assert.Equal(Known[W], scope[EntityNames.WorkflowName]);
        Assert.False(scope.ContainsKey(EntityNames.StepName));
    }

    [Fact]
    public async Task AnUnreachableStoreStillHandlesTheDeliveryWithFallbacks()
    {
        // Review focus 2.
        var log = new SharedLog();
        var ran = false;
        var consumer = await Consumer(log,
            new FakeNameSource { Fault = new RedisConnectionException(ConnectionFailureType.SocketFailure, "down") },
            () => { ran = true; return Task.CompletedTask; });

        await consumer.OnReceivedAsync(this, Delivery(AllIds()));

        Assert.True(ran);
        Assert.Equal(EntityNames.Fallback(S), log.ScopeOf("the handler ran")[EntityNames.StepName]);
        Assert.True(consumer.ShouldConsume);   // the gate was not tripped
    }

    [Fact]
    public async Task ADeliveryWithNoIdHeadersGetsNoNames()
    {
        // Review focus 4.
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)), () => Task.CompletedTask);

        await consumer.OnReceivedAsync(this, Delivery(null));

        var scope = log.ScopeOf("the handler ran");
        Assert.False(scope.ContainsKey(EntityNames.WorkflowName));
        Assert.False(scope.ContainsKey(EntityNames.StepName));
        Assert.False(scope.ContainsKey(EntityNames.ProcessorName));
    }

    [Fact]
    public async Task ANoDataBranchCarriesNamesThoughItHasNoEntryId()
    {
        // A post-handler record for a branch sent with no data: ids in headers, no x-skp-entry-id.
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)), () => Task.CompletedTask);
        var headers = AllIds();
        headers[MessageIdHeaders.ExecutionId] = Guid.NewGuid().ToString("D");

        await consumer.OnReceivedAsync(this, Delivery(headers));

        Assert.Equal(Known[P], log.ScopeOf("the handler ran")[EntityNames.ProcessorName]);
    }
}
```

Match `Latch` and `Handler` to the members `IConsumerAdmission` and `IQueueMessageHandler` actually
declare. Copy `IngressMetricsTests`' `Latch` verbatim if it differs. If `ShouldConsume` does not
reflect the gate as used here, assert the gate itself instead: keep a reference to `gate` and assert
`gate.IsOpen`.

- [ ] **Step 3: Run and watch them fail**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
```

Expected: the build fails because `GatedQueueConsumer` has no seventh constructor parameter.

- [ ] **Step 4: Implement the consumer scope**

In `GatedQueueConsumer`:
- add a field `private readonly EntityNameResolver? _names;`;
- add the constructor parameter `EntityNameResolver? names = null` after `logger`, assigned with
  `_names = names;`;
- add `using BaseConsole.Core.Naming;`.

In `OnReceivedAsync`, immediately after the `if (!_gate.IsOpen) { … return; }` block and before
`var body = ea.Body.ToArray();`, insert:

```csharp
            // THE NAMES SCOPE, opened HERE and not around HandleAsync alone. The park line below is
            // logged in the catch, after the unwinding exception has disposed every scope opened
            // inside the try -- which is why that line re-reads its ids from the headers. A scope at
            // this level encloses the try AND the catch, so every record of this delivery carries the
            // names: the handler's, the processor's, and the park line. Resolving never throws.
            var (workflowId, stepId, processorId) = MessageIdHeaders.ReadIds(headers);
            using var names = await _logger.BeginNamesScopeAsync(_names, workflowId, stepId, processorId)
                .ConfigureAwait(false);
```

In `AddGatedQueue`, add a last argument to the `new GatedQueueConsumer(...)` call:
`sp.GetService<EntityNameResolver>()`. `AddBaseConsoleGating`'s `TryAddSingleton<GatedQueueConsumer>()`
needs no change: the container fills the optional parameter from the registration Task 3 added.

- [ ] **Step 5: Repack, build, run**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Naming.ConsumerNamesTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Console.IngressMetricsTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Messaging.ConsumerTwinParityTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Console.ConsumerAdmissionTests"
```

Expected: 0 failed. The parity test compares dispositions and metrics, and a log scope changes
neither. Then run the full hermetic suite once.

- [ ] **Step 6: Commit**

```bash
git add -A src scripts
git commit -m "feat(console): every delivery's records carry entity names, the park line included

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The orchestrator's own source and its log sites outside a delivery

**Files:**
- Modify: `src/Orchestrator/L1/L2WorkflowReader.cs` (implement `IEntityNameSource`; invariant comment lines 10-18)
- Modify: `src/Orchestrator/OrchestratorHost.cs:218` (register the reader as the name source)
- Modify: `src/Orchestrator/Hydration/HydrationService.cs` (constructor ~106; loop ~199-205)
- Modify: `src/Orchestrator/Scheduling/WorkflowFireJob.cs` (primary constructor ~49; scopes at ~90 and ~261)
- Modify: `src/Orchestrator/Scheduling/WorkflowScheduler.cs` (primary constructor ~59; `NextFireTimeOrLogSkip` ~123)
- Modify: `src/Orchestrator/L1/L1ReapService.cs` (constructor ~79; `Reap` ~159)
- Test: `src/tests/BaseApi.Tests/Naming/OrchestratorNamesTests.cs`

**Interfaces:**
- Consumes: `IEntityNameSource`, `RedisEntityNameSource.ReadAsync`, `EntityNameResolver`, and the two
  scope helpers (Task 3); `EntityNames.WorkflowNames` (Task 1).
- Produces: each of `HydrationService`, `WorkflowFireJob`, `WorkflowScheduler<TJob>` and
  `L1ReapService` gains an optional last constructor parameter `EntityNameResolver? names = null`.
- Spec deviation, deliberate: the spec's "orchestrator cache fill" (one MGET of a workflow's names
  when it is loaded) is done by the hydration loop's per-workflow resolve, which caches the
  workflow's name. Step and processor names are cached by the first delivery or fire that names
  them. `L2WorkflowReader` cannot depend on the resolver, because the resolver depends on it.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Naming/OrchestratorNamesTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using Orchestrator.L1;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class OrchestratorNamesTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-aaaa-111111111111");

    [Fact]
    public async Task TheReaderIsTheOrchestratorsNameSource()
    {
        var l2 = new InMemoryL2();
        await l2.Db.StringSetAsync(L2ProjectionKeys.Name(W), "chain_1.0.0-aaaa-111111111111");
        IEntityNameSource source = new L2WorkflowReader(l2.Multiplexer, NullLogger<L2WorkflowReader>.Instance);

        var found = await source.ReadNamesAsync([W]);

        Assert.Equal("chain_1.0.0-aaaa-111111111111", found[W]);
    }

    [Fact]
    public void TheReapLineNamesEveryReapedWorkflowWithoutChangingItsTemplate()
    {
        var store = new WorkflowL1Store();
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-09-29T12:00:00Z"));
        store.Set(W, new WorkflowL1(W, [], null, [], []), Guid.NewGuid());
        store.MarkDeleted(W, clock.GetUtcNow() - L1ReapService.GracePeriod - TimeSpan.FromMinutes(1));

        var names = new EntityNameResolver(new FakeNameSource(), NullLogger<EntityNameResolver>.Instance);
        var log = new RecordingLogger<L1ReapService>();

        new L1ReapService(store, clock, new BaseConsole.Core.Loop.LoopHeartbeat(clock), log, names).Reap();

        var i = log.Templates.ToList().FindIndex(t => t is not null && t.StartsWith("reaped {ReapedCount}", StringComparison.Ordinal));
        Assert.True(i >= 0);
        Assert.Equal("reaped {ReapedCount} workflow(s) stopped more than {GracePeriod} ago: {WorkflowIds}", log.Templates[i]);
        Assert.Equal(EntityNames.Fallback(W), log.RecordScopes[i][EntityNames.WorkflowNames]);
    }
}
```

Add these facts to the existing test classes, using each file's own harness:

In `src/tests/BaseApi.Tests/Orchestrator/WorkflowFireJobTests.cs`, add to `Harness`:

```csharp
        public WorkflowFireJob BuildNamed(EntityNameResolver names) => new(
            Store, Scheduler, Sender, State, Gate, Log, names);
```

and the fact:

```csharp
    [Fact]
    public async Task AFireNamesTheWorkflowAndEachEntryStepsStepAndProcessor()
    {
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);
        var names = new EntityNameResolver(
            new FakeNameSource(new() { [W] = "wf_1.0.0-x", [S1] = "s1_1.0.0-x", [P1] = "p1_1.0.0-x" }),
            NullLogger<EntityNameResolver>.Instance);

        await h.BuildNamed(names).Execute(h.Context(W, h.JobId));

        var scope = h.ScopeOf("dispatched an entry step");
        Assert.NotNull(scope);
        Assert.Equal("wf_1.0.0-x", scope![EntityNames.WorkflowName]);
        Assert.Equal("s1_1.0.0-x", scope[EntityNames.StepName]);
        Assert.Equal("p1_1.0.0-x", scope[EntityNames.ProcessorName]);
    }
```

(Add `using BaseConsole.Core.Naming;` there.)

In `src/tests/BaseApi.Tests/Orchestrator/HydrationServiceTests.cs`, add to `Harness`:

```csharp
        public HydrationService BuildNamed(SharedLog log, EntityNameResolver names) => new(
            Topology,
            _reader,
            new WorkflowActivator(_reader, Store, Scheduler, log.For<WorkflowActivator>()),
            Admission,
            StartupGate,
            Clock,
            Heartbeat,
            log.For<HydrationService>(),
            names);
```

and the fact:

```csharp
    [Fact]
    public async Task EachActivationAtBootCarriesItsWorkflowsName()
    {
        var h = new Harness().WithWorkflow(W1, "0 * * * *");
        var log = new SharedLog();
        var names = new EntityNameResolver(
            new FakeNameSource(new() { [W1] = "wf1_1.0.0-x" }), NullLogger<EntityNameResolver>.Instance);

        await h.BuildNamed(log, names).RunOnceAsync(CancellationToken.None);

        Assert.Equal("wf1_1.0.0-x", log.ScopeOf("activated workflow {WorkflowId}")[EntityNames.WorkflowName]);
    }
```

(Add `using BaseApi.Tests.Support;` and `using BaseConsole.Core.Naming;` there.)

- [ ] **Step 2: Run and watch them fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
```

Expected: the build fails because the reader does not implement `IEntityNameSource` and the four
constructors take no resolver.

- [ ] **Step 3: The reader is the name source**

In `L2WorkflowReader.cs`:
- change the declaration to
  `public sealed class L2WorkflowReader(IConnectionMultiplexer redis, ILogger<L2WorkflowReader> logger) : IEntityNameSource`;
- add `using BaseConsole.Core.Naming;`;
- add the method:

```csharp
    /// <summary>
    /// The fourth read this class makes: entity display names, for log records only, via
    /// <see cref="RedisEntityNameSource.ReadAsync"/>. UNLIKE the projection reads above, a fault here
    /// must not requeue a delivery or trip the gate. It propagates to <see cref="EntityNameResolver"/>,
    /// which catches it and logs the id suffix instead.
    /// </summary>
    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<Guid> ids) =>
        RedisEntityNameSource.ReadAsync(redis.GetDatabase(), ids);
```

In the class comment at lines 10-18, change the sentence that counts "three operations" so it
counts four, naming the fourth as the MGET of `skp:name:{id}` keys for log names. Keep the "only
place the orchestrator touches Redis, read-only" statement.

In `OrchestratorHost.cs`, directly after `builder.Services.AddSingleton<L2WorkflowReader>();` (line 218):

```csharp
        // The orchestrator's name source is its one Redis reader, registered AHEAD of
        // AddBaseConsoleGating, whose TryAdd of the plain Redis source then does nothing.
        builder.Services.AddSingleton<IEntityNameSource>(sp => sp.GetRequiredService<L2WorkflowReader>());
```

(Add `using BaseConsole.Core.Naming;`.)

- [ ] **Step 4: The sites outside a delivery**

`HydrationService`: add a last constructor parameter `EntityNameResolver? names = null`, store it as
`_names`, and in `RunOnceAsync` replace

```csharp
            await _activator.ActivateAsync(workflowId, ct).ConfigureAwait(false);
```

with

```csharp
            // Outside any delivery, so the consumer's names scope does not reach here: opened per
            // workflow, it names the activation records ("activated workflow …", "L2 does not hold …")
            // and fills the resolver's cache for the fires that follow.
            using (await _logger.BeginNamesScopeAsync(_names, workflowId, Guid.Empty, Guid.Empty).ConfigureAwait(false))
            {
                await _activator.ActivateAsync(workflowId, ct).ConfigureAwait(false);
            }
```

`WorkflowFireJob`: add `EntityNameResolver? names = null` as the last primary-constructor parameter.
Inside `Execute`, directly inside the existing
`using (logger.BeginScope(ExecutionLogScope.BuildScope(Guid.Empty, workflowId, …)))` block's opening
brace, insert

```csharp
            using var workflowName = await logger.BeginNamesScopeAsync(names, workflowId, Guid.Empty, Guid.Empty)
                .ConfigureAwait(false);
```

In `DispatchEntryStepsAsync`, directly inside `using (logger.BeginScope(state))`'s opening brace, insert

```csharp
                using var stepNames = await logger.BeginNamesScopeAsync(names, Guid.Empty, step.StepId, step.ProcessorId)
                    .ConfigureAwait(false);
```

`WorkflowScheduler<TJob>`: add `EntityNameResolver? names = null` as the last primary-constructor
parameter. In `NextFireTimeOrLogSkip`, wrap the `logger.LogWarning(…)` call:

```csharp
            // Synchronous and outside a delivery: cache only. The workflow was just activated, so its
            // name is cached unless the store was unreachable, in which case the fallback is right.
            using (logger.BeginCachedNamesScope(names, workflowId, Guid.Empty, Guid.Empty))
            {
                logger.LogWarning(
                    "cron for workflow {WorkflowId} yields no future fire time; nothing scheduled",
                    workflowId);
            }
```

`L1ReapService`: add a last constructor parameter `EntityNameResolver? names = null`, store it as
`_names`, and in `Reap` wrap the `_logger.LogInformation(…)` call (template unchanged):

```csharp
        // One record names several workflows, so a per-workflow scope does not fit: the names ride as
        // one list beside the ids. From the cache -- a reaped workflow was active, so its name was
        // resolved when it fired -- and the keys outlive a stop, so the fallback is rare.
        var reapedNames = string.Join(", ", reaped.Select(id => _names?.NameOrFallback(id) ?? EntityNames.Fallback(id)));
        using (_logger.BeginScope(new Dictionary<string, object> { [EntityNames.WorkflowNames] = reapedNames }))
        {
            _logger.LogInformation(
                "reaped {ReapedCount} workflow(s) stopped more than {GracePeriod} ago: {WorkflowIds}",
                reaped.Count, GracePeriod, string.Join(", ", reaped));
        }
```

Add `using BaseConsole.Core.Naming;` (and `using Messaging.Contracts;` where missing) to each file.
All four classes are resolved by the container (`AddHostedService`, `AddSingleton`, Quartz's DI job
factory), which fills the optional parameter from Task 3's registration.

- [ ] **Step 5: Build and run**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Naming.OrchestratorNamesTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.WorkflowFireJobTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.HydrationServiceTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.L1ReapServiceTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.WorkflowSchedulerTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.OrchestratorHostWiringTests"
```

Expected: 0 failed. `OrchestratorHostWiringTests` proves the graph still resolves with the new
registration. Then run the full hermetic suite once.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(orchestrator): name its records outside a delivery, reading names through its one reader

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: A processor names itself in its liveness records

**Files:**
- Modify: `src/BaseProcessor.Core/Liveness/ProcessorLivenessHeartbeat.cs` (constructor ~44; the healthy announcement and the write ~101-125)
- Test: `src/tests/BaseApi.Tests/Naming/ProcessorNamesTests.cs`

**Interfaces:**
- Consumes: `EntityNameResolver`, `BeginNamesScopeAsync` (Task 3).
- Produces: `ProcessorLivenessHeartbeat(..., ILogger<ProcessorLivenessHeartbeat> logger, EntityNameResolver? names = null)`.
  It is resolved through `ActivatorUtilities.CreateInstance`, which fills the optional parameter from DI.

- [ ] **Step 1: Write the failing test**

Read `src/tests/BaseApi.Tests/Processor/ProcessorLivenessHeartbeatTests.cs` and copy how it builds the
heartbeat and drives one beat with a healthy identity. Create
`src/tests/BaseApi.Tests/Naming/ProcessorNamesTests.cs` with one fact built the same way, but using
`var log = new SharedLog();`, passing `log.For<ProcessorLivenessHeartbeat>()` as the logger and
`new EntityNameResolver(new FakeNameSource(new() { [processorId] = "proc_1.2.0-x" }), NullLogger<EntityNameResolver>.Instance)`
as the new last argument. Then assert:

```csharp
        Assert.Equal("proc_1.2.0-x",
            log.ScopeOf("processor {ProcessorId} is healthy")[EntityNames.ProcessorName]);
```

A second fact uses a `FakeNameSource` with no entry and asserts the record carries
`EntityNames.Fallback(processorId)`. That is the "logs the suffix until some workflow that uses the
processor has been started" case.

- [ ] **Step 2: Run and watch it fail**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
```

Expected: the build fails because there is no resolver parameter.

- [ ] **Step 3: Implement**

Add a field `private readonly EntityNameResolver? _names;` and the constructor parameter
`EntityNameResolver? names = null` after `logger`, assigned with `_names = names;`. Add
`using BaseConsole.Core.Naming;`.

In the beat method, after the `if (!_context.IsHealthy || _context.Identity is not { } identity) return;`
guard, wrap everything that follows (the `_announcedHealthy` block and the `WriteAsync` call) in:

```csharp
        // Liveness records carry only the processor's own id, so they name it through L2 like any other
        // record (D3). Until a workflow using this processor has been started, the key does not exist
        // and the suffix is logged; misses are re-read each beat.
        using (await _logger.BeginNamesScopeAsync(_names, Guid.Empty, Guid.Empty, identity.Id).ConfigureAwait(false))
        {
            // … the existing _announcedHealthy block, entry creation and WriteAsync, unchanged …
        }
```

- [ ] **Step 4: Repack, build, run**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Naming.ProcessorNamesTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessorLivenessHeartbeatTests"
./BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessorHostWiringTests"
```

Expected: 0 failed. Then run the full hermetic suite once.

- [ ] **Step 5: Commit**

```bash
git add -A src scripts
git commit -m "feat(processor): liveness records name the processor from L2

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Kibana, the verify script and the offline tools read names from records and Redis

**Files:**
- Create: `tools/offline/skp_names.py` (a dependency-free RESP reader for `skp:name:*`)
- Create: `tools/offline/test_skp_names.py`
- Create: `tools/offline/pin-workflow-control.py`
- Create: `tools/offline/teardown-entity-lookup.py`
- Modify: `tools/verify-kibana-dashboard.py` (name source, checks 11 and 12, docstrings, `main`)
- Modify: `kibana/kibana-export.ndjson` (`skp-whitelist-pies` split)
- Modify: `kibana/README.md:76-84`
- Modify: `tools/ship-delta.ps1:71-76` (`$Scope` adds `kibana` and `tools/offline`)

**Interfaces:**
- Produces:
  - `skp_names.read_names(host, port, timeout=10) -> dict[str, str]` (id string → full name);
  - `skp_names.base_name(name) -> str`, which strips `-xxxx-xxxxxxxxxxxx`;
  - `skp_names.is_fallback(name) -> bool`;
  - the CLI `python tools/offline/pin-workflow-control.py --workflow <name_version> [--redis-host H] [--redis-port P] [--export kibana/kibana-export.ndjson]`;
  - the CLI `python tools/offline/teardown-entity-lookup.py --es-url URL [--dry-run]`.

- [ ] **Step 1: Write the failing Python tests**

Create `tools/offline/test_skp_names.py`:

```python
import io
import unittest

import skp_names


class Fake:
    """A socket stand-in: records what was sent, replays canned RESP replies."""

    def __init__(self, replies):
        self._in = io.BytesIO(replies)
        self.sent = b""

    def sendall(self, data):
        self.sent += data

    def makefile(self, mode):
        return self._in

    def close(self):
        pass


class SkpNamesTests(unittest.TestCase):
    def test_base_name_strips_the_suffix(self):
        self.assertEqual("split-importer_1.0.0",
                         skp_names.base_name("split-importer_1.0.0-9aff-a7f22ee09224"))

    def test_base_name_leaves_a_fallback_alone(self):
        self.assertEqual("9aff-a7f22ee09224", skp_names.base_name("9aff-a7f22ee09224"))

    def test_is_fallback(self):
        self.assertTrue(skp_names.is_fallback("9aff-a7f22ee09224"))
        self.assertFalse(skp_names.is_fallback("split-importer_1.0.0-9aff-a7f22ee09224"))

    def test_scan_then_mget(self):
        # SCAN returns cursor "0" and two keys; MGET returns one value and one nil.
        replies = (b"*2\r\n$1\r\n0\r\n*2\r\n"
                   b"$45\r\nskp:name:208cba76-d635-4721-9aff-a7f22ee09224\r\n"
                   b"$45\r\nskp:name:11111111-1111-1111-1111-111111111111\r\n"
                   b"*2\r\n$29\r\nchain_1.0.0-9aff-a7f22ee09224\r\n$-1\r\n")
        sock = Fake(replies)

        names = skp_names.read_names_from(sock)

        self.assertEqual({"208cba76-d635-4721-9aff-a7f22ee09224": "chain_1.0.0-9aff-a7f22ee09224"}, names)
        self.assertIn(b"SCAN", sock.sent)
        self.assertIn(b"skp:name:*", sock.sent)
        self.assertIn(b"MGET", sock.sent)


if __name__ == "__main__":
    unittest.main()
```

Run: `cd tools/offline && python -m unittest test_skp_names -v`. Expected: `ModuleNotFoundError: skp_names`.

- [ ] **Step 2: Implement `skp_names.py`**

```python
"""Read entity display names from L2 (skp:name:{id}) without a redis client library.

The single store of names since 2026-09-29: BaseApi writes one key per workflow, step and
processor on every start. Used by the Kibana verify script and the offline pin script, so neither
depends on an Elasticsearch index or on a package the offline machine may not have.
"""
import re
import socket

_SUFFIX = re.compile(r"-[0-9a-f]{4}-[0-9a-f]{12}$")
_FALLBACK = re.compile(r"^[0-9a-f]{4}-[0-9a-f]{12}$")
PREFIX = "skp:name:"


def base_name(name):
    """name_version-xxxx-xxxxxxxxxxxx -> name_version. A fallback has no base and is returned as is."""
    return name if _FALLBACK.match(name) else _SUFFIX.sub("", name)


def is_fallback(name):
    """True for an unresolved record: the id suffix alone, no underscore, no version."""
    return bool(_FALLBACK.match(name))


def _command(sock, *parts):
    out = f"*{len(parts)}\r\n".encode()
    for p in parts:
        b = p.encode()
        out += b"$" + str(len(b)).encode() + b"\r\n" + b + b"\r\n"
    sock.sendall(out)


def _reply(f):
    line = f.readline().rstrip(b"\r\n")
    kind, rest = line[:1], line[1:]
    if kind == b"$":
        n = int(rest)
        if n < 0:
            return None
        data = f.read(n + 2)[:-2]
        return data.decode("utf-8")
    if kind == b"*":
        n = int(rest)
        return None if n < 0 else [_reply(f) for _ in range(n)]
    if kind in (b"+", b":"):
        return rest.decode()
    if kind == b"-":
        raise RuntimeError(rest.decode())
    raise RuntimeError(f"unexpected RESP reply {line!r}")


def read_names_from(sock):
    f = sock.makefile("rb")
    keys, cursor = [], "0"
    while True:
        _command(sock, "SCAN", cursor, "MATCH", PREFIX + "*", "COUNT", "1000")
        cursor, batch = _reply(f)
        keys += batch
        if cursor == "0":
            break
    names = {}
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        _command(sock, "MGET", *chunk)
        for key, value in zip(chunk, _reply(f)):
            if value is not None:
                names[key[len(PREFIX):]] = value
    return names


def read_names(host="localhost", port=6380, timeout=10):
    """{id: full name} for every skp:name:* key. The default port is the supervised dev forward."""
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        return read_names_from(sock)
    finally:
        sock.close()
```

Run the tests again. Expected: 5 passed.

- [ ] **Step 3: The verify script reads names from Redis**

In `tools/verify-kibana-dashboard.py`:
- After the imports, add
  `sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "offline"))` and
  `import skp_names`, plus a constant `DEFAULT_REDIS = ("localhost", 6380)`.
- Delete `KINDS` and `LOOKUP_INDEX`, and replace `load_names` with:

```python
def load_names(redis_host, redis_port):
    """{id: name_version} for every entity BaseApi has ever started, read from skp:name:* in L2.

    THE SOURCE MOVED OUT OF ELASTICSEARCH. The skp-entity-lookup index and the logs@custom pipeline
    are gone; the processes stamp names on their own records and the keys in L2 are the single store.
    Names carry a GUID suffix that differs per environment, so every comparison below is on the
    base name (name_version) and the expected-count literals stay environment-independent.
    """
    return {i: skp_names.base_name(n) for i, n in skp_names.read_names(redis_host, redis_port).items()}
```

- Replace every `names["workflow"]`, `names["step"]` and `names["processor"]` with `names` (lines
  ~300, 399, 412, 450, 641, 739, 740, 754, 755, 795). Ids are unique across kinds, so one flat map
  serves every lookup.
- Replace `WHITELIST_SPLIT_FIELD = "attributes.WhitelistOwner"` with
  `WHITELIST_SPLIT_FIELDS = ["attributes.StepName", "attributes.WhitelistRoot"]`, and in check 11
  replace the `pair_split` computation with:

```python
    pair_split = (len(split) == 1 and split[0].get("type") == "multi_terms"
                  and split[0]["params"].get("fields") == WHITELIST_SPLIT_FIELDS)
```

- In check 12, replace the `owners` aggregation and the `unlabelled` computation with:

```python
    body = {"size": 0,
            "query": {"bool": {"filter": [{"exists": {"field": "attributes.WhitelistVerdict"}}]}},
            "aggs": {"pairs": {"multi_terms": {
                "terms": [{"field": "attributes.StepName"}, {"field": "attributes.WhitelistRoot"}],
                "size": 1000}}}}
    try:
        agg = requests.post(f"{es_url}/{DATA_STREAM}/_search", json=body, timeout=60).json()
        pairs = [tuple(b["key"]) for b in agg["aggregations"]["pairs"]["buckets"]]
    except Exception as exc:  # noqa: BLE001
        return checks.report(12, "Published steps are nameable", False,
                             f"whitelist pair read failed: {type(exc).__name__}: {exc}")

    # An unreadable pair is one whose step name is the D2 fallback (the id suffix alone).
    unlabelled = sorted(f"{s} · {r}" for s, r in pairs if skp_names.is_fallback(s))
```

  Change `resolved = set(names["step"].values())` to `resolved = set(names.values())`, and in the
  report text rename `whitelist_pairs={len(owners)}` to `whitelist_pairs={len(pairs)}` and "carry a
  name in the lookup index" to "carry a name in L2".
- In `main`:
  - add `parser.add_argument("--redis-host", default=DEFAULT_REDIS[0])` and
    `parser.add_argument("--redis-port", type=int, default=DEFAULT_REDIS[1])`;
  - call `load_names(args.redis_host, args.redis_port)`;
  - change the two error messages to "could not read skp:name:* from Redis at {host}:{port}: …" and
    "no name in L2 for {VALIDATION_WORKFLOW} - start that workflow once so BaseApi projects its
    names";
  - change the lookup to `next((i for i, n in names.items() if n == VALIDATION_WORKFLOW), None)`.
- Docstrings. Rewrite:
  - the module docstring's bullet "Names are no longer fields in the index. They are rendered by the
    data view's formatters…" to "Names are fields on the records, set by the orchestrator and the
    processors from L2; this script reads the same keys (skp:name:*) and compares on name_version";
  - the comment block above `KINDS` (lines ~165-184) that describes the formatter, `lookup/ping.svg`
    and the publisher, to one paragraph saying the same;
  - check 12's docstring paragraph about `attributes.WhitelistOwner` and the `logs@custom` pipeline,
    to say the board splits on `StepName` + `WhitelistRoot` with one pie per pair.

Syntax check: `python -m py_compile tools/verify-kibana-dashboard.py`.

- [ ] **Step 4: Split the whitelist pie on the pair**

`kibana/kibana-export.ndjson` has one object per line. Edit it with a script saved in the scratchpad
(not committed), run from the worktree root:

```python
import json
p = "kibana/kibana-export.ndjson"
lines = open(p, encoding="utf-8").read().split("\n")
hit = 0
for i, line in enumerate(lines):
    if not line.strip():
        continue
    o = json.loads(line)
    if o.get("id") != "skp-whitelist-pies":
        continue
    vis = json.loads(o["attributes"]["visState"])
    split = [a for a in vis["aggs"] if a["schema"] == "split"]
    assert len(split) == 1 and split[0]["params"]["field"] == "attributes.WhitelistOwner"
    a = split[0]
    a["type"] = "multi_terms"
    a["params"] = {"fields": ["attributes.StepName", "attributes.WhitelistRoot"],
                   "orderBy": "1", "order": "desc", "size": 20,
                   "otherBucket": False, "otherBucketLabel": "Other",
                   "separatorLabel": " · ", "row": False}
    o["attributes"]["visState"] = json.dumps(vis, ensure_ascii=False)
    lines[i] = json.dumps(o, ensure_ascii=False)
    hit += 1
assert hit == 1
open(p, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
print("ok")
```

`separatorLabel " · "` reproduces the old pie titles (`{step} · {root}`) with single-encoded UTF-8.
Confirm with `git diff --stat kibana/kibana-export.ndjson` that exactly one line changed, and with
`python -c "import json;[json.loads(l) for l in open('kibana/kibana-export.ndjson',encoding='utf-8') if l.strip()]"`
that the file still parses. The rendered result is checked at rollout on both stacks (8.15.5 and
9.3.4), because no Kibana may be contacted here.

- [ ] **Step 5: The offline pin script**

`tools/offline/pin-workflow-control.py`:

```python
"""Point the operator board's Workflow control at this environment's full workflow name.

The board opens on one workflow, because pie shares across two workflows describe neither. Names now
carry a GUID suffix that differs per environment, so the pinned value is rewritten per stack from L2
before the export is imported. Run it on dev (then commit) and on the offline machine (before import).
"""
import argparse
import json
import sys

import skp_names

DASHBOARD = "skp-operator-outcomes"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workflow", required=True, help="the workflow's name_version, e.g. filefetcher-archiveexpander-chain_1.0.0")
    ap.add_argument("--redis-host", default="localhost")
    ap.add_argument("--redis-port", type=int, default=6380)
    ap.add_argument("--export", default="kibana/kibana-export.ndjson")
    args = ap.parse_args()

    matches = [n for n in skp_names.read_names(args.redis_host, args.redis_port).values()
               if skp_names.base_name(n) == args.workflow]
    if len(matches) != 1:
        print(f"expected exactly one name in L2 for {args.workflow}, found {matches or 'none'} - "
              f"start the workflow once on this stack")
        return 1
    full = matches[0]

    lines = open(args.export, encoding="utf-8").read().split("\n")
    pinned = 0
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        o = json.loads(line)
        if o.get("id") != DASHBOARD:
            continue
        group = o["attributes"]["controlGroupInput"]
        panels = json.loads(group["panelsJSON"])
        for panel in panels.values():
            explicit = panel.get("explicitInput", {})
            if explicit.get("fieldName") == "attributes.WorkflowName":
                explicit["selectedOptions"] = [full]
                pinned += 1
        group["panelsJSON"] = json.dumps(panels, ensure_ascii=False)
        lines[i] = json.dumps(o, ensure_ascii=False)

    if pinned != 1:
        print(f"expected one Workflow control on {DASHBOARD}, found {pinned}")
        return 1
    open(args.export, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
    print(f"{DASHBOARD}: Workflow control pinned to {full}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Check the structure without a live Redis: `python -m py_compile tools/offline/pin-workflow-control.py`.
Also confirm that `json.loads(o["attributes"]["controlGroupInput"]["panelsJSON"])` parses for
`skp-operator-outcomes` in the current export and has exactly one control whose `fieldName` is
`attributes.WorkflowName`, with a one-line Python check. **The export's pinned value is not changed
in this task.** It is rewritten at rollout, per stack.

- [ ] **Step 6: The teardown script**

`tools/offline/teardown-entity-lookup.py`:

```python
"""Remove the retired entity-lookup plumbing from an Elasticsearch stack.

MANDATORY before the new processors log there: while the logs@custom pipeline exists, its enrich step
overwrites the names the processes set with the old name_version format. Order matters: a pipeline
that references the enrich policy blocks the policy's deletion. Every step tolerates 404, so a rerun
is safe. Run on every stack BaseApi ever booted against (dev and the offline machine).
"""
import argparse
import sys

import requests

STEPS = [
    ("pipeline", "_ingest/pipeline/logs@custom"),
    ("enrich policy", "_enrich/policy/skp-entity-lookup"),
    ("index", "skp-entity-lookup"),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--es-url", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    failed = 0
    for label, path in STEPS:
        url = f"{args.es_url.rstrip('/')}/{path}"
        if args.dry_run:
            print(f"would DELETE {url}")
            continue
        r = requests.delete(url, timeout=30)
        if r.status_code in (200, 404):
            print(f"{label}: {'deleted' if r.status_code == 200 else 'already absent'}")
        else:
            print(f"{label}: HTTP {r.status_code} {r.text[:200]}")
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

Check: `python tools/offline/teardown-entity-lookup.py --es-url http://example.invalid --dry-run`
prints three `would DELETE` lines in pipeline, policy, index order.

- [ ] **Step 7: Ship scope and README**

In `tools/ship-delta.ps1`, extend `$Scope`:

```powershell
$Scope = @(
    'src'
    'k8s'
    'nugets'
    'grafana/dashboards'
    'kibana'
    'tools/offline'
)
```

Add a comment line above it: "kibana/ and tools/offline/ ship since 2026-09-29: the export is pinned
per stack from L2, and the lookup teardown runs on the offline stack too." `nugets` is spelled as the
script has it. Leave it alone even though this branch still has `nuget/`; that rename belongs to
other work.

In `kibana/README.md`, replace the paragraph at lines 76-79 (`attributes.WhitelistOwner` is built the
same way…) with:

```markdown
Names are set on the records by the orchestrator and the processors themselves, resolved from
`skp:name:{id}` in L2 (`{name}_{version}-{last two GUID groups}`; an unresolved id logs the suffix
alone). There is no ingest pipeline and no lookup index any more. The whitelist board splits on the
pair `attributes.StepName` + `attributes.WhitelistRoot` (`multi_terms`, one pie per pair);
`WhitelistOwner` is retired. The Workflow control's pinned value is environment-specific: run
`python tools/offline/pin-workflow-control.py --workflow filefetcher-archiveexpander-chain_1.0.0`
against the stack's Redis before importing this export.
```

Leave the "What this replaced" history section alone, but add one line at its end: "The
`logs@custom` enrich pipeline that replaced it was itself retired on 2026-09-29."

- [ ] **Step 8: Commit**

```bash
git add tools kibana
git commit -m "feat(kibana): read names from records and L2; pin and teardown tools ship offline

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Housekeeping and the hermetic gate

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-log-entity-names-from-l2-design.md` (status line)
- Modify: any source comment that still describes the `logs@custom` pipeline or `skp-entity-lookup` as live (find them with the grep below)

- [ ] **Step 1: Find stale references**

```bash
grep -rn "logs@custom\|skp-entity-lookup\|WhitelistOwner\|IEntityLookupPublisher\|LookupProvisioning" --include=*.cs --include=*.py --include=*.json --include=*.yaml --include=*.md src k8s tools kibana | grep -v "/obj/\|/bin/\|docs/superpowers/"
```

For each hit:
- If it describes the pipeline or index as current, reword it to the past tense or delete it. One
  example: the Analyst `PanelRegistry`, if it says names come from the pipeline.
- Leave these alone:
  - `tools/offline/teardown-entity-lookup.py`, which names them on purpose;
  - `tools/classification-fixture.json`, whose records are historical samples;
  - `kibana/README.md`'s history section.

- [ ] **Step 2: Full hermetic run**

```bash
bash scripts/pack-all.sh
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q
cd src/tests/BaseApi.Tests/bin/Debug/net8.0 && ./BaseApi.Tests.exe
cd ../../../../../.. && (cd tools/offline && python -m unittest test_skp_names -v) && python -m py_compile tools/verify-kibana-dashboard.py
```

Expected: 0 failed, exit 0, every skip under `Live/`, and the Python tests pass.

- [ ] **Step 3: Mark the spec implemented**

Set the spec's status line to
`Status: implemented on feature/log-entity-names 2026-09-29; rollout together with remove-edge-bases.`

- [ ] **Step 4: Commit**

```bash
git add -A src docs tools kibana scripts
git commit -m "docs: retire the lookup-pipeline references and mark the names spec implemented

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Rollout (not part of this plan)

This is the combined rebuild with remove-edge-bases. Order matters.

1. **Teardown first, on dev:**
   `python tools/offline/teardown-entity-lookup.py --es-url http://localhost:19200`.
2. **Rebuild and deploy** BaseApi, the orchestrator and every processor (`kind load`, SourceHash
   repoint).
3. **Restart every running workflow** (stop, then start), so BaseApi projects `skp:name:*`. Re-POST
   the analyst-monitor payload first (remove-edge-bases).
4. **Pin and import:** run
   `python tools/offline/pin-workflow-control.py --workflow filefetcher-archiveexpander-chain_1.0.0`,
   commit the export, and import it by API. Then check that the whitelist pies render with
   `multi_terms`.
5. **Verify:** run `python tools/verify-kibana-dashboard.py`.
6. **Offline:** ship the delta (`pwsh tools/ship-delta.ps1 -Zip`), then run the teardown against the
   9.3.4 stack, deploy, restart the workflows, pin against the offline Redis, import, and check that
   the pies render on 9.3.4.
