# L2 Start-Driven Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-step, clean-on-stop L2 projection with typed entity hashes that only a workflow start aligns, a `skp:live` set that start/stop maintain, processor-owned name keys with a TTL, and an orchestrator that hydrates from `skp:live` and never reaps L1.

**Architecture:** BaseApi's control-queue consumer is the only writer of workflow/step keys: a start overwrites `skp:wf:{id}` (`name`/`store`/`roots`) and `skp:step:{id}` (`name`), deletes only its own stale cache keys, adds the id to `skp:live`, then announces. A stop only removes the id from `skp:live`, then announces. The orchestrator activates from `skp:wf:{id}.store` behind a `skp:live` membership guard (start, stop and hydration), keeps stopped entries in L1 forever, and preloads names into `EntityNameResolver`. Processors write their own `skp:proc:{id}` name hash, `skp:proc:{id}:instances` set and liveness key, all with the liveness TTL.

**Tech Stack:** .NET 8, StackExchange.Redis 2.13.1, xUnit v3 (Microsoft Testing Platform exe runner), NSubstitute, RabbitMQ, Python 3 (tools).

**Spec:** `docs/superpowers/specs/2026-09-30-l2-start-driven-projection-design.md`

## Global Constraints

- Key shapes, exactly: `skp:wf:{id:D}`, `skp:wf:{id:D}:cache:{root}`, `skp:wf:{id:D}:cache:{root}:{key}`, `skp:step:{id:D}`, `skp:live`, `skp:proc:{id:D}`, `skp:proc:{id:D}:instances`, `skp:proc:{id:D}:{instanceId}`, `skp:data:{entryId:D}` (unchanged).
- Hash fields, exactly: `name`, `store`, `roots`.
- Full name: `EntityNames.Format(name, version, id)` → `{name}_{version}-{idSuffix}`; never an instance id.
- Processor keys' TTL = `ProcessorLivenessWriter.DeriveTtlSeconds(entry.Interval)` (4 × interval).
- Every key string is built through `Messaging.Contracts.Projections.L2ProjectionKeys`; no hand-concatenated key anywhere.
- `Messaging.Contracts`, `Messaging.Transport`, `BaseConsole.Core`, `BaseApi.Core`, `BaseProcessor.Core` are consumed **as packages**. After ANY edit under those folders run `bash scripts/pack-all.sh` from the repo root BEFORE building the tests, and commit the regenerated `.nupkg` files and every changed `packages.lock.json` with the task.
- Test runner: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`, then run `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` (use `--filter-class "<Namespace.Class>"` for one class). `dotnet test` hides failure names — don't use it. `--filter "Category!=…"` is silently ignored; don't use it.
- Suite gate at the end of every task: **0 failed, exit 0**, every skip under `Live/`. Read the shape, not a remembered total.
- Explicit overloads for mocked Redis calls (the codebase pins them): `StringSetAsync(key, value, ttl, When.Always, CommandFlags.None)`, `KeyExpireAsync(key, ttl, ExpireWhen.Always, CommandFlags.None)`.
- Log message templates that already exist are **not** reworded (Kibana/ES panels select on them). New templates are allowed.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Git Bash on Windows: `pkill` doesn't exist; no Docker (k8s/kind only).

## Review Focus

1. **A stop after its live-set removal must unschedule even though `skp:wf:{id}` still exists.** Today's guard ("root key exists") would ignore every stop once stop no longer deletes anything. Pinned in Task 6 (`AStopAfterTheLiveRemovalUnschedulesEvenThoughTheStoreRemains`).
2. **A whitelist item removed from the database must answer Unlisted after the next start.** "Never clean" must not leave a stale `…:cache:{root}:{key}`. Pinned in Task 6 (`AnItemRemovedBeforeARestartIsUnlistedAfterIt`).
3. **A step dropped by one workflow must keep its name for another workflow using it.** Steps are shared (`StepEntity` has no `WorkflowId`). Pinned in Task 6 (`ARestartThatDropsAStepLeavesItsNameKey`).
4. **During rollout, an old SET at `skp:proc:{id}` makes `HSET` fail with WRONGTYPE; the liveness key must still be written.** Pinned in Task 4 (`ANameWriteFailureStillLeavesTheLivenessKey`).
5. **A stop announcement delivered after a later start must not tear down the restarted workflow.** The existing chain test must keep passing under live-set semantics (Task 6 keeps `AStopAnnouncementDeliveredBehindALaterStartDoesNotTearDownTheRestartedWorkflow`).

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` | every key shape + hash field names | 1, 3, 5, 8 |
| `src/Messaging.Contracts/Projections/L2EntityKind.cs` (new) | workflow / step / processor discriminator | 1 |
| `src/Messaging.Contracts/Projections/WorkflowStoreProjection.cs` (new) | JSON shape of the `store` field | 1 |
| `src/tests/BaseApi.Tests/Support/InMemoryL2.cs` | fake Redis: + hashes, TTLs, SISMEMBER | 2 |
| `src/BaseProcessor.Core/Liveness/ProcessorLivenessWriter.cs` | instance set + name hash + TTL | 3, 4 |
| `src/BaseApi.Service/Features/Orchestration/Validation/ProcessorLivenessValidator.cs` | reads the new instance set | 3 |
| `src/BaseApi.Service/Features/Orchestration/Projection/RedisL2InstanceIndexStore.cs` | sweeper scan of `…:instances` | 3 |
| `src/BaseConsole.Core/Naming/EntityRef.cs` (new), `IEntityNameSource.cs`, `RedisEntityNameSource.cs`, `EntityNameResolver.cs` | typed name reads from hashes, `PreloadAsync` | 5 |
| `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs` | drop processor names | 5 |
| `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs` | write + own leftovers | 5, 6 |
| `src/BaseApi.Service/Features/Orchestration/Projection/L2LiveSet.cs` (new) | `SADD`/`SREM skp:live` | 6 |
| `src/BaseApi.Service/Features/Orchestration/Messaging/StartOrchestrationHandler.cs`, `StopOrchestrationHandler.cs` | new sequences | 6 |
| `src/BaseApi.Service/Features/Orchestration/Projection/L2Cleanup.cs` | **deleted** | 6 |
| `src/Orchestrator/L1/L2WorkflowReader.cs`, `WorkflowActivator.cs`, `Messaging/ApplyStopHandler.cs` | live-set guard, store read, name preload | 6 |
| `src/Orchestrator/L1/L1ReapService.cs` + host wiring | **deleted** | 7 |
| `src/Messaging.Contracts/Projections/WorkflowRootProjection.cs`, `StepProjection.cs`, `LivenessProjection.cs` | **deleted** | 8 |
| `tools/offline/skp_names.py` (+ test), `tools/verify-kibana-dashboard.py`, `tools/offline/pin-workflow-control.py`, `kibana/README.md`, `grafana/dashboards/skp-orchestrator.json` | read names from hashes; text | 9 |

---

### Task 1: Contracts — new key builders and the store shape (additive)

Adds the new shapes next to the old ones so nothing breaks yet. The one in-place change is `Cache`/`CacheEntry` moving under `skp:wf:{id}` — safe because writer, cleanup and SKNormalizer all build it through the same method.

**Files:**
- Create: `src/Messaging.Contracts/Projections/L2EntityKind.cs`
- Create: `src/Messaging.Contracts/Projections/WorkflowStoreProjection.cs`
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs`
- Create: `src/tests/BaseApi.Tests/Projection/L2KeyLayoutTests.cs`
- Modify: `src/tests/BaseApi.Tests/Cache/CacheKeyTests.cs:18-54`

**Interfaces:**
- Produces:
  - `enum L2EntityKind { Workflow, Step, Processor }`
  - `L2ProjectionKeys.NameField = "name"`, `StoreField = "store"`, `RootsField = "roots"` (const string)
  - `L2ProjectionKeys.Live() : string` → `skp:live`
  - `L2ProjectionKeys.Workflow(Guid) : string` → `skp:wf:{id}`
  - `L2ProjectionKeys.StepEntity(Guid) : string` → `skp:step:{id}`
  - `L2ProjectionKeys.Processor(Guid) : string` → `skp:proc:{id}`
  - `L2ProjectionKeys.Entity(L2EntityKind, Guid) : string`
  - `L2ProjectionKeys.ProcessorInstances(Guid) : string` → `skp:proc:{id}:instances`
  - `L2ProjectionKeys.TryParseProcessorInstances(string key, out Guid processorId) : bool`
  - `L2ProjectionKeys.Cache(Guid, string)` → `skp:wf:{id}:cache:{root}` (changed)
  - `record WorkflowStoreProjection(List<Guid> EntryStepIds, string? Cron, List<StepL1> Steps)` (JSON `entryStepIds`, `cron`, `steps`)

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Projection/L2KeyLayoutTests.cs`:

```csharp
using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Projection;

/// <summary>
/// The start-driven key layout, pinned as literals: BaseApi writes these, the orchestrator and the
/// processors read them, and the Python tools address them by string. A shape that drifts on one side
/// reads as an empty store on the other, and nothing at runtime says so.
/// </summary>
public sealed class L2KeyLayoutTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public void EveryEntityKeyCarriesItsTypeSegment()
    {
        Assert.Equal("skp:wf:11111111-1111-1111-1111-111111111111", L2ProjectionKeys.Workflow(W));
        Assert.Equal("skp:step:22222222-2222-2222-2222-222222222222", L2ProjectionKeys.StepEntity(S));
        Assert.Equal("skp:proc:33333333-3333-3333-3333-333333333333", L2ProjectionKeys.Processor(P));
    }

    [Fact]
    public void EntityDispatchesOnTheKind()
    {
        Assert.Equal(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.Entity(L2EntityKind.Workflow, W));
        Assert.Equal(L2ProjectionKeys.StepEntity(S), L2ProjectionKeys.Entity(L2EntityKind.Step, S));
        Assert.Equal(L2ProjectionKeys.Processor(P), L2ProjectionKeys.Entity(L2EntityKind.Processor, P));
        Assert.Throws<ArgumentOutOfRangeException>(() => L2ProjectionKeys.Entity((L2EntityKind)99, W));
    }

    [Fact]
    public void TheHashFieldsAreFixed()
    {
        Assert.Equal("name", L2ProjectionKeys.NameField);
        Assert.Equal("store", L2ProjectionKeys.StoreField);
        Assert.Equal("roots", L2ProjectionKeys.RootsField);
    }

    [Fact]
    public void TheLiveSetIsOneFixedKey() => Assert.Equal("skp:live", L2ProjectionKeys.Live());

    [Fact]
    public void ProcessorInstanceKeysSitUnderTheProcessorKey()
    {
        Assert.Equal("skp:proc:33333333-3333-3333-3333-333333333333:instances", L2ProjectionKeys.ProcessorInstances(P));
        Assert.Equal("skp:proc:33333333-3333-3333-3333-333333333333:pod-0", L2ProjectionKeys.PerInstance(P, "pod-0"));
    }

    [Fact]
    public void AnInstancesKeyParsesBackToItsProcessor()
    {
        Assert.True(L2ProjectionKeys.TryParseProcessorInstances(L2ProjectionKeys.ProcessorInstances(P), out var id));
        Assert.Equal(P, id);
    }

    [Theory]
    [InlineData("skp:proc:33333333-3333-3333-3333-333333333333")]
    [InlineData("skp:proc:33333333-3333-3333-3333-333333333333:pod-0")]
    [InlineData("skp:proc:not-a-guid:instances")]
    [InlineData("skp:wf:33333333-3333-3333-3333-333333333333:instances")]
    public void AnythingElseDoesNotParseAsAnInstancesKey(string key)
        => Assert.False(L2ProjectionKeys.TryParseProcessorInstances(key, out _));

    [Fact]
    public void CacheKeysLiveUnderTheWorkflowKey()
    {
        Assert.Equal("skp:wf:11111111-1111-1111-1111-111111111111:cache:sk-whitelist", L2ProjectionKeys.Cache(W, "sk-whitelist"));
        Assert.StartsWith(L2ProjectionKeys.Workflow(W) + ":cache:", L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme"));
    }

    [Fact]
    public void TheStoreRoundTripsWithItsFieldNames()
    {
        var store = new WorkflowStoreProjection(
            EntryStepIds: [S],
            Cron: "0 0/5 * * * ?",
            Steps: [new StepL1(S, 4, P, "{}", [])]);

        var json = JsonSerializer.Serialize(store, MessagingJson.Options);
        var back = JsonSerializer.Deserialize<WorkflowStoreProjection>(json, MessagingJson.Options)!;

        Assert.Contains("\"entryStepIds\"", json);
        Assert.Contains("\"cron\"", json);
        Assert.Contains("\"steps\"", json);
        Assert.Equal([S], back.EntryStepIds);
        Assert.Equal("0 0/5 * * * ?", back.Cron);
        Assert.Equal(P, Assert.Single(back.Steps).ProcessorId);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: build FAILS with `CS0117: 'L2ProjectionKeys' does not contain a definition for 'Workflow'` (and similar for `L2EntityKind`, `WorkflowStoreProjection`).

- [ ] **Step 3: Write the implementation**

Create `src/Messaging.Contracts/Projections/L2EntityKind.cs`:

```csharp
namespace Messaging.Contracts.Projections;

/// <summary>
/// Which entity an L2 key names. The key layout carries a type segment (<c>wf:</c>, <c>step:</c>,
/// <c>proc:</c>) so a reader that knows only an id and its kind can address the one key that holds it.
/// </summary>
public enum L2EntityKind
{
    Workflow,
    Step,
    Processor,
}
```

Create `src/Messaging.Contracts/Projections/WorkflowStoreProjection.cs`:

```csharp
using System.Text.Json.Serialization;

namespace Messaging.Contracts.Projections;

/// <summary>
/// The <c>store</c> field of <c>skp:wf:{id}</c>: the flattened L1 structure a start validated and
/// wrote. The orchestrator builds its L1 entry from this one value — there are no per-step keys to
/// read, so there is no torn projection to survive.
/// </summary>
public sealed record WorkflowStoreProjection(
    [property: JsonPropertyName("entryStepIds")] List<Guid> EntryStepIds,
    [property: JsonPropertyName("cron")]         string? Cron,
    [property: JsonPropertyName("steps")]        List<StepL1> Steps);
```

In `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs`:

1. Replace the `<list type="bullet">` block in the class summary with:

```csharp
/// <list type="bullet">
///   <item><description>Live: <c>skp:live</c> — SET of running workflow ids</description></item>
///   <item><description>Workflow: <c>skp:wf:{workflowId}</c> — HASH <c>name</c>, <c>store</c>, <c>roots</c></description></item>
///   <item><description>StepEntity: <c>skp:step:{stepId}</c> — HASH <c>name</c></description></item>
///   <item><description>Processor: <c>skp:proc:{processorId}</c> — HASH <c>name</c>, written by the processor, TTL</description></item>
///   <item><description>ProcessorInstances: <c>skp:proc:{processorId}:instances</c> — SET, TTL</description></item>
///   <item><description>PerInstance: <c>skp:proc:{processorId}:{instanceId}</c> — liveness, TTL</description></item>
///   <item><description>Cache: <c>skp:wf:{workflowId}:cache:{root}</c> — one dictionary's key list</description></item>
///   <item><description>CacheEntry: <c>skp:wf:{workflowId}:cache:{root}:{key}</c> — one entry</description></item>
///   <item><description>ExecutionData: <c>skp:data:{guid}</c> — the blob for both roles</description></item>
///   <item><description>Retiring (removed by later tasks): ParentIndex <c>skp:</c>, Root <c>skp:{workflowId}</c>, Step <c>skp:{workflowId}:{stepId}</c>, InstanceIndex <c>skp:proc:{processorId}</c> as a SET, Name <c>skp:name:{id}</c></description></item>
/// </list>
```

2. Add below `public const string Prefix = "skp:";`:

```csharp
    /// <summary>The display-name field on every entity hash.</summary>
    public const string NameField = "name";

    /// <summary>The flattened L1 structure on <see cref="Workflow"/>; see <see cref="WorkflowStoreProjection"/>.</summary>
    public const string StoreField = "store";

    /// <summary>The JSON list of cache roots on <see cref="Workflow"/>, read back by the next start to find its own leftovers.</summary>
    public const string RootsField = "roots";

    private const string InstancesSuffix = ":instances";

    /// <summary>The SET of running workflow ids: start adds, stop removes, hydration reads.</summary>
    public static string Live() => $"{Prefix}live";

    public static string Workflow(Guid workflowId) => $"{Prefix}wf:{workflowId:D}";

    /// <summary>A step's own key. Global, not per workflow: a step can be shared by several workflows.</summary>
    public static string StepEntity(Guid stepId) => $"{Prefix}step:{stepId:D}";

    /// <summary>A processor's name hash. Written only by the processor's own instances, with a TTL.</summary>
    public static string Processor(Guid processorId) => $"{Prefix}proc:{processorId:D}";

    public static string Entity(L2EntityKind kind, Guid id) => kind switch
    {
        L2EntityKind.Workflow  => Workflow(id),
        L2EntityKind.Step      => StepEntity(id),
        L2EntityKind.Processor => Processor(id),
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "unknown entity kind"),
    };

    /// <summary>The SET each replica adds its instance id to. TTL, refreshed by every heartbeat.</summary>
    public static string ProcessorInstances(Guid processorId) => $"{Processor(processorId)}{InstancesSuffix}";

    /// <summary>
    /// The inverse of <see cref="ProcessorInstances"/>, for the orphan sweeper, which finds these keys
    /// by scan and has to rebuild each member's <see cref="PerInstance"/> key from them.
    /// </summary>
    public static bool TryParseProcessorInstances(string key, out Guid processorId)
    {
        processorId = Guid.Empty;
        var head = $"{Prefix}proc:";

        if (key is null
            || !key.StartsWith(head, StringComparison.Ordinal)
            || !key.EndsWith(InstancesSuffix, StringComparison.Ordinal))
        {
            return false;
        }

        var id = key.AsSpan(head.Length, key.Length - head.Length - InstancesSuffix.Length);
        return Guid.TryParseExact(id, "D", out processorId);
    }
```

3. Change `Cache` to build under the workflow key (keep its existing doc comment, replace its first sentence's shape with `skp:wf:{workflowId}:cache:{root}`):

```csharp
    public static string Cache(Guid workflowId, string root)
        => $"{Workflow(workflowId)}:cache:{root}";
```

4. Change `PerInstance` to build from `Processor` (same string as before):

```csharp
    public static string PerInstance(Guid processorId, string instanceId)
        => $"{Processor(processorId)}:{instanceId}";
```

In `src/tests/BaseApi.Tests/Cache/CacheKeyTests.cs`:
- line 21: `"skp:wf:11111111-1111-1111-1111-111111111111:cache:sk-whitelist",`
- line 29: `"skp:wf:11111111-1111-1111-1111-111111111111:cache:sk-whitelist:acme",`
- line 53: `Assert.StartsWith($"skp:wf:{W:D}:cache:", L2ProjectionKeys.Cache(W, "sk-whitelist"));`
- lines 47-49 comment: replace with `// A step key is skp:{workflowId}:{stepId} and a cache key is skp:wf:{workflowId}:cache:… — different type segments, so they cannot collide.`

- [ ] **Step 4: Pack and run the tests**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Projection.L2KeyLayoutTests" --filter-class "BaseApi.Tests.Cache.CacheKeyTests"`
Expected: all PASS.

Then the full suite: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: `failed: 0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/Messaging.Contracts src/tests/BaseApi.Tests/Projection/L2KeyLayoutTests.cs src/tests/BaseApi.Tests/Cache/CacheKeyTests.cs
git add -u   # regenerated .nupkg files and packages.lock.json
git commit -m "feat(contracts): typed L2 entity keys, the live set, and the workflow store shape

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: InMemoryL2 — hashes, TTLs and SISMEMBER

The fake only knows strings and sets. Every later task asserts on hashes, TTLs and live-set membership.

**Files:**
- Modify: `src/tests/BaseApi.Tests/Support/InMemoryL2.cs`
- Create: `src/tests/BaseApi.Tests/Support/InMemoryL2Tests.cs`

**Interfaces:**
- Produces (test-only):
  - `InMemoryL2.HashValue(string key, string field) : string?`
  - `InMemoryL2.HasHash(string key) : bool`
  - `InMemoryL2.Ttl(string key) : TimeSpan?`
  - wired: `HashSetAsync(key, field, value, When, CommandFlags)`, `HashSetAsync(key, HashEntry[], CommandFlags)`, `HashGetAsync(key, field, CommandFlags)`, `SetContainsAsync(key, value, CommandFlags)`, `KeyExpireAsync(key, TimeSpan?, ExpireWhen, CommandFlags)`; TTL recorded by the 5-arg `StringSetAsync`; `KeyExistsAsync` / `KeyDeleteAsync` cover all three types; `Snapshot()` includes hashes.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Support/InMemoryL2Tests.cs`:

```csharp
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Support;

public sealed class InMemoryL2Tests
{
    [Fact]
    public async Task AHashFieldIsStoredAndReadBack()
    {
        var l2 = new InMemoryL2();

        await l2.Db.HashSetAsync("skp:wf:a", "name", "chain");
        await l2.Db.HashSetAsync("skp:wf:a", [new HashEntry("store", "{}"), new HashEntry("roots", "[]")]);

        Assert.Equal("chain", (string?)await l2.Db.HashGetAsync("skp:wf:a", "name"));
        Assert.Equal("{}", l2.HashValue("skp:wf:a", "store"));
        Assert.True(l2.HasHash("skp:wf:a"));
        Assert.True((await l2.Db.HashGetAsync("skp:wf:a", "missing")).IsNull);
    }

    [Fact]
    public async Task ExpireIsRecordedForAnExistingKeyOnly()
    {
        var l2 = new InMemoryL2();
        await l2.Db.SetAddAsync("skp:proc:p:instances", "pod-0");

        Assert.True(await l2.Db.KeyExpireAsync("skp:proc:p:instances", TimeSpan.FromSeconds(40), ExpireWhen.Always, CommandFlags.None));
        Assert.False(await l2.Db.KeyExpireAsync("skp:absent", TimeSpan.FromSeconds(40), ExpireWhen.Always, CommandFlags.None));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl("skp:proc:p:instances"));
        Assert.Null(l2.Ttl("skp:absent"));
    }

    [Fact]
    public async Task AStringWrittenWithAnExpiryRecordsItsTtl()
    {
        var l2 = new InMemoryL2();

        await l2.Db.StringSetAsync("skp:proc:p:pod-0", "{}", TimeSpan.FromSeconds(40), When.Always, CommandFlags.None);

        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl("skp:proc:p:pod-0"));
    }

    [Fact]
    public async Task SetContainsAnswersMembership()
    {
        var l2 = new InMemoryL2();
        await l2.Db.SetAddAsync("skp:live", "w1");

        Assert.True(await l2.Db.SetContainsAsync("skp:live", "w1"));
        Assert.False(await l2.Db.SetContainsAsync("skp:live", "w2"));
    }

    [Fact]
    public async Task ExistsAndDeleteCoverEveryType()
    {
        var l2 = new InMemoryL2();
        await l2.Db.StringSetAsync("s", "v");
        await l2.Db.HashSetAsync("h", "f", "v");
        await l2.Db.SetAddAsync("set", "m");

        Assert.True(await l2.Db.KeyExistsAsync("h"));
        Assert.True(await l2.Db.KeyExistsAsync("set"));
        Assert.Equal(3, await l2.Db.KeyDeleteAsync(["s", "h", "set"]));
        Assert.False(await l2.Db.KeyExistsAsync("h"));
        Assert.Empty(l2.Members("set"));
    }

    [Fact]
    public async Task TheSnapshotIncludesHashes()
    {
        var l2 = new InMemoryL2();
        await l2.Db.HashSetAsync("skp:step:s", "name", "step-a");

        Assert.Contains("hash skp:step:s.name = step-a", l2.Snapshot());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: build FAILS — `'InMemoryL2' does not contain a definition for 'HashValue'`.

- [ ] **Step 3: Write the implementation**

In `src/tests/BaseApi.Tests/Support/InMemoryL2.cs`:

1. Update the class summary's first sentence to "strings, sets and hashes in three dictionaries, plus the TTL last applied to each key".
2. Add fields after `_sets`:

```csharp
    private readonly Dictionary<string, Dictionary<string, string>> _hashes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TimeSpan> _ttls = new(StringComparer.Ordinal);
```

3. Add public accessors after `Keys()`:

```csharp
    /// <summary>One hash field, or null when the key or the field is absent.</summary>
    public string? HashValue(string key, string field)
        => _hashes.TryGetValue(key, out var h) && h.TryGetValue(field, out var v) ? v : null;

    /// <summary>Whether a hash key exists right now.</summary>
    public bool HasHash(string key) => _hashes.ContainsKey(key);

    /// <summary>The TTL last applied to <paramref name="key"/>, or null when none was. Recorded, not enforced.</summary>
    public TimeSpan? Ttl(string key) => _ttls.TryGetValue(key, out var t) ? t : null;
```

4. In `Snapshot()`, concatenate hash lines before `.Order(...)`:

```csharp
            .Concat(_hashes.SelectMany(kv => kv.Value.Select(f => $"hash {kv.Key}.{f.Key} = {f.Value}")))
```

5. Add private helpers:

```csharp
    private bool Exists(string key)
        => _strings.ContainsKey(key) || _hashes.ContainsKey(key)
           || (_sets.TryGetValue(key, out var set) && set.Count > 0);

    private bool Delete(string key)
    {
        var removed = _strings.Remove(key) | _hashes.Remove(key) | _sets.Remove(key);
        _ttls.Remove(key);
        return removed;
    }

    private Dictionary<string, string> Hash(string key)
    {
        if (!_hashes.TryGetValue(key, out var h))
        {
            h = new Dictionary<string, string>(StringComparer.Ordinal);
            _hashes[key] = h;
        }

        return h;
    }
```

6. In `Wire`:
   - Replace the 5-arg `StringSetAsync` stub so it records the TTL:

```csharp
        target.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                              Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var key = ci.ArgAt<RedisKey>(0).ToString();
                _strings[key] = ci.ArgAt<RedisValue>(1).ToString();
                if (ci.ArgAt<TimeSpan?>(2) is { } ttl)
                {
                    _ttls[key] = ttl;
                }

                return Task.FromResult(true);
            });
```

   - Replace the `KeyExistsAsync` and both `KeyDeleteAsync` stubs:

```csharp
        target.KeyExistsAsync(Arg.Any<RedisKey>())
            .Returns(ci => Exists(ci.ArgAt<RedisKey>(0).ToString()));

        target.KeyDeleteAsync(Arg.Any<RedisKey>())
            .Returns(ci => Delete(ci.ArgAt<RedisKey>(0).ToString()));

        target.KeyDeleteAsync(Arg.Any<RedisKey[]>())
            .Returns(ci => (long)ci.ArgAt<RedisKey[]>(0).Count(k => Delete(k.ToString())));
```

   - Add at the end of `Wire`:

```csharp
        target.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(),
                            Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var h = Hash(ci.ArgAt<RedisKey>(0).ToString());
                var field = ci.ArgAt<RedisValue>(1).ToString();
                var added = !h.ContainsKey(field);
                h[field] = ci.ArgAt<RedisValue>(2).ToString();
                return added;
            });

        target.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<HashEntry[]>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var h = Hash(ci.ArgAt<RedisKey>(0).ToString());
                foreach (var entry in ci.ArgAt<HashEntry[]>(1))
                {
                    h[entry.Name.ToString()] = entry.Value.ToString();
                }

                return Task.CompletedTask;
            });

        target.HashGetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(ci => HashValue(ci.ArgAt<RedisKey>(0).ToString(), ci.ArgAt<RedisValue>(1).ToString())
                           is { } v ? (RedisValue)v : RedisValue.Null);

        target.SetContainsAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(ci => _sets.TryGetValue(ci.ArgAt<RedisKey>(0).ToString(), out var set)
                           && set.Contains(ci.ArgAt<RedisValue>(1).ToString()));

        target.KeyExpireAsync(Arg.Any<RedisKey>(), Arg.Any<TimeSpan?>(), Arg.Any<ExpireWhen>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var key = ci.ArgAt<RedisKey>(0).ToString();
                if (!Exists(key))
                {
                    return false;
                }

                if (ci.ArgAt<TimeSpan?>(1) is { } ttl)
                {
                    _ttls[key] = ttl;
                }

                return true;
            });
```

- [ ] **Step 4: Run the tests**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Support.InMemoryL2Tests"`
Expected: 6 PASS. Then the full suite: `failed: 0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Support/InMemoryL2.cs src/tests/BaseApi.Tests/Support/InMemoryL2Tests.cs
git commit -m "test(support): InMemoryL2 stores hashes, records TTLs, answers SISMEMBER

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Processor instance set moves to `skp:proc:{id}:instances` with a TTL

Frees `skp:proc:{id}` for the processor's name hash (Task 4). Writer, validator and sweeper move together, and `InstanceIndex` is removed.

**Files:**
- Modify: `src/BaseProcessor.Core/Liveness/ProcessorLivenessWriter.cs:26-45`
- Modify: `src/BaseApi.Service/Features/Orchestration/Validation/ProcessorLivenessValidator.cs:29`
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/RedisL2InstanceIndexStore.cs:26,49-64`
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` (delete `InstanceIndex`)
- Modify: `src/tests/BaseApi.Tests/Processor/LivenessWriterTests.cs:91-111`
- Modify: `src/tests/BaseApi.Tests/Orchestration/ProcessorLivenessValidatorTests.cs` (every `InstanceIndex(` → `ProcessorInstances(`)
- Modify: `src/tests/BaseApi.Tests/Naming/NameProjectionTests.cs:106-110` (scan-pattern assertion)

**Interfaces:**
- Consumes: `L2ProjectionKeys.ProcessorInstances`, `TryParseProcessorInstances` (Task 1).
- Produces: `ProcessorLivenessWriter.WriteAsync(Guid, string, ProcessorLivenessEntry)` writes `PerInstance` (TTL), then `SADD ProcessorInstances` + `EXPIRE` with the same TTL. (Its signature changes in Task 4.)

- [ ] **Step 1: Write the failing test**

In `src/tests/BaseApi.Tests/Processor/LivenessWriterTests.cs`, replace `WritesTheKeyAndTheIndexOnTheHappyPath` with:

```csharp
    [Fact]
    public async Task WritesTheKeyAndTheInstanceSetBothWithTheTtl()
    {
        var l2 = new InMemoryL2();
        var (writer, log) = Build(l2.Multiplexer);
        var processorId = Guid.NewGuid();

        await writer.WriteAsync(processorId, "instance-1", Entry());

        // TTL is four times the entry's own recorded interval: 10 * 4 = 40. The instance set carries
        // the same TTL, so a processor whose replicas are all gone leaves nothing behind.
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(L2ProjectionKeys.PerInstance(processorId, "instance-1")));
        Assert.Equal(["instance-1"], l2.Members(L2ProjectionKeys.ProcessorInstances(processorId)));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(L2ProjectionKeys.ProcessorInstances(processorId)));
        Assert.Empty(log.Records);
    }
```

In `NameProjectionTests.NoProductionSourceScansTheKeySpace`, change the final assertion to pin the narrowed pattern:

```csharp
        Assert.All(hits, t => Assert.Contains("Prefix}proc:*:instances", t.l, StringComparison.Ordinal));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.LivenessWriterTests" --filter-class "BaseApi.Tests.Naming.NameProjectionTests"`
Expected: `WritesTheKeyAndTheInstanceSetBothWithTheTtl` FAILS (members empty; the writer still adds to `skp:proc:{id}`), `NoProductionSourceScansTheKeySpace` FAILS (pattern is still `proc:*`).

- [ ] **Step 3: Write the implementation**

`ProcessorLivenessWriter.WriteAsync` body inside the `try`:

```csharp
            var db = _redis.GetDatabase();
            var ttl = TimeSpan.FromSeconds(DeriveTtlSeconds(entry.Interval));

            await db.StringSetAsync(
                L2ProjectionKeys.PerInstance(processorId, instanceId),
                System.Text.Json.JsonSerializer.Serialize(entry),
                ttl,
                When.Always,
                CommandFlags.None).ConfigureAwait(false);

            // The set gets the liveness TTL too, refreshed by every replica's beat: while one replica
            // lives the set stays and the sweeper prunes the dead members; once none does, the set
            // expires with them and nothing is left behind for BaseApi to clean.
            var instances = L2ProjectionKeys.ProcessorInstances(processorId);
            await db.SetAddAsync(instances, instanceId).ConfigureAwait(false);
            await db.KeyExpireAsync(instances, ttl, ExpireWhen.Always, CommandFlags.None).ConfigureAwait(false);
```

`ProcessorLivenessValidator.cs:29`:

```csharp
            var members = await db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(proc.Id));
```

`RedisL2InstanceIndexStore.cs` — scan pattern (line 26) and the comment above the type filter:

```csharp
            foreach (var key in server.Keys(pattern: $"{L2ProjectionKeys.Prefix}proc:*:instances", pageSize: 250))
            {
                ct.ThrowIfCancellationRequested();

                // The pattern already excludes the name hash and the per-instance keys; the type check
                // stays so a stray non-set key under this suffix can never be reported as an index.
                if (await db.KeyTypeAsync(key).ConfigureAwait(false) is RedisType.Set)
```

and `TryRemoveIfAbsentAsync`:

```csharp
    public async Task<bool> TryRemoveIfAbsentAsync(string indexKey, string instanceId, CancellationToken ct)
    {
        if (!L2ProjectionKeys.TryParseProcessorInstances(indexKey, out var processorId))
        {
            return false;   // not an instances key; nothing this sweeper may touch
        }

        var db = _multiplexer.GetDatabase();
        var perInstance = L2ProjectionKeys.PerInstance(processorId, instanceId);

        var tran = db.CreateTransaction();
        tran.AddCondition(Condition.KeyNotExists(perInstance));
        var removal = tran.SetRemoveAsync(indexKey, instanceId);

        if (!await tran.ExecuteAsync().ConfigureAwait(false))
        {
            return false;   // the key came back; the condition refused the transaction
        }

        return await removal.ConfigureAwait(false);
    }
```

`L2ProjectionKeys.cs`: delete the `InstanceIndex` method and its doc comment; remove `InstanceIndex` from the "Retiring" list item.

`ProcessorLivenessValidatorTests.cs`: replace every `L2ProjectionKeys.InstanceIndex(` with `L2ProjectionKeys.ProcessorInstances(`.

Then confirm nothing else references the removed member:

Run: `grep -rn "InstanceIndex(" src --include=*.cs | grep -v /bin/ | grep -v /obj/`
Expected: no output.

- [ ] **Step 4: Pack and run the tests**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: `failed: 0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A src/Messaging.Contracts src/BaseProcessor.Core src/BaseApi.Service src/tests/BaseApi.Tests
git add -u
git commit -m "feat(liveness): instance set at skp:proc:{id}:instances with the liveness TTL

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Processors write their own name hash

**Files:**
- Modify: `src/BaseProcessor.Core/Liveness/ProcessorLivenessWriter.cs`
- Modify: `src/BaseProcessor.Core/Liveness/ProcessorLivenessHeartbeat.cs:104`
- Modify: `src/BaseProcessor.Core/Startup/ProcessorStartupOrchestrator.cs:334`
- Modify: `src/tests/BaseApi.Tests/Processor/LivenessWriterTests.cs` (all `WriteAsync(Guid…` calls)
- Test: `src/tests/BaseApi.Tests/Processor/LivenessWriterTests.cs`

**Interfaces:**
- Consumes: `L2ProjectionKeys.Processor`, `NameField` (Task 1); `EntityNames.Format(string, string, Guid)` (existing, `Messaging.Contracts`); `ProcessorIdentity(Guid Id, Guid? InputSchemaId, Guid? OutputSchemaId, Guid? ConfigSchemaId, string Name, string Version, string? InputDefinition, string? OutputDefinition)` (existing).
- Produces: `ProcessorLivenessWriter.WriteAsync(ProcessorIdentity identity, string instanceId, ProcessorLivenessEntry entry) : Task`. Write order: per-instance key → instance set + TTL → name hash + TTL.

- [ ] **Step 1: Write the failing tests**

In `LivenessWriterTests.cs` add `using BaseProcessor.Core.Identity;` and `using Messaging.Contracts;`, then add:

```csharp
    private static readonly Guid P = Guid.Parse("44444444-4444-4444-dddd-444444444444");

    private static ProcessorIdentity Identity() =>
        new(P, null, null, null, "shared-proc", "1.2.0", null, null);

    [Fact]
    public async Task WritesItsOwnFullNameWithTheLivenessTtl()
    {
        var l2 = new InMemoryL2();
        var (writer, _) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());

        Assert.Equal(EntityNames.Format("shared-proc", "1.2.0", P),
                     l2.HashValue(L2ProjectionKeys.Processor(P), L2ProjectionKeys.NameField));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(L2ProjectionKeys.Processor(P)));
    }

    [Fact]
    public async Task EveryReplicaWritesTheSameNameWithNoInstanceIdInIt()
    {
        var l2 = new InMemoryL2();
        var (writer, _) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());
        var first = l2.HashValue(L2ProjectionKeys.Processor(P), L2ProjectionKeys.NameField);
        await writer.WriteAsync(Identity(), "pod-1", Entry());

        Assert.Equal(first, l2.HashValue(L2ProjectionKeys.Processor(P), L2ProjectionKeys.NameField));
        Assert.DoesNotContain("pod-", first);
    }

    [Fact]
    public async Task ANameWriteFailureStillLeavesTheLivenessKey()
    {
        // During rollout the old SET still sits at skp:proc:{id}, so HSET there answers WRONGTYPE. The
        // liveness key is what the start gate reads; it must already be written when the name fails.
        var l2 = new InMemoryL2();
        l2.Db.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(),
                           Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Throws(new RedisServerException("WRONGTYPE Operation against a key holding the wrong kind of value"));
        var (writer, log) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());

        Assert.True(l2.Has(L2ProjectionKeys.PerInstance(P, "pod-0")));
        Assert.Equal(["pod-0"], l2.Members(L2ProjectionKeys.ProcessorInstances(P)));
        Assert.Equal(LogLevel.Warning, Assert.Single(log.Records).Level);
    }
```

Update the existing tests' calls: every `writer.WriteAsync(Guid.NewGuid(), "instance-1", …)` and `writer.WriteAsync(processorId, "instance-1", …)` becomes `writer.WriteAsync(Identity(), "instance-1", …)`; in `WritesTheKeyAndTheInstanceSetBothWithTheTtl` replace `processorId` with `P`. `NullEntryStillThrows` becomes `writer.WriteAsync(Identity(), "instance-1", null!)`, and add:

```csharp
    [Fact]
    public async Task NullIdentityStillThrows()
    {
        var (writer, _) = Build(Substitute.For<IConnectionMultiplexer>());

        await Assert.ThrowsAsync<ArgumentNullException>(() => writer.WriteAsync(null!, "instance-1", Entry()));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: build FAILS — `cannot convert from 'ProcessorIdentity' to 'System.Guid'`.

- [ ] **Step 3: Write the implementation**

`ProcessorLivenessWriter.cs` — add `using BaseProcessor.Core.Identity;` and `using Messaging.Contracts;`, then replace `WriteAsync`:

```csharp
    public async Task WriteAsync(ProcessorIdentity identity, string instanceId, ProcessorLivenessEntry entry)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(entry);
        try
        {
            var db = _redis.GetDatabase();
            var ttl = TimeSpan.FromSeconds(DeriveTtlSeconds(entry.Interval));

            // Liveness first: it is what the start gate reads, so a failure further down (a WRONGTYPE
            // against a pre-migration key, a timeout) must not cost it.
            await db.StringSetAsync(
                L2ProjectionKeys.PerInstance(identity.Id, instanceId),
                System.Text.Json.JsonSerializer.Serialize(entry),
                ttl,
                When.Always,
                CommandFlags.None).ConfigureAwait(false);

            var instances = L2ProjectionKeys.ProcessorInstances(identity.Id);
            await db.SetAddAsync(instances, instanceId).ConfigureAwait(false);
            await db.KeyExpireAsync(instances, ttl, ExpireWhen.Always, CommandFlags.None).ConfigureAwait(false);

            // THE PROCESSOR OWNS ITS NAME. Written on every beat with the same TTL, so a flushed key
            // heals within one interval and a processor that is gone for good leaves nothing. The id
            // suffix, never the instance id: every replica writes this one key.
            var processorKey = L2ProjectionKeys.Processor(identity.Id);
            await db.HashSetAsync(
                processorKey, L2ProjectionKeys.NameField,
                EntityNames.Format(identity.Name, identity.Version, identity.Id)).ConfigureAwait(false);
            await db.KeyExpireAsync(processorKey, ttl, ExpireWhen.Always, CommandFlags.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "liveness write failed for {ProcessorId}/{InstanceId}", identity.Id, instanceId);
        }
    }
```

`ProcessorLivenessHeartbeat.cs:104`:

```csharp
            await _writer.WriteAsync(identity, _instanceId.Value, entry).ConfigureAwait(false);
```

`ProcessorStartupOrchestrator.cs:334`:

```csharp
        await _writer.WriteAsync(identity, _instanceId.Value, entry).ConfigureAwait(false);
```

Run: `grep -rn "_writer.WriteAsync\|writer.WriteAsync" src --include=*.cs | grep -v /bin/ | grep -v /obj/`
Expected: every hit passes an identity, not a `Guid`.

- [ ] **Step 4: Pack and run the tests**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: `failed: 0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A src/BaseProcessor.Core src/tests/BaseApi.Tests
git add -u
git commit -m "feat(liveness): each processor instance writes its own name hash with the TTL

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Names are read and written as typed hashes

Readers ask for `(kind, id)` and read `HGET skp:{kind}:{id} name`. BaseApi writes the workflow and step names into their hashes and no longer writes processor names. `L2ProjectionKeys.Name` is removed.

**Files:**
- Create: `src/BaseConsole.Core/Naming/EntityRef.cs`
- Modify: `src/BaseConsole.Core/Naming/IEntityNameSource.cs`
- Modify: `src/BaseConsole.Core/Naming/RedisEntityNameSource.cs`
- Modify: `src/BaseConsole.Core/Naming/EntityNameResolver.cs`
- Modify: `src/Orchestrator/L1/L2WorkflowReader.cs:34-41`
- Modify: `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs:218-222`
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs:125-138`
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` (delete `Name`)
- Modify: `src/tests/BaseApi.Tests/Support/FakeNameSource.cs`
- Modify: `src/tests/BaseApi.Tests/Naming/NameProjectionTests.cs`, `EntityNamesTests.cs:27`, `EntityNameResolverTests.cs`, `OrchestratorNamesTests.cs:20-28`

**Interfaces:**
- Consumes: `L2EntityKind`, `L2ProjectionKeys.Entity`, `NameField` (Task 1).
- Produces:
  - `readonly record struct EntityRef(L2EntityKind Kind, Guid Id)` (namespace `BaseConsole.Core.Naming`)
  - `IEntityNameSource.ReadNamesAsync(IReadOnlyCollection<EntityRef> refs) : Task<IReadOnlyDictionary<Guid, string>>`
  - `RedisEntityNameSource.ReadAsync(IDatabaseAsync db, IReadOnlyCollection<EntityRef> refs)` (static)
  - `EntityNameResolver.PreloadAsync(IEnumerable<EntityRef> refs) : Task` (never throws; same timeout and fallback as `ScopeAsync`)
  - `FakeNameSource.Requested : List<EntityRef>` (test-only)

- [ ] **Step 1: Write the failing tests**

Replace `src/tests/BaseApi.Tests/Support/FakeNameSource.cs` body:

```csharp
internal sealed class FakeNameSource(Dictionary<Guid, string>? names = null) : IEntityNameSource
{
    public Dictionary<Guid, string> Names { get; } = names ?? new();

    public Exception? Fault { get; set; }

    /// <summary>When true, <see cref="ReadNamesAsync"/> returns a task that never completes -- a
    /// stalled (not faulted) store, e.g. a Redis connection stuck behind CLIENT PAUSE.</summary>
    public bool Stall { get; set; }

    public int Reads { get; private set; }

    /// <summary>Every reference asked for, in order, across all reads — so a test can assert the kind
    /// each id was asked under.</summary>
    public List<EntityRef> Requested { get; } = new();

    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs)
    {
        Reads++;
        Requested.AddRange(refs);
        if (Stall)
        {
            return new TaskCompletionSource<IReadOnlyDictionary<Guid, string>>().Task;
        }

        if (Fault is not null)
        {
            return Task.FromException<IReadOnlyDictionary<Guid, string>>(Fault);
        }

        IReadOnlyDictionary<Guid, string> found = refs.Select(r => r.Id).Where(Names.ContainsKey)
            .ToDictionary(id => id, id => Names[id]);
        return Task.FromResult(found);
    }
}
```

Add to `src/tests/BaseApi.Tests/Naming/EntityNameResolverTests.cs`:

```csharp
    [Fact]
    public async Task EachIdIsAskedForUnderItsOwnKind()
    {
        var w = Guid.NewGuid(); var s = Guid.NewGuid(); var p = Guid.NewGuid();
        var source = new FakeNameSource();
        var resolver = new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance);

        await resolver.ScopeAsync(w, s, p);

        Assert.Equal(
            [new EntityRef(L2EntityKind.Workflow, w), new EntityRef(L2EntityKind.Step, s), new EntityRef(L2EntityKind.Processor, p)],
            source.Requested);
    }

    [Fact]
    public async Task APreloadFillsTheCacheSoTheNextScopeReadsNothing()
    {
        var w = Guid.NewGuid(); var s = Guid.NewGuid();
        var source = new FakeNameSource(new() { [w] = "chain_1.0.0-aaaa-111111111111", [s] = "step-a_1.0.0-bbbb-222222222222" });
        var resolver = new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance);

        await resolver.PreloadAsync([new(L2EntityKind.Workflow, w), new(L2EntityKind.Step, s)]);
        var reads = source.Reads;
        await resolver.ScopeAsync(w, s, Guid.Empty);

        Assert.Equal(reads, source.Reads);
        Assert.Equal("chain_1.0.0-aaaa-111111111111", resolver.NameOrFallback(w));
    }

    [Fact]
    public async Task APreloadAgainstAFaultingStoreDoesNotThrow()
    {
        var source = new FakeNameSource { Fault = new InvalidOperationException("down") };
        var resolver = new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance);

        await resolver.PreloadAsync([new(L2EntityKind.Workflow, Guid.NewGuid())]);
    }

    [Fact]
    public async Task TheRedisSourceReadsTheNameFieldOfEachKindsHash()
    {
        var w = Guid.NewGuid(); var p = Guid.NewGuid();
        var l2 = new InMemoryL2();
        await l2.Db.HashSetAsync(L2ProjectionKeys.Workflow(w), L2ProjectionKeys.NameField, "chain_1.0.0-aaaa-111111111111");
        await l2.Db.HashSetAsync(L2ProjectionKeys.Processor(p), L2ProjectionKeys.NameField, "proc_1.0.0-dddd-444444444444");

        var found = await RedisEntityNameSource.ReadAsync(l2.Db,
            [new(L2EntityKind.Workflow, w), new(L2EntityKind.Processor, p), new(L2EntityKind.Step, Guid.NewGuid())]);

        Assert.Equal(2, found.Count);
        Assert.Equal("proc_1.0.0-dddd-444444444444", found[p]);
    }
```

(Add `using Messaging.Contracts.Projections;` and `using BaseApi.Tests.Support;` if missing. In the same file, delete or rewrite every existing test that seeds `L2ProjectionKeys.Name(...)` with `StringSetAsync` so it seeds `HashSetAsync(L2ProjectionKeys.Workflow(id) /*or StepEntity/Processor by the role the id plays*/, L2ProjectionKeys.NameField, value)`; any direct `ReadNamesAsync([id])` call becomes `ReadNamesAsync([new EntityRef(L2EntityKind.Workflow, id)])`.)

Rewrite `src/tests/BaseApi.Tests/Naming/NameProjectionTests.cs` tests 1–3:

```csharp
    [Fact]
    public void TheDefinitionNamesTheWorkflowAndEachStepButNoProcessor()
    {
        using var snapshot = Snapshot();

        var names = OrchestrationService.ToDefinitionForTests(snapshot, W).Names!;

        // Processors own their own name key now; BaseApi never writes one.
        Assert.Equal(3, names.Count);
        Assert.Equal(EntityNames.Format("chain", "1.0.0", W), names[W]);
        Assert.Equal(EntityNames.Format("step-b", "2.0.0", S2), names[S2]);
        Assert.False(names.ContainsKey(P));
    }

    [Fact]
    public async Task TheWriterPutsEachNameOnItsEntityHash()
    {
        using var snapshot = Snapshot();
        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);
        var l2 = new InMemoryL2();

        await new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider()).WriteAsync(definition, CancellationToken.None);

        Assert.Equal(definition.Names![W], l2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField));
        Assert.Equal(definition.Names![S1], l2.HashValue(L2ProjectionKeys.StepEntity(S1), L2ProjectionKeys.NameField));
        Assert.Equal(definition.Names![S2], l2.HashValue(L2ProjectionKeys.StepEntity(S2), L2ProjectionKeys.NameField));
        Assert.False(l2.HasHash(L2ProjectionKeys.Processor(P)));
    }

    [Fact]
    public async Task ANameForAnIdThatIsNeitherTheWorkflowNorOneOfItsStepsIsNotWritten()
    {
        var stranger = Guid.NewGuid();
        var l2 = new InMemoryL2();

        await new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider())
            .WriteAsync(new WorkflowL1(W, [], null, [], [], new() { [stranger] = "x_1-0000-000000000000" }), CancellationToken.None);

        Assert.False(l2.HasHash(L2ProjectionKeys.StepEntity(stranger)));
        Assert.False(l2.HasHash(L2ProjectionKeys.Workflow(stranger)));
    }
```

`EntityNamesTests.cs:27` — replace the `L2ProjectionKeys.Name(Id)` assertion with:

```csharp
        Assert.Equal("skp:wf:208cba76-d635-4721-9aff-a7f22ee09224", L2ProjectionKeys.Entity(L2EntityKind.Workflow, Id));
```

`OrchestratorNamesTests.cs` first test — seed and read typed:

```csharp
        var l2 = new InMemoryL2();
        await l2.Db.HashSetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField, "chain_1.0.0-aaaa-111111111111");
        IEntityNameSource source = new L2WorkflowReader(l2.Multiplexer, NullLogger<L2WorkflowReader>.Instance);

        var found = await source.ReadNamesAsync([new EntityRef(L2EntityKind.Workflow, W)]);

        Assert.Equal("chain_1.0.0-aaaa-111111111111", found[W]);
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: build FAILS — `The type or namespace name 'EntityRef' could not be found`.

- [ ] **Step 3: Write the implementation**

Create `src/BaseConsole.Core/Naming/EntityRef.cs`:

```csharp
using Messaging.Contracts.Projections;

namespace BaseConsole.Core.Naming;

/// <summary>An id together with the kind of entity it names — all a reader needs to address its L2 hash.</summary>
public readonly record struct EntityRef(L2EntityKind Kind, Guid Id);
```

`IEntityNameSource.cs` — the method becomes:

```csharp
    Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs);
```

`RedisEntityNameSource.cs`:

```csharp
public sealed class RedisEntityNameSource(IConnectionMultiplexer redis) : IEntityNameSource
{
    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs) =>
        ReadAsync(redis.GetDatabase(), refs);

    /// <summary>
    /// One HGET per reference, all issued before any is awaited, so the cost is one round trip. There is
    /// no multi-key hash read, and the keys span slots anyway.
    /// </summary>
    public static async Task<IReadOnlyDictionary<Guid, string>> ReadAsync(IDatabaseAsync db, IReadOnlyCollection<EntityRef> refs)
    {
        var list = refs.ToArray();
        var reads = new Task<RedisValue>[list.Length];
        for (var i = 0; i < list.Length; i++)
        {
            reads[i] = db.HashGetAsync(L2ProjectionKeys.Entity(list[i].Kind, list[i].Id), L2ProjectionKeys.NameField);
        }

        var values = await Task.WhenAll(reads).ConfigureAwait(false);

        var found = new Dictionary<Guid, string>(list.Length);
        for (var i = 0; i < list.Length; i++)
        {
            if (!values[i].IsNullOrEmpty)
            {
                found[list[i].Id] = values[i].ToString();
            }
        }

        return found;
    }
}
```

`EntityNameResolver.cs` — keep every existing doc comment; replace `ScopeAsync`'s body and add `PreloadAsync` + `LoadAsync` (the existing try/catch/timeout moves into `LoadAsync` unchanged):

```csharp
    public async Task<Dictionary<string, object>> ScopeAsync(Guid workflowId, Guid stepId, Guid processorId)
    {
        await LoadAsync(
        [
            new EntityRef(L2EntityKind.Workflow, workflowId),
            new EntityRef(L2EntityKind.Step, stepId),
            new EntityRef(L2EntityKind.Processor, processorId),
        ]).ConfigureAwait(false);

        return CachedScope(workflowId, stepId, processorId);
    }

    /// <summary>
    /// Fills the cache ahead of use — the orchestrator calls this at activation with the workflow, its
    /// steps and their processors, so the first fire's records are already named. Never throws: a read
    /// that fails or times out leaves those ids to fall back, exactly as <see cref="ScopeAsync"/> does.
    /// </summary>
    public Task PreloadAsync(IEnumerable<EntityRef> refs) => LoadAsync(refs);

    private async Task LoadAsync(IEnumerable<EntityRef> refs)
    {
        var unknown = refs
            .Where(r => r.Id != Guid.Empty && !_names.ContainsKey(r.Id))
            .Distinct()
            .ToArray();

        if (unknown.Length == 0)
        {
            return;
        }

        try
        {
            var found = await source.ReadNamesAsync(unknown).WaitAsync(ReadTimeout).ConfigureAwait(false);
            foreach (var (id, name) in found)
            {
                if (!string.IsNullOrEmpty(name))
                {
                    _names[id] = name;
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "entity names could not be read; logging the id suffix instead");
        }
    }
```

Add `using Messaging.Contracts.Projections;` to `EntityNameResolver.cs`.

`L2WorkflowReader.cs:40-41`:

```csharp
    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs) =>
        RedisEntityNameSource.ReadAsync(redis.GetDatabase(), refs);
```

and in its class summary replace "the MGET of <c>skp:name:{id}</c> keys" with "the HGETs of each entity hash's <c>name</c> field".

`OrchestrationService.ToDefinition` — delete the processor loop:

```csharp
        foreach (var p in snapshot.Processors.Values)
        {
            names[p.Id] = EntityNames.Format(p.Name, p.Version, p.Id);
        }
```

and change the comment above `names` to: `// The workflow and each of its steps, each id once. Processors are absent on purpose: every processor instance writes its own name key.`

`L2ProjectionWriter.cs` — replace the `if (workflow.Names is not null)` block (keep the IDE0028 note):

```csharp
        // THE NAMES, in the same pipelined batch, each on its own entity hash. Only the workflow and its
        // own steps: an id that is neither has no key this start owns. Never deleted -- entities are
        // shared across workflows and records keep arriving after a stop.
        // A null guard, not `?? new Dictionary<...>()`: that fallback inside a deconstructing foreach
        // crashes Roslyn's IDE0028 analyzer (AD0001), which fails the Release build under
        // EnforceCodeStyleInBuild + TreatWarningsAsErrors.
        if (workflow.Names is not null)
        {
            var stepIds = steps.Select(s => s.StepId).ToHashSet();
            foreach (var (id, name) in workflow.Names)
            {
                L2EntityKind? kind = id == workflow.WorkflowId ? L2EntityKind.Workflow
                    : stepIds.Contains(id) ? L2EntityKind.Step
                    : null;

                if (kind is { } k)
                {
                    writes.Add(batch.HashSetAsync(L2ProjectionKeys.Entity(k, id), L2ProjectionKeys.NameField, name));
                }
            }
        }
```

`L2ProjectionKeys.cs`: delete `Name(Guid)` and its doc comment; remove `Name` from the "Retiring" list item.

Run: `grep -rn "L2ProjectionKeys.Name(\|skp:name" src --include=*.cs | grep -v /bin/ | grep -v /obj/`
Expected: no output.

- [ ] **Step 4: Pack and run the tests**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: `failed: 0`, exit 0. (`ConsumerNamesTests` and `ProcessorNamesTests` compile unchanged because they go through `FakeNameSource`; if either calls `ReadNamesAsync` directly, wrap the ids as `EntityRef` with the kind the id plays.)

- [ ] **Step 5: Commit**

```bash
git add -A src/BaseConsole.Core src/Messaging.Contracts src/Orchestrator src/BaseApi.Service src/tests/BaseApi.Tests
git add -u
git commit -m "feat(names): typed entity hashes; BaseApi writes workflow and step names only

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Cut over the projection — store, live set, start/stop, live-set guards

The writer and the reader switch together: `StartStopIdempotencyTests` runs both sides over one `InMemoryL2`, so no split keeps the suite green. One commit at the end.

**Files:**
- Create: `src/BaseApi.Service/Features/Orchestration/Projection/L2LiveSet.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs` (rewrite)
- Delete: `src/BaseApi.Service/Features/Orchestration/Projection/L2Cleanup.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Messaging/StartOrchestrationHandler.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Messaging/StopOrchestrationHandler.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/OrchestrationServiceCollectionExtensions.cs:61-62`
- Modify: `src/Orchestrator/L1/L2WorkflowReader.cs`
- Modify: `src/Orchestrator/L1/WorkflowActivator.cs`
- Modify: `src/Orchestrator/Messaging/ApplyStopHandler.cs:75-83`
- Create: `src/tests/BaseApi.Tests/Support/L2Seed.cs`
- Create: `src/tests/BaseApi.Tests/Orchestration/StartDrivenProjectionTests.cs`
- Create: `src/tests/BaseApi.Tests/Orchestrator/LiveSetActivationTests.cs`
- Modify (existing tests): `Orchestration/FanoutPublishTests.cs`, `Orchestration/StartStopIdempotencyTests.cs`, `Orchestrator/ApplyHandlerTests.cs`, `Orchestrator/HydrationServiceTests.cs`, `Orchestrator/L2WorkflowReaderTests.cs`, `Orchestrator/WorkflowActivatorTests.cs`, `Cache/CacheProjectionWriteTests.cs`, `Cache/CacheProjectionCleanupTests.cs` (→ delete), `Naming/NameProjectionTests.cs`, `Live/RedisReconnectLiveTests.cs`

**Interfaces:**
- Consumes: Tasks 1, 2, 5.
- Produces:
  - `L2LiveSet(IConnectionMultiplexer)`: `AddAsync(Guid) : Task`, `RemoveAsync(Guid) : Task`
  - `L2ProjectionWriter(IConnectionMultiplexer)` (the `TimeProvider` parameter is removed): `WriteAsync(WorkflowL1, CancellationToken) : Task` — writes name/store/roots, caches, step names; deletes its own stale cache keys.
  - `StartOrchestrationHandler(L2ProjectionWriter, L2LiveSet, IQueueFanoutPublisher, ILogger<>)`
  - `StopOrchestrationHandler(L2LiveSet, IQueueFanoutPublisher, ILogger<>)`
  - `L2WorkflowReader.IsLiveAsync(Guid, CancellationToken) : Task<bool>` (replaces `ExistsAsync`)
  - `L2WorkflowReader.ReadAllIdsAsync` reads `skp:live`; `ReadAsync` reads `skp:wf:{id}.store`
  - `WorkflowActivator(L2WorkflowReader, WorkflowL1Store, IWorkflowScheduler, ILogger<WorkflowActivator>, EntityNameResolver? names = null)`
  - test-only `L2Seed.StoreAsync(InMemoryL2, WorkflowL1)`, `L2Seed.LiveAsync(InMemoryL2, WorkflowL1)`

- [ ] **Step 1: Add the seed helper and write the failing BaseApi-side tests**

Create `src/tests/BaseApi.Tests/Support/L2Seed.cs`:

```csharp
using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;

namespace BaseApi.Tests.Support;

/// <summary>Puts a workflow into an <see cref="InMemoryL2"/> exactly as a start leaves it.</summary>
internal static class L2Seed
{
    public static Task StoreAsync(InMemoryL2 l2, WorkflowL1 definition) =>
        l2.Db.HashSetAsync(
            L2ProjectionKeys.Workflow(definition.WorkflowId), L2ProjectionKeys.StoreField,
            JsonSerializer.Serialize(
                new WorkflowStoreProjection(definition.EntryStepIds, definition.Cron, definition.Steps),
                MessagingJson.Options));

    public static async Task LiveAsync(InMemoryL2 l2, WorkflowL1 definition)
    {
        await StoreAsync(l2, definition);
        await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), definition.WorkflowId.ToString("D"));
    }
}
```

Create `src/tests/BaseApi.Tests/Orchestration/StartDrivenProjectionTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;
using RedisFieldWhitelist = Processor.SKNormalizer.RedisFieldWhitelist;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// What a start and a stop leave in L2 under the start-driven layout: the start writes and aligns only
/// its own workflow's keys; the stop only leaves the live set.
/// </summary>
public sealed class StartDrivenProjectionTests
{
    private static readonly Guid W  = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid W2 = Guid.Parse("99999999-9999-9999-9999-999999999999");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid S2 = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid P  = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private sealed class Harness
    {
        public InMemoryL2 L2 { get; } = new();
        public IQueueFanoutPublisher Publisher { get; } = Substitute.For<IQueueFanoutPublisher>();

        public Task StartAsync(WorkflowL1 d) =>
            new StartOrchestrationHandler(
                    new L2ProjectionWriter(L2.Multiplexer), new L2LiveSet(L2.Multiplexer), Publisher,
                    NullLogger<StartOrchestrationHandler>.Instance)
                .HandleAsync(JsonSerializer.SerializeToUtf8Bytes(new StartOrchestration(d), MessagingJson.Options),
                             CancellationToken.None);

        public Task StopAsync(Guid workflowId) =>
            new StopOrchestrationHandler(new L2LiveSet(L2.Multiplexer), Publisher, NullLogger<StopOrchestrationHandler>.Instance)
                .HandleAsync(JsonSerializer.SerializeToUtf8Bytes(new StopOrchestration(workflowId), MessagingJson.Options),
                             CancellationToken.None);
    }

    private static WorkflowL1 Def(Guid w, Guid[] steps, List<CacheL1>? caches = null)
    {
        // The workflow and every step are named, exactly as ToDefinition does; no processor.
        var names = new Dictionary<Guid, string> { [w] = "chain_1.0.0-aaaa-111111111111" };
        foreach (var s in steps)
        {
            names[s] = EntityNames.Format("step", "1.0.0", s);
        }

        return new WorkflowL1(
            WorkflowId: w,
            EntryStepIds: [steps[0]],
            Cron: "0 0/5 * * * ?",
            Steps: steps.Select(s => new StepL1(s, 4, P, "{}", [])).ToList(),
            Caches: caches ?? [],
            Names: names);
    }

    private static CacheL1 Whitelist(params string[] keys) =>
        new("sk-whitelist", keys.ToDictionary(k => k, k => k.ToUpperInvariant()));

    [Fact]
    public async Task StartWritesNameStoreAndRootsOnTheWorkflowHash()
    {
        var h = new Harness();

        await h.StartAsync(Def(W, [S1, S2], [Whitelist("acme")]));

        Assert.Equal("chain_1.0.0-aaaa-111111111111", h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField));
        var store = JsonSerializer.Deserialize<WorkflowStoreProjection>(
            h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField)!, MessagingJson.Options)!;
        Assert.Equal([S1], store.EntryStepIds);
        Assert.Equal([S1, S2], store.Steps.Select(s => s.StepId));
        Assert.Equal("[\"sk-whitelist\"]", h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.RootsField));
    }

    [Fact]
    public async Task StartWritesEachStepNameAndNoProcessorKeyAndNoPerStepKey()
    {
        var h = new Harness();

        await h.StartAsync(Def(W, [S1, S2]));

        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.StepEntity(S1), L2ProjectionKeys.NameField));
        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.StepEntity(S2), L2ProjectionKeys.NameField));
        Assert.False(h.L2.HasHash(L2ProjectionKeys.Processor(P)));
        Assert.DoesNotContain(h.L2.Keys(), k => k == $"skp:{W:D}:{S1:D}" || k == $"skp:{W:D}");
    }

    [Fact]
    public async Task StartJoinsTheLiveSetThenAnnounces()
    {
        var h = new Harness();
        var liveAtAnnounce = false;
        h.Publisher.When(p => p.PublishAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStarted>(), Arg.Any<CancellationToken>()))
                   .Do(_ => liveAtAnnounce = h.L2.Members(L2ProjectionKeys.Live()).Contains(W.ToString("D")));

        await h.StartAsync(Def(W, [S1]));

        Assert.True(liveAtAnnounce);
        await h.Publisher.Received(1).PublishAsync(OrchestratorFanout.Exchange, MessageTypes.OrchestrationStarted,
            Arg.Is<OrchestrationStarted>(a => a.WorkflowId == W), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ARestartDeletesOnlyItsOwnRemovedItemsAndUnboundRoots()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1], [Whitelist("acme", "globex"), new CacheL1("old-root", new() { ["k"] = "v" })]));

        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));

        Assert.True(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme")));
        Assert.False(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "globex")));
        Assert.False(h.L2.Has(L2ProjectionKeys.Cache(W, "old-root")));
        Assert.False(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "old-root", "k")));
    }

    [Fact]
    public async Task AnItemRemovedBeforeARestartIsUnlistedAfterIt()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1], [Whitelist("acme", "globex")]));
        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));

        var whitelist = new RedisFieldWhitelist(h.L2.Multiplexer, W, "sk-whitelist", new RecordingLogger<RedisFieldWhitelist>());

        Assert.True(whitelist.TryGet("acme", out _));
        Assert.False(whitelist.TryGet("globex", out _));
    }

    [Fact]
    public async Task ARestartThatDropsAStepLeavesItsNameKey()
    {
        // Steps are shared across workflows: W dropping S2 must not take S2's name from W2.
        var h = new Harness();
        await h.StartAsync(Def(W, [S1, S2]));
        await h.StartAsync(Def(W2, [S2]));

        await h.StartAsync(Def(W, [S1]));

        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.StepEntity(S2), L2ProjectionKeys.NameField));
    }

    [Fact]
    public async Task AStartNeverTouchesAnotherWorkflowsKeys()
    {
        var h = new Harness();
        await h.StartAsync(Def(W2, [S2], [Whitelist("initech")]));
        var before = h.L2.Snapshot().Split('\n').Where(l => l.Contains(W2.ToString("D"))).ToList();

        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));

        Assert.Equal(before, h.L2.Snapshot().Split('\n').Where(l => l.Contains(W2.ToString("D"))).ToList());
    }

    [Fact]
    public async Task StopLeavesTheLiveSetFirstThenAnnouncesAndKeepsTheStore()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));
        var liveAtAnnounce = true;
        h.Publisher.When(p => p.PublishAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStopped>(), Arg.Any<CancellationToken>()))
                   .Do(_ => liveAtAnnounce = h.L2.Members(L2ProjectionKeys.Live()).Contains(W.ToString("D")));

        await h.StopAsync(W);

        Assert.False(liveAtAnnounce);
        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));
        Assert.True(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme")));
    }

    [Fact]
    public async Task AFailedStopAnnouncementEscapesAndTheRedeliveryConverges()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1]));
        h.Publisher.PublishAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStopped>(), Arg.Any<CancellationToken>())
                   .ThrowsAsync(new TransientSendException("broker down", new IOException("reset")));

        await Assert.ThrowsAsync<TransientSendException>(() => h.StopAsync(W));
        h.Publisher.ClearSubstitute();
        await h.StopAsync(W);

        Assert.Empty(h.L2.Members(L2ProjectionKeys.Live()));
    }
}
```

- [ ] **Step 2: Write the failing orchestrator-side tests**

Create `src/tests/BaseApi.Tests/Orchestrator/LiveSetActivationTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Orchestrator.L1;
using Orchestrator.Messaging;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The orchestrator under the start-driven layout: activation, hydration and stop all key off the
/// live set, and the store survives a stop.
/// </summary>
public sealed class LiveSetActivationTests
{
    private static readonly Guid W  = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid W2 = Guid.Parse("88888888-8888-8888-8888-888888888888");
    private static readonly Guid S  = Guid.Parse("66666666-6666-6666-6666-666666666666");
    private static readonly Guid P  = Guid.Parse("77777777-7777-7777-7777-777777777777");

    private static WorkflowL1 Def(Guid w, string? cron = "0 0/5 * * * ?", Guid? step = null) =>
        new(w, [step ?? S], cron, [new StepL1(step ?? S, 4, P, "{}", [])], []);

    private sealed class Harness
    {
        public InMemoryL2 L2 { get; } = new();
        public WorkflowL1Store Store { get; } = new();
        public RecordingWorkflowScheduler Scheduler { get; } = new();
        public FakeNameSource Names { get; } = new();

        public L2WorkflowReader Reader => new(L2.Multiplexer, NullLogger<L2WorkflowReader>.Instance);

        public WorkflowActivator Activator => new(
            Reader, Store, Scheduler, NullLogger<WorkflowActivator>.Instance,
            new EntityNameResolver(Names, NullLogger<EntityNameResolver>.Instance));

        public ApplyStopHandler Stop => new(Reader, Store, Scheduler, new FakeTimeProvider(), NullLogger<ApplyStopHandler>.Instance);
    }

    private static byte[] Body<T>(T m) => JsonSerializer.SerializeToUtf8Bytes(m, MessagingJson.Options);

    [Fact]
    public async Task HydrationSeesExactlyTheLiveSet()
    {
        var h = new Harness();
        await L2Seed.LiveAsync(h.L2, Def(W));
        await L2Seed.StoreAsync(h.L2, Def(W2));   // stored but stopped

        Assert.Equal([W], await h.Reader.ReadAllIdsAsync(CancellationToken.None));
    }

    [Fact]
    public async Task AnActivationForAWorkflowNotInTheLiveSetDoesNothing()
    {
        var h = new Harness();
        await L2Seed.StoreAsync(h.L2, Def(W));

        await h.Activator.ActivateAsync(W, CancellationToken.None);

        Assert.False(h.Store.TryGetIncludingStopped(W, out _));
    }

    [Fact]
    public async Task AStopAfterTheLiveRemovalUnschedulesEvenThoughTheStoreRemains()
    {
        var h = new Harness();
        await L2Seed.LiveAsync(h.L2, Def(W));
        await h.Activator.ActivateAsync(W, CancellationToken.None);
        await h.L2.Db.SetRemoveAsync(L2ProjectionKeys.Live(), W.ToString("D"));   // what BaseApi's stop does

        await h.Stop.HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.False(h.Store.TryGetActive(W, out _));
        Assert.True(h.Store.TryGetIncludingStopped(W, out _));   // the stopped entry stays in L1
        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));
    }

    [Fact]
    public async Task AStopIsIgnoredWhileTheWorkflowIsStillLive()
    {
        var h = new Harness();
        await L2Seed.LiveAsync(h.L2, Def(W));
        await h.Activator.ActivateAsync(W, CancellationToken.None);

        await h.Stop.HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out _));
    }

    [Fact]
    public async Task ACorruptStoreReadsAsAbsentAndDoesNotThrow()
    {
        var h = new Harness();
        await h.L2.Db.HashSetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField, "{not json");
        await h.L2.Db.SetAddAsync(L2ProjectionKeys.Live(), W.ToString("D"));

        Assert.Null(await h.Reader.ReadAsync(W, CancellationToken.None));
        await h.Activator.ActivateAsync(W, CancellationToken.None);
        Assert.False(h.Store.TryGetIncludingStopped(W, out _));
    }

    [Fact]
    public async Task ActivationPreloadsTheWorkflowItsStepsAndTheirProcessors()
    {
        var h = new Harness();
        await L2Seed.LiveAsync(h.L2, Def(W));

        await h.Activator.ActivateAsync(W, CancellationToken.None);

        Assert.Contains(new EntityRef(L2EntityKind.Workflow, W), h.Names.Requested);
        Assert.Contains(new EntityRef(L2EntityKind.Step, S), h.Names.Requested);
        Assert.Contains(new EntityRef(L2EntityKind.Processor, P), h.Names.Requested);
    }

    [Fact]
    public async Task ARestartOverwritesTheL1EntryWithTheNewDefinition()
    {
        var h = new Harness();
        var s2 = Guid.NewGuid();
        await L2Seed.LiveAsync(h.L2, Def(W));
        await h.Activator.ActivateAsync(W, CancellationToken.None);

        await L2Seed.LiveAsync(h.L2, Def(W, step: s2));
        await h.Activator.ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out var entry));
        Assert.Equal([s2], entry.Definition.EntryStepIds);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: build FAILS — `The type or namespace name 'L2LiveSet' could not be found`, and `L2ProjectionWriter` has no single-argument constructor.

- [ ] **Step 4: Implement the BaseApi side**

Create `src/BaseApi.Service/Features/Orchestration/Projection/L2LiveSet.cs`:

```csharp
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// The set of running workflow ids. A start adds after its writes; a stop removes before it announces;
/// every orchestrator hydrates from it and guards start and stop announcements on it. Both operations
/// are idempotent, which is what lets a control message be redelivered freely.
/// </summary>
internal sealed class L2LiveSet
{
    private readonly IConnectionMultiplexer _multiplexer;

    public L2LiveSet(IConnectionMultiplexer multiplexer)
        => _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

    public Task AddAsync(Guid workflowId) =>
        _multiplexer.GetDatabase().SetAddAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"));

    public Task RemoveAsync(Guid workflowId) =>
        _multiplexer.GetDatabase().SetRemoveAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"));
}
```

Rewrite `L2ProjectionWriter.cs` (keep the file's namespace and usings; add `using Messaging.Contracts.Projections;` if missing):

```csharp
/// <summary>
/// Writes one workflow into L2 and aligns what that workflow owns: <c>skp:wf:{id}</c> (name, store,
/// roots), its cache dictionaries, and each of its steps' names.
/// <para>
/// <b>Overwrite, never clean.</b> The workflow hash and the step hashes are overwritten; the only keys
/// deleted are this workflow's own leftovers — cache roots it no longer binds and cache items the
/// database no longer holds — found from the <c>roots</c> field and each root's key list that the
/// previous start recorded. Step name keys are never deleted: a step can belong to other workflows.
/// </para>
/// <para>
/// <b>One batch.</b> The deletes are disjoint from the writes by construction, so their order inside
/// the batch is unobservable. A failure requeues the control message and the whole method runs again;
/// the previous state it reads back is still there, so the rerun computes the same leftovers.
/// </para>
/// </summary>
internal sealed class L2ProjectionWriter
{
    private readonly IConnectionMultiplexer _multiplexer;

    public L2ProjectionWriter(IConnectionMultiplexer multiplexer)
        => _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

    public async Task WriteAsync(WorkflowL1 workflow, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(workflow);

        var db = _multiplexer.GetDatabase();
        var workflowId = workflow.WorkflowId;
        var workflowKey = L2ProjectionKeys.Workflow(workflowId);
        var steps = workflow.Steps ?? new List<StepL1>();

        // Deduplicated by root, blank roots dropped — unchanged from the previous writer, for the same
        // reason: a root written twice or blank is a key set nothing would find again.
        var caches = (workflow.Caches ?? new List<CacheL1>())
            .Where(c => !string.IsNullOrWhiteSpace(c.Root))
            .GroupBy(c => c.Root, StringComparer.Ordinal)
            .Select(g => g.First())
            .ToList();

        var stale = await FindOwnLeftoversAsync(db, workflowId, workflowKey, caches).ConfigureAwait(false);

        var store = new WorkflowStoreProjection(workflow.EntryStepIds ?? new List<Guid>(), workflow.Cron, steps);

        var batch = db.CreateBatch();
        var writes = new List<Task>
        {
            batch.HashSetAsync(workflowKey,
            [
                new HashEntry(L2ProjectionKeys.StoreField, JsonSerializer.Serialize(store, MessagingJson.Options)),
                new HashEntry(L2ProjectionKeys.RootsField,
                    JsonSerializer.Serialize(caches.Select(c => c.Root).ToList(), MessagingJson.Options)),
            ]),
        };

        foreach (var cache in caches)
        {
            var items = cache.Items ?? new Dictionary<string, string>();

            // The key list goes at the cache root, so the next start can find the entries it has to
            // delete without a scan, and an operator reading one key sees the dictionary by name.
            writes.Add(batch.StringSetAsync(
                L2ProjectionKeys.Cache(workflowId, cache.Root),
                JsonSerializer.Serialize(items.Keys.ToList(), MessagingJson.Options)));

            foreach (var (key, value) in items)
            {
                writes.Add(batch.StringSetAsync(L2ProjectionKeys.CacheEntry(workflowId, cache.Root, key), value));
            }
        }

        // [the names block from Task 5, unchanged]

        if (stale.Count > 0)
        {
            writes.Add(batch.KeyDeleteAsync(stale.ToArray()));
        }

        batch.Execute();
        await Task.WhenAll(writes).ConfigureAwait(false);
    }

    /// <summary>
    /// The cache keys the previous start of this workflow wrote that this start does not: every key of
    /// a root no longer bound, and every item no longer in a root that still is. Read before anything is
    /// written, from what the previous start recorded. A root or list that is missing or unreadable
    /// contributes nothing — its keys are already unreachable, and aborting would strand the rest.
    /// </summary>
    private static async Task<List<RedisKey>> FindOwnLeftoversAsync(
        IDatabase db, Guid workflowId, string workflowKey, List<CacheL1> next)
    {
        var stale = new List<RedisKey>();
        var nextByRoot = next.ToDictionary(c => c.Root, c => c.Items ?? new Dictionary<string, string>(), StringComparer.Ordinal);

        var previousRoots = ReadList(await db.HashGetAsync(workflowKey, L2ProjectionKeys.RootsField).ConfigureAwait(false));

        foreach (var root in previousRoots.Where(r => !string.IsNullOrWhiteSpace(r)).Distinct(StringComparer.Ordinal))
        {
            var rootKey = L2ProjectionKeys.Cache(workflowId, root);
            var previousKeys = ReadList(await db.StringGetAsync(rootKey).ConfigureAwait(false))
                .Where(k => !string.IsNullOrEmpty(k))
                .Distinct(StringComparer.Ordinal);

            if (!nextByRoot.TryGetValue(root, out var items))
            {
                stale.Add(rootKey);
                stale.AddRange(previousKeys.Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, root, k)));
                continue;
            }

            stale.AddRange(previousKeys
                .Where(k => !items.ContainsKey(k))
                .Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, root, k)));
        }

        return stale;
    }

    private static List<string> ReadList(RedisValue json)
    {
        if (json.IsNullOrEmpty)
        {
            return new List<string>();
        }

        try
        {
            return JsonSerializer.Deserialize<List<string>>(json.ToString(), MessagingJson.Options) ?? new List<string>();
        }
        catch (JsonException)
        {
            return new List<string>();
        }
    }
}
```

(The line `// [the names block from Task 5, unchanged]` is where the `if (workflow.Names is not null) { … }` block written in Task 5 stays verbatim — move it, don't rewrite it.)

`StartOrchestrationHandler.cs` — replace the `L2Cleanup` field/parameter with `L2LiveSet`, update the class summary's "Clean, then write" paragraphs to "Write, then join the live set", and replace the body after the logging line:

```csharp
    private readonly L2ProjectionWriter _writer;
    private readonly L2LiveSet _live;
    private readonly IQueueFanoutPublisher _publisher;
    private readonly ILogger<StartOrchestrationHandler> _logger;

    public StartOrchestrationHandler(
        L2ProjectionWriter writer, L2LiveSet live, IQueueFanoutPublisher publisher,
        ILogger<StartOrchestrationHandler> logger)
    {
        _writer    = writer ?? throw new ArgumentNullException(nameof(writer));
        _live      = live ?? throw new ArgumentNullException(nameof(live));
        _publisher = publisher ?? throw new ArgumentNullException(nameof(publisher));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }
```

```csharp
        await _writer.WriteAsync(workflow, ct).ConfigureAwait(false);

        // Live only once written: a replica hydrating from the live set must never find an id whose
        // store is not there yet.
        await _live.AddAsync(workflow.WorkflowId).ConfigureAwait(false);

        // [the existing announcement comment and PublishAsync call, unchanged]
```

`StopOrchestrationHandler.cs` — replace the dependency and body:

```csharp
/// <summary>
/// Takes a workflow out of the live set and announces it. Nothing is deleted: the store, the caches
/// and the names stay, so a start can restore the workflow and outcomes still in flight resolve.
/// <para>
/// <b>Remove, then announce — the order is the correctness.</b> Every replica's stop handler ignores a
/// stop while the id is still live (a later start may have overtaken it). Announcing first would let a
/// replica read the id as live and ignore the stop for good.
/// </para>
/// </summary>
internal sealed class StopOrchestrationHandler : IQueueMessageHandler
{
    private readonly L2LiveSet _live;
    private readonly IQueueFanoutPublisher _publisher;
    private readonly ILogger<StopOrchestrationHandler> _logger;

    public StopOrchestrationHandler(
        L2LiveSet live, IQueueFanoutPublisher publisher, ILogger<StopOrchestrationHandler> logger)
    {
        _live      = live ?? throw new ArgumentNullException(nameof(live));
        _publisher = publisher ?? throw new ArgumentNullException(nameof(publisher));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.StopOrchestration;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        var message = JsonSerializer.Deserialize<StopOrchestration>(body.Span, MessagingJson.Options)
                      ?? throw new JsonException("stop message deserialized to null");

        if (message.WorkflowId == Guid.Empty)
        {
            // Not a workflow that happens to be absent — a message that names no workflow at all.
            // No retry can supply one, so it is parked rather than requeued.
            throw new JsonException("stop message carries an empty workflow id");
        }

        _logger.LogInformation("removing workflow {WorkflowId} from the live set", message.WorkflowId);

        await _live.RemoveAsync(message.WorkflowId).ConfigureAwait(false);

        // A failure here escapes as a transient send fault, so the delivery is requeued and the handler
        // runs again: the removal is idempotent and the replicas learn about the stop on the retry.
        await _publisher.PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStopped,
            new OrchestrationStopped(message.WorkflowId), ct).ConfigureAwait(false);
    }
}
```

Delete `L2Cleanup.cs`. In `OrchestrationServiceCollectionExtensions.cs` replace `services.AddScoped<L2Cleanup>();` with `services.AddScoped<L2LiveSet>();`.

- [ ] **Step 5: Implement the orchestrator side**

`L2WorkflowReader.cs`:
- Class summary: the permitted operations become `SetMembersAsync` (live set), `SetContainsAsync` (live guard), `HashGetAsync` (store, and names). Replace the "torn projection" paragraph with: "A store that will not deserialize reads as absent, with a warning; a Redis fault propagates untouched (spec §7.4 RequeueAndTrip). The only catch sits around one Deserialize call."
- `ReadAllIdsAsync`: `SetMembersAsync(L2ProjectionKeys.Live())`; its warning becomes `"the live set holds a member that is not a workflow id; skipping it"` (new template, allowed).
- Replace `ReadAsync`, `ReadStep` and `ExistsAsync` with:

```csharp
    /// <summary>
    /// The workflow <paramref name="workflowId"/> as its last start stored it, or null when there is no
    /// usable store. Caches stay empty and names absent on purpose: nothing on the activation path reads
    /// them — processors address their cache keys directly, and names load through the resolver.
    /// </summary>
    public async Task<WorkflowL1?> ReadAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // Outside ReadStore: a Redis fault must propagate, so no catch may sit near the read.
        var raw = await redis.GetDatabase()
            .HashGetAsync(L2ProjectionKeys.Workflow(workflowId), L2ProjectionKeys.StoreField).ConfigureAwait(false);

        if (raw.IsNullOrEmpty)
        {
            return null;
        }

        var store = ReadStore(raw);
        if (store is null)
        {
            logger.LogWarning("workflow {WorkflowId} holds a store that will not deserialize; treating it as absent", workflowId);
            return null;
        }

        return new WorkflowL1(
            workflowId, store.EntryStepIds ?? new List<Guid>(), store.Cron, store.Steps ?? new List<StepL1>(), new List<CacheL1>());
    }

    private static WorkflowStoreProjection? ReadStore(RedisValue raw)
    {
        try
        {
            return JsonSerializer.Deserialize<WorkflowStoreProjection>(raw.ToString(), MessagingJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Whether <paramref name="workflowId"/> is in the live set — the guard for both announcements. The
    /// store outlives a stop, so "the key exists" no longer says anything about whether it runs.
    /// </summary>
    public async Task<bool> IsLiveAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        return await redis.GetDatabase()
            .SetContainsAsync(L2ProjectionKeys.Live(), workflowId.ToString("D")).ConfigureAwait(false);
    }
```

`WorkflowActivator.cs` — add the optional resolver and the live guard; keep the existing templates:

```csharp
public sealed class WorkflowActivator(
    L2WorkflowReader reader,
    WorkflowL1Store store,
    IWorkflowScheduler scheduler,
    ILogger<WorkflowActivator> logger,
    EntityNameResolver? names = null)
{
    public async Task ActivateAsync(Guid workflowId, CancellationToken ct)
    {
        // THE LIVE SET DECIDES, not the store. The store outlives a stop, so an announcement that lost
        // a race with a stop would otherwise resurrect a workflow an operator stopped.
        if (!await reader.IsLiveAsync(workflowId, ct).ConfigureAwait(false))
        {
            logger.LogInformation("workflow {WorkflowId} is not in the live set; nothing to activate", workflowId);
            return;
        }

        var definition = await reader.ReadAsync(workflowId, ct).ConfigureAwait(false);
        if (definition is null)
        {
            // [existing comment and LogWarning "L2 does not hold workflow {WorkflowId}; nothing to activate", unchanged]
        }

        // [existing teardown, store.Set, schedule — unchanged]

        // Names for the records this workflow is about to produce, in one read. Best-effort: the
        // resolver never throws, and a miss falls back to the id suffix and is retried on use.
        if (names is not null)
        {
            await names.PreloadAsync(
                new[] { new EntityRef(L2EntityKind.Workflow, workflowId) }
                    .Concat(definition.Steps.Select(s => new EntityRef(L2EntityKind.Step, s.StepId)))
                    .Concat(definition.Steps.Select(s => new EntityRef(L2EntityKind.Processor, s.ProcessorId))))
                .ConfigureAwait(false);
        }

        // [existing "activated workflow …" LogInformation, unchanged]
    }
}
```

Add `using BaseConsole.Core.Naming;` and `using Messaging.Contracts.Projections;`. Update the class summary's "Absent from L2 means do nothing" paragraph to "Not live means do nothing".

`ApplyStopHandler.cs:75-83`:

```csharp
            // Verify before acting. The API can process a stop and then a start, so by the time this stop
            // is handled the workflow may be live again — and unscheduling would halt a workflow the API
            // just restarted. The live set is the source of truth; the store outlives a stop and says
            // nothing about whether the workflow runs.
            if (await _reader.IsLiveAsync(m.WorkflowId, ct).ConfigureAwait(false))
            {
                _logger.LogInformation("stop announced but the workflow is still projected — ignoring");
                return;
            }
```

(The template "stop announced but the workflow is still projected — ignoring" is kept verbatim.)

`HydrationService` needs no code change (it already calls `ReadAllIdsAsync` then `ActivateAsync`).

- [ ] **Step 6: Bring the existing tests to the new layout**

Apply exactly these changes:

1. **`Cache/CacheProjectionCleanupTests.cs`** — delete the file; its "restart and stop delete cache keys" coverage is replaced by `StartDrivenProjectionTests.ARestartDeletesOnlyItsOwnRemovedItemsAndUnboundRoots` and `StopLeavesTheLiveSetFirstThenAnnouncesAndKeepsTheStore`.
2. **`Cache/CacheProjectionWriteTests.cs`** — `new L2ProjectionWriter(x, clock)` → `new L2ProjectionWriter(x)`; every read of the root via `L2ProjectionKeys.Root(W)` + `WorkflowRootProjection` becomes a read of the `roots` field: `JsonSerializer.Deserialize<List<string>>(l2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.RootsField)!, MessagingJson.Options)`.
3. **`Naming/NameProjectionTests.cs`** — `new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider())` → `new L2ProjectionWriter(l2.Multiplexer)` (drop the `FakeTimeProvider` using if unused).
4. **`Orchestration/FanoutPublishTests.cs`** — `BuildStart()` → `new(new L2ProjectionWriter(Redis), new L2LiveSet(Redis), Publisher, NullLogger<StartOrchestrationHandler>.Instance)`; `BuildStop()` → `new(new L2LiveSet(Redis), Publisher, NullLogger<StopOrchestrationHandler>.Instance)`; delete `ExistingRoot()` and the `_clock` field; replace `TheStopPathAnnouncesAfterItsCleanToo` with:

```csharp
    [Fact]
    public async Task TheStopPathAnnouncesAfterItLeavesTheLiveSet()
    {
        var h = new Harness();
        var order = new List<string>();
        h.Db.When(d => d.SetRemoveAsync(L2ProjectionKeys.Live(), W.ToString("D"), Arg.Any<CommandFlags>()))
            .Do(_ => order.Add("leave"));
        h.Publisher.When(p => p.PublishAsync(
                    Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStopped>(), Arg.Any<CancellationToken>()))
                .Do(_ => order.Add("announce"));

        await h.BuildStop().HandleAsync(Body(Stop(W)), CancellationToken.None);

        Assert.Equal(["leave", "announce"], order);
    }
```

   and in `AnnouncesOnlyAfterTheProjectionHasBeenWritten` keep the batch `Execute` hook (the writer still executes one batch).
5. **`Orchestration/StartStopIdempotencyTests.cs`** — in `Chain`: `ApiStartAsync` builds `new StartOrchestrationHandler(new L2ProjectionWriter(L2.Multiplexer), new L2LiveSet(L2.Multiplexer), Publisher, …)`; `ApiStopAsync` builds `new StopOrchestrationHandler(new L2LiveSet(L2.Multiplexer), Publisher, …)`; remove `Clock` if unused. Replace the `Root(Chain)` helper with:

```csharp
    private static WorkflowStoreProjection Store(Chain c) =>
        JsonSerializer.Deserialize<WorkflowStoreProjection>(
            c.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField)!, MessagingJson.Options)!;
```

   Then per test:
   - `ARepeatedStartRewritesTheRootsStoredTimestampButNothingElse` → rename `ARepeatedStartLeavesAByteIdenticalStore`; assert `c.L2.Snapshot()` after the second start equals the snapshot after the first (there is no timestamp any more).
   - `ARestartThatDropsAStepLeavesNoKeyForIt` → rename `ARestartThatDropsAStepDropsItFromTheStore`; assert `Store(c).Steps.Select(s => s.StepId)` is `[S1]` after restarting with `Definition(S1)`.
   - `AStopAppliedTwiceLeavesL2EmptyBothTimes` → rename `AStopAppliedTwiceOnlyLeavesTheLiveSetBothTimes`; assert after each stop: `c.L2.Members(L2ProjectionKeys.Live())` is empty and `c.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField)` is not null.
   - `AWorkflowWithCachesConvergesOnRestartAndStopRemovesEveryCacheKey` → rename `AWorkflowWithCachesConvergesOnRestartAndStopKeepsItsCacheKeys`; keep the convergence half; the stop half asserts the cache keys are still present.
   - `AStopForAWorkflowThatWasNeverStartedTouchesNothing` — unchanged (snapshot stays empty).
   - `AStopStillClearsARootWhoseIndexEntryIsAlreadyGone` — delete (there is no clean).
   - `StartStopStartLeavesTheWorkflowInTheParentIndexExactlyOnce` → rename `StartStopStartLeavesTheWorkflowInTheLiveSetExactlyOnce`; `L2ProjectionKeys.ParentIndex()` → `L2ProjectionKeys.Live()`.
   - `TheWholeCycleRunTwiceEndsWhereItStarted` — the end state after start→stop is "store present, live empty"; assert the two end snapshots are equal to each other (not to an empty store).
   - All replica-side tests, including `AStopAnnouncementDeliveredBehindALaterStartDoesNotTearDownTheRestartedWorkflow` — unchanged; they must pass as written.
6. **`Orchestrator/ApplyHandlerTests.cs`** — replace the `Harness`'s `WithWorkflow`, `RemoveWorkflowFromL2`, `RestoreWorkflowToL2`, `WithStoreFault` with:

```csharp
        public Harness WithWorkflow(Guid workflowId, string? cron)
        {
            _live.Add(workflowId);

            Db.SetContainsAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"), Arg.Any<CommandFlags>())
                .Returns(_ => _live.Contains(workflowId));

            // The store is NOT gated on _live: it outlives a stop.
            Db.HashGetAsync(L2ProjectionKeys.Workflow(workflowId), L2ProjectionKeys.StoreField, Arg.Any<CommandFlags>())
                .Returns((RedisValue)JsonSerializer.Serialize(
                    new WorkflowStoreProjection([S], cron, [new StepL1(S, 0, P, "{}", [])]),
                    MessagingJson.Options));

            return this;
        }

        /// <summary>What the API's stop does before it announces: the id leaves the live set.</summary>
        public void RemoveWorkflowFromL2(Guid workflowId) => _live.Remove(workflowId);

        /// <summary>What the API's start does before it announces: the id joins the live set.</summary>
        public void RestoreWorkflowToL2(Guid workflowId) => _live.Add(workflowId);

        public Harness WithStoreFault()
        {
            Db.SetContainsAsync(L2ProjectionKeys.Live(), W.ToString("D"), Arg.Any<CommandFlags>())
                .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

            return this;
        }
```

   Rename `AStartForAWorkflowL2NoLongerHoldsIsANoOpNotAPark` → `AStartForAWorkflowNoLongerLiveIsANoOpNotAPark`; its body is unchanged.
7. **`Orchestrator/L2WorkflowReaderTests.cs`, `Orchestrator/WorkflowActivatorTests.cs`, `Orchestrator/HydrationServiceTests.cs`** — every arrangement that wrote a `WorkflowRootProjection` at `L2ProjectionKeys.Root(w)`, a `StepProjection` at `L2ProjectionKeys.Step(w, s)`, or ran `L2ProjectionWriter` to seed, becomes `await L2Seed.LiveAsync(l2, definition)` (or `L2Seed.StoreAsync` when the test needs a stored-but-not-live workflow) over an `InMemoryL2`. Where a test used an NSubstitute `IDatabase` instead, stub `SetMembersAsync(L2ProjectionKeys.Live(), …)`, `SetContainsAsync(L2ProjectionKeys.Live(), id.ToString("D"), …)` and `HashGetAsync(L2ProjectionKeys.Workflow(id), L2ProjectionKeys.StoreField, …)` as in item 6. Delete the tests about a *missing or corrupt per-step key being skipped* (there are no per-step keys); `LiveSetActivationTests.ACorruptStoreReadsAsAbsentAndDoesNotThrow` replaces them. Every test calling `ExistsAsync` switches to `IsLiveAsync`.
8. **`Live/RedisReconnectLiveTests.cs`** — seed with `L2Seed.LiveAsync` semantics against the real connection: `HashSetAsync(L2ProjectionKeys.Workflow(w), L2ProjectionKeys.StoreField, json)` + `SetAddAsync(L2ProjectionKeys.Live(), w.ToString("D"))`; cleanup deletes `L2ProjectionKeys.Workflow(w)` and `SetRemoveAsync(L2ProjectionKeys.Live(), …)`. (Skipped in the hermetic run; it must compile.)

Then confirm nothing still uses the retired shapes outside `L2ProjectionKeys` itself:

Run: `grep -rnE "L2Cleanup|ExistsAsync\(|L2ProjectionKeys\.(Root|Step|ParentIndex)\(" src --include=*.cs | grep -v /bin/ | grep -v /obj/`
Expected: no output.

- [ ] **Step 7: Run the tests**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestration.StartDrivenProjectionTests" --filter-class "BaseApi.Tests.Orchestrator.LiveSetActivationTests" --filter-class "BaseApi.Tests.Orchestration.StartStopIdempotencyTests"`
Expected: all PASS.

Full suite: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` → `failed: 0`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A src/BaseApi.Service src/Orchestrator src/tests/BaseApi.Tests
git commit -m "feat(l2): start-driven projection — workflow store hash, live set, stop without cleanup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Remove the L1 reaper

Stopped entries stay in L1 until the workflow restarts or the pod restarts.

**Files:**
- Delete: `src/Orchestrator/L1/L1ReapService.cs`
- Modify: `src/Orchestrator/OrchestratorHost.cs` (the `ReapLoop` const and its doc comment ~70-83; the keyed heartbeat + `AddHostedService<L1ReapService>()` ~371-379; the reap `HealthCheckRegistration` and its comment ~409-429)
- Delete: `src/tests/BaseApi.Tests/Orchestrator/L1ReapServiceTests.cs`
- Modify: `src/tests/BaseApi.Tests/Orchestrator/OrchestratorHostWiringTests.cs` (`TheReapLoopIsWatchedForLiveness` → replaced; `EachLoopHasItsOwnHeartbeatHolder` drops `reap`)
- Modify: `src/tests/BaseApi.Tests/Naming/OrchestratorNamesTests.cs` (delete `TheReapLineNamesEveryReapedWorkflowWithoutChangingItsTemplate`)
- Modify: `src/Orchestrator/L1/WorkflowL1Store.cs` (doc comments only)
- Modify: `grafana/dashboards/skp-orchestrator.json:1929` (description text)

**Interfaces:**
- Produces: nothing new. `WorkflowL1Store.ReapDeletedBefore` stays — `ExecutionRoundTripTests` uses it to model a replica that no longer holds a workflow (the post-restart case).

- [ ] **Step 1: Write the failing test**

In `OrchestratorHostWiringTests.cs`, replace `TheReapLoopIsWatchedForLiveness` with:

```csharp
    [Fact]
    public void NoLoopReapsStoppedWorkflows()
    {
        // A stopped workflow stays in L1 so every in-flight lineage can still resolve; nothing prunes it
        // but a restart of the workflow or of the pod.
        var hosted = _host.Services.GetServices<IHostedService>().ToList();

        Assert.DoesNotContain(hosted, s => s.GetType().Name == "L1ReapService");
        Assert.DoesNotContain(
            _host.Services.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations,
            r => r.Name == "orchestrator-l1-reap");
    }
```

and in `EachLoopHasItsOwnHeartbeatHolder` delete the `reap` variable and its two `Assert.NotSame` lines (and trim the comment's reap sentence).

- [ ] **Step 2: Run to verify failure**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.OrchestratorHostWiringTests"`
Expected: `NoLoopReapsStoppedWorkflows` FAILS (the reaper is still hosted).

- [ ] **Step 3: Remove the reaper**

- Delete `src/Orchestrator/L1/L1ReapService.cs` and `src/tests/BaseApi.Tests/Orchestrator/L1ReapServiceTests.cs`.
- In `OrchestratorHost.cs` delete: the `ReapLoop` const and its doc comment; the "Loop 3" `AddKeyedSingleton<ILoopHeartbeat>(ReapLoop, …)` and `builder.Services.AddHostedService<L1ReapService>();`; the trailing `.Add(new HealthCheckRegistration(ReapLoop, …))` and the comment block above it — ending the chain at the `HydrationReady` registration with `;`.
- Delete `TheReapLineNamesEveryReapedWorkflowWithoutChangingItsTemplate` from `OrchestratorNamesTests.cs` (and any usings it alone needed).
- `WorkflowL1Store.cs`: in any doc comment mentioning `L1ReapService` or "the reap", replace with "stopped entries are kept until the workflow restarts or the pod restarts; `ReapDeletedBefore` is not called in production".
- `grafana/dashboards/skp-orchestrator.json:1929`: in the description remove `, orchestrator-l1-reap 0.003/s (a 5-minute period)`.

Run: `grep -rn "L1ReapService\|ReapLoop\|l1-reap" src grafana --include=*.cs --include=*.json | grep -v /bin/ | grep -v /obj/ | grep -v node_modules`
Expected: no output.

- [ ] **Step 4: Run the tests**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: `failed: 0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A src/Orchestrator src/tests/BaseApi.Tests grafana/dashboards/skp-orchestrator.json
git commit -m "refactor(orchestrator): stopped workflows stay in L1; remove the reap loop

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Retire the old contracts

**Files:**
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` (delete `ParentIndex`, `Root`, `Step`; remove the "Retiring" list item)
- Delete: `src/Messaging.Contracts/Projections/WorkflowRootProjection.cs`, `StepProjection.cs`, `LivenessProjection.cs`
- Modify: `src/tests/BaseApi.Tests/Cache/CacheKeyTests.cs` (delete `ACacheKeyCannotCollideWithAStepKey` and `ARootProjectionWrittenBeforeCachesExistedReadsAsNoCaches`)

**Interfaces:**
- Consumes: Tasks 1–7 (nothing references these any more).

- [ ] **Step 1: Write the failing test**

Add to `src/tests/BaseApi.Tests/Projection/L2KeyLayoutTests.cs`:

```csharp
    [Fact]
    public void TheRetiredShapesAreGone()
    {
        var keys = typeof(L2ProjectionKeys);
        Assert.Null(keys.GetMethod("ParentIndex"));
        Assert.Null(keys.GetMethod("Root"));
        Assert.Null(keys.GetMethod("Step"));
        Assert.Null(keys.GetMethod("Name"));
        Assert.Null(keys.GetMethod("InstanceIndex"));
        Assert.Null(keys.Assembly.GetType("Messaging.Contracts.Projections.WorkflowRootProjection"));
        Assert.Null(keys.Assembly.GetType("Messaging.Contracts.Projections.StepProjection"));
        Assert.Null(keys.Assembly.GetType("Messaging.Contracts.Projections.LivenessProjection"));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Projection.L2KeyLayoutTests"`
Expected: `TheRetiredShapesAreGone` FAILS.

- [ ] **Step 3: Delete them**

Delete the three methods and three files named above, and the two `CacheKeyTests` tests. Then:

Run: `grep -rnE "WorkflowRootProjection|StepProjection|LivenessProjection|ParentIndex\(|L2ProjectionKeys\.(Root|Step)\(" src --include=*.cs | grep -v /bin/ | grep -v /obj/`
Expected: no output.

- [ ] **Step 4: Pack and run the tests**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: `failed: 0`, exit 0. Also build Release once to catch analyzer-as-error drift: `dotnet build SK_P.sln -c Release --nologo -v q` → `0 Error(s)`.

- [ ] **Step 5: Commit**

```bash
git add -A src/Messaging.Contracts src/tests/BaseApi.Tests
git add -u
git commit -m "refactor(contracts): retire the root, step, parent-index and name key shapes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Tools and docs read names from the hashes

**Files:**
- Modify: `tools/offline/skp_names.py`
- Modify: `tools/offline/test_skp_names.py`
- Modify: `tools/verify-kibana-dashboard.py` (docstrings/comments at lines 19, 175-189, 669; the error message at 795)
- Modify: `tools/offline/pin-workflow-control.py:7` (docstring)
- Modify: `kibana/README.md:52-80`

**Interfaces:**
- Produces: `skp_names.read_names(host, port) -> {id: name}` (scans `skp:wf:*`, `skp:step:*`, `skp:proc:*`, keeps only keys whose third segment is a bare GUID, reads `HGET <key> name`); `skp_names.read_name(host, port, entity_id, kind="wf")`.

- [ ] **Step 1: Write the failing tests**

In `tools/offline/test_skp_names.py` replace `test_scan_then_mget`, `test_read_name_from_found` and `test_read_name_from_missing` with:

```python
    def test_scan_filters_to_entity_hashes_then_hgets_name(self):
        # One SCAN per kind (wf, step, proc), each returning cursor "0". The wf scan also returns a cache
        # key and the proc scan an instances set and a per-instance key; only bare-GUID keys are read.
        wf = "skp:wf:208cba76-d635-4721-9aff-a7f22ee09224"
        replies = (
            _array(_bulk("0"), _array(_bulk(wf), _bulk(wf + ":cache:sk-whitelist")))
            + _array(_bulk("0"), _array())
            + _array(_bulk("0"), _array(_bulk("skp:proc:11111111-1111-1111-1111-111111111111:instances"),
                                        _bulk("skp:proc:11111111-1111-1111-1111-111111111111:pod-0")))
            + _bulk("chain_1.0.0-9aff-a7f22ee09224")
        )
        sock = Fake(replies)

        names = skp_names.read_names_from(sock)

        self.assertEqual({"208cba76-d635-4721-9aff-a7f22ee09224": "chain_1.0.0-9aff-a7f22ee09224"}, names)
        self.assertIn(b"skp:wf:*", sock.sent)
        self.assertIn(b"skp:step:*", sock.sent)
        self.assertIn(b"skp:proc:*", sock.sent)
        self.assertEqual(1, sock.sent.count(b"HGET"))

    def test_read_name_from_found(self):
        value = "chain_1.0.0-9aff-a7f22ee09224"
        sock = Fake(_bulk(value))

        name = skp_names.read_name_from(sock, "208cba76-d635-4721-9aff-a7f22ee09224")

        self.assertEqual(value, name)
        self.assertIn(b"HGET", sock.sent)
        self.assertIn(b"skp:wf:208cba76-d635-4721-9aff-a7f22ee09224", sock.sent)
        self.assertIn(b"name", sock.sent)

    def test_read_name_from_missing(self):
        sock = Fake(b"$-1\r\n")

        self.assertIsNone(skp_names.read_name_from(sock, "11111111-1111-1111-1111-111111111111"))
```

(Keep any other existing tests; if one asserts on `skp:name:`, change it to the hash shape the same way.)

- [ ] **Step 2: Run to verify failure**

Run: `cd tools/offline && python -m unittest test_skp_names -v; cd ../..`
Expected: the three tests FAIL (the module still scans `skp:name:*` and uses GET).

- [ ] **Step 3: Implement**

In `tools/offline/skp_names.py`:
- Module docstring: `"""Read entity display names from L2 (HASH skp:{wf|step|proc}:{id}, field "name") without a redis client library.` and "BaseApi writes workflow and step names on every start; each processor instance writes its own."
- Replace `PREFIX = "skp:name:"` with:

```python
KINDS = ("wf", "step", "proc")
_ENTITY_KEY = re.compile(r"^skp:(wf|step|proc):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
```

- Replace `read_names_from`, `read_name_from`, `read_name`:

```python
def read_names_from(sock):
    f = sock.makefile("rb")
    keys = []
    for kind in KINDS:
        cursor = "0"
        while True:
            _command(sock, "SCAN", cursor, "MATCH", f"skp:{kind}:*", "COUNT", "1000")
            cursor, batch = _reply(f)
            keys += [k for k in batch if _ENTITY_KEY.match(k)]
            if cursor == "0":
                break
    names = {}
    for key in keys:
        _command(sock, "HGET", key, "name")
        value = _reply(f)
        if value is not None:
            names[_ENTITY_KEY.match(key).group(2)] = value
    return names


def read_name_from(sock, entity_id, kind="wf"):
    """The name field of skp:{kind}:{entity_id}, or None when the key or field is absent (RESP nil)."""
    f = sock.makefile("rb")
    _command(sock, "HGET", f"skp:{kind}:{entity_id}", "name")
    return _reply(f)


def read_name(host="localhost", port=6380, entity_id=None, kind="wf", timeout=10):
    """The one name at skp:{kind}:{entity_id}, or None if it is unset. A single HGET, not a scan."""
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        return read_name_from(sock, entity_id, kind)
    finally:
        sock.close()
```

- `read_names` docstring: "{id: full name} for every workflow, step and processor hash."
- `tools/verify-kibana-dashboard.py`: replace every `skp:name:*` / `skp:name:{id}` mention in comments, docstrings and the error message at line 795 with `skp:{wf|step|proc}:{id} name`. Replace "D8 never deletes skp:name:* keys" (line 669) with "workflow and step name keys are never deleted".
- `tools/offline/pin-workflow-control.py:7`: "D8 never deletes skp:name:*" → "workflow name keys are never deleted".
- `kibana/README.md:52-80`: `skp:name:{id}` → `the name field of skp:wf:{id} / skp:step:{id} / skp:proc:{id}`; the sentence "the key BaseApi writes for every workflow, step and processor" → "BaseApi writes the workflow and step names on every start; each processor instance writes its own"; "stale `skp:name:*` entries" → "stale name keys".

- [ ] **Step 4: Run the tests**

Run: `cd tools/offline && python -m unittest test_skp_names -v; cd ../..`
Expected: all PASS.

Run: `grep -rn "skp:name" tools kibana src --include=*.py --include=*.md --include=*.cs | grep -v /bin/ | grep -v /obj/`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add tools/offline/skp_names.py tools/offline/test_skp_names.py tools/verify-kibana-dashboard.py tools/offline/pin-workflow-control.py kibana/README.md
git commit -m "chore(tools): read entity names from the typed L2 hashes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Dev rollout (operator-approved — do not run without an explicit go)

Outward-facing and hard to reverse. The executor stops before Step 1 and asks the user.

**Files:** none (cluster operations). Cluster `desktop` (kind), namespace `skp`; Redis forward on the offset port (see the supervised port-forwards).

- [ ] **Step 1: Pre-flight**

Confirm the forwards are alive (never judge by netstat on default ports) and record the running set: `redis-cli -p 6380 --scan --pattern 'skp:*' | sort > /tmp/l2-before.txt` (run in the scratchpad, not the repo).

- [ ] **Step 2: Stop every workflow through BaseApi** (`POST /…/stop` per workflow id listed in `skp:` / the registry), so no lineage is mid-flight on old keys.

- [ ] **Step 3: Build and load the images** — BaseApi, Orchestrator, and every processor (the framework packages changed; a framework-only edit moves no processor SourceHash, but `Processor.SKNormalizer` also carries 4d8a013's project change, so repoint its SourceHash after rebuild). `kind load` each image.

- [ ] **Step 4: Delete the retired keys** (after BaseApi and the orchestrator are scaled to the new image, before the processors):
  - `DEL skp:` (old parent index)
  - every `skp:{guid}` and `skp:{guid}:{guid}` (old roots and steps) and `skp:{guid}:cache:*` (old cache keys)
  - every `skp:name:*`
  - every `skp:proc:{guid}` whose `TYPE` is `set` (old instance index — it blocks the new name hash with WRONGTYPE)
  Use `--scan` + `TYPE` filtering; never `FLUSHALL` (it wipes live L2 that other pods rely on).

- [ ] **Step 5: Roll out in order** — BaseApi → orchestrator → processors; wait for each to be Ready.

- [ ] **Step 6: Restart the workflows** that were running (start each through BaseApi).

- [ ] **Step 7: Verify**
  - `SMEMBERS skp:live` = the restarted ids.
  - `HGETALL skp:wf:{id}` has `name`, `store`, `roots`.
  - `HGET skp:proc:{id} name` present and `TTL skp:proc:{id}` > 0 for each running processor.
  - Orchestrator logs "activated workflow …" once per replica per workflow; no "L2 does not hold".
  - Stop one workflow → its orchestrator logs "unscheduled the workflow's job and marked it stopped"; `HGET skp:wf:{id} store` still present.

- [ ] **Step 8: Record** the rollout in memory (the key-layout notes in `MEMORY.md` that mention `skp:name:*`, `skp:proc:*` as a SET, or the parent index are now wrong and must be updated). The offline machine needs its own ship delta (`tools/ship-delta.ps1`) with the same key cleanup; that is a separate, approved step.

---

## Self-review

- **Spec coverage:** principles 1–6 → Tasks 5, 6 (start-only alignment, no other writers), 3/4 (processor-owned keys + TTL). Key layout → Task 1 (+ 3, 4, 5, 6). BaseApi start/stop → Task 6. Removed from BaseApi → Tasks 5 (processor names), 6 (`L2Cleanup`). Orchestrator activation/hydration/stop/runtime/names → Task 6; no reaper → Task 7. Processor → Tasks 3, 4, 5. Accepted behaviour needs no code; restart-overwrite pinned by `ARestartOverwritesTheL1EntryWithTheNewDefinition`. Retired shapes → Task 8. Tools → Task 9. Rollout → Task 10.
- **Placeholders:** the two `// [… unchanged]` markers in Task 6 point at code written verbatim in Task 5 or already in the file (templates that must not change); they are moves, not gaps.
- **Type consistency:** `L2ProjectionKeys.{Live, Workflow, StepEntity, Processor, Entity, ProcessorInstances, TryParseProcessorInstances, NameField, StoreField, RootsField}`, `L2EntityKind`, `WorkflowStoreProjection`, `EntityRef`, `L2LiveSet.{AddAsync, RemoveAsync}`, `L2WorkflowReader.IsLiveAsync`, `EntityNameResolver.PreloadAsync`, `ProcessorLivenessWriter.WriteAsync(ProcessorIdentity, string, ProcessorLivenessEntry)` are used with the same names and signatures in every task.
- **Review Focus:** all five have a pinning test in their owning task.
