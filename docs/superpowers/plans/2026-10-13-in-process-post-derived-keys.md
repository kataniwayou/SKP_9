# In-process post hops and derived entry ids — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No step output ever travels inside a RabbitMQ message: the processor's and the orchestrator's post hops become awaited in-process calls that write L2 under derived, replay-stable keys.

**Architecture:** Three parts, each shippable on its own. **Part 1 (release 1)** — shared contracts (UUIDv5, entry-id formulas), a wider L2 fault classifier, a one-line orchestrator fix (`IsNull`), and the whole processor side: empty keys mean "no data", `SendToPostAsync` derives `E` and finishes the branch in-process through a new `BranchFinisher`, the importer takes its id from a Kafka header. **Part 2 (release 2)** — the orchestrator derives `S`, copies the blob inside Redis, dispatches successors in-process and remembers them in `handoff:{E}`. **Part 3 (after both post queues read zero)** — delete the post queues, their handlers, constants and topology.

**Tech Stack:** C# / .NET 8, StackExchange.Redis 2.13.1, RabbitMQ.Client 7.1.2, Confluent.Kafka 2.15, xunit v3 (Microsoft Testing Platform), NSubstitute 5.3, Python 3 (feeds).

**Spec:** `docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md` (approved 2026-10-13). Section numbers below (§5.1 etc.) refer to it.

## Global Constraints

- Policy (§2): a duplicate is acceptable, a loss is not. No `data:` key gets a TTL.
- **Absent = duplicate. Empty = no data.** Distinguish with `RedisValue.IsNull`, never `IsNullOrEmpty`, on every `data:` read.
- `Guid.Empty` as an input `EntryId` survives only on the cron fire's entry-step dispatch (`WorkflowFireJob.cs:285`) — and, until Part 2 ships, on the release-1 orchestrator's no-data hand-offs.
- Processor `E` (§5.1): input key set → `UUIDv5(inputEntryId, executionId)`; no input key → `UUIDv5(WorkflowId, StepId, executionId)`. Orchestrator `S` (§5.2): `E` set → `UUIDv5(E, nextStepId)`; `E` empty → `UUIDv5(CorrelationId, StepId, nextStepId)`. All through `EntryIds` in `Messaging.Contracts`, never computed inline.
- `SendToPostAsync` keeps its signature and throws on `executionId == Guid.Empty`.
- Log templates are matched by Kibana, the Analyst and live tests: every template that exists today keeps its exact text (`branch completed in {ElapsedMs}ms`, `output failed its schema {OutputSchemaId} — reported failed: {SchemaErrors}`, `handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}`, `dispatched in {ElapsedMs}ms`, `could not start the step — reporting it failed`, `the execution blob is absent — treating as a duplicate delivery, advancing nothing`, `imported record {Record} as execution {ExecutionId} from {Origin}`, `consumed {Consumed}/{Requested} records; stopped because {Reason}`).
- Kafka header name: `execution-id`, value the GUID's `D` text in UTF-8.
- Feeds stamp `execution-id = uuid5(NS_FEED, filePath)`.
- Redis: `--maxmemory 144mb --maxmemory-policy noeviction` under the existing 192Mi limit.
- Library changes (`Messaging.Contracts`, `BaseConsole.Core`, `BaseProcessor.Core`) reach the tests and the processors only through the local packages: run `bash scripts/pack-all.sh` after editing any of them and before building the tests. It rewrites `packages.lock.json` files; commit the ones it changes with the task.
- Test runner: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`, then `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "<Namespace.Class>"` for one class, or with no filter for the suite. `dotnet test` hides failure names. Suite gate: 0 failed, exit 0, every skip under `Live/`.
- Commit only the files the task names (the working tree carries unrelated edits to `k8s/31-workflow-studio.yaml`, `k8s/43-processor-analyst.yaml`, `k8s/README.md`, `src/WorkflowStudio/Dockerfile` and untracked files — never `git add -A`). Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Code style: match the surrounding files — explanatory `//` blocks on non-obvious decisions, `ConfigureAwait(false)` in library code, all five `StringSetAsync` arguments named positionally (`key, value, null, When.X, CommandFlags.None`).

## Review Focus

1. **A dispatch whose input key holds `""` (an empty value, not an absent key).** Expected: the author runs on empty data with the input schema skipped, and the key is deleted afterwards — not treated as a duplicate. Pinned in Task 4 (`RunsTheAuthorOnEmptyDataWhenTheInputKeyHoldsNoData`, `SkipsTheInputSchemaWhenTheInputKeyHoldsNoData`).
2. **A replayed dispatch of a one-output transform.** Expected: the replay writes the same `E` with the same bytes and reports the same outcome — L2 converges. Pinned in Task 6 (`ReplayingADispatchRewritesTheSameBranchKey`).
3. **A Kafka record with no `execution-id` header, a non-GUID header, or `Guid.Empty`.** Expected: the record is committed, not imported, and the dispatch fails — even when earlier records in the same dispatch were sent. Pinned in Task 7 (three facts).
4. **An orchestrator redelivery after k of N successors were dispatched.** Expected: only the N−k are dispatched again; none twice. Pinned in Task 11 (`ARedeliveryDoesNotResendASuccessorAlreadyDispatched`).
5. **One successor whose dispatch fails deterministically in a fan-out.** Expected: its siblings are still dispatched, it alone is reported Failed under its own `S`, and the outcome is acked. Pinned in Task 11 (`ADeterministicDispatchFailureCostsOnlyThatSuccessor`).

---

## File map

| File | Part | Change |
|---|---|---|
| `src/Messaging.Contracts/Uuid5.cs` | 1 | **new** — RFC 9562 §5.5 name-based UUID |
| `src/Messaging.Contracts/EntryIds.cs` | 1 | **new** — `Branch`, `Successor`, `HandoffSource` |
| `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` | 1 | + `ExecutionHandoffs(Guid)` |
| `src/BaseConsole.Core/Gating/L2FaultClassifier.cs` | 1 | OOM / READONLY / LOADING / BUSY are transient |
| `src/Orchestrator/Messaging/StepOutcomeHandler.cs` | 1, 2 | 1: `IsNull`. 2: derived `S`, COPY / SET NX, in-process dispatch, `handoff:{E}` |
| `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` | 1 | empty input key; passes the input key and the branch sink to `DispatchState` |
| `src/BaseProcessor.Core/Processing/IBranchSink.cs` | 1 | **new** |
| `src/BaseProcessor.Core/Processing/BranchFinisher.cs` | 1 | **new** — validate, `SET data:{E}`, `StepOutcome` |
| `src/BaseProcessor.Core/Processing/OutputSchemaPendingException.cs` | 1 | **new** — requeue while the output schema resolves |
| `src/BaseProcessor.Core/Processing/DispatchState.cs` | 1 | sink + input entry id instead of the sender |
| `src/BaseProcessor.Core/Processing/BaseProcessor.cs` | 1 | `SendToPostAsync` derives `E`, finishes in-process; doc comments |
| `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs` | 1, 3 | 1: register `BranchFinisher`. 3: drop the post queue |
| `src/Processor.KafkaImporter/Kafka/KafkaRecord.cs`, `KafkaRecordConsumer.cs`, `KafkaImporterProcessor.cs` | 1 | header id; refuse a record without one |
| `tools/kafka-produce-records.py`, `tools/simulate-endless-feed.py` | 1 | stamp the header |
| `k8s/11-redis.yaml`, `k8s/37-…`, `k8s/38-…`, `k8s/40-…` | 1 | `maxmemory`; sizing comments |
| `src/tests/BaseApi.Tests/Support/SenderBranchSink.cs`, `TestDispatch.cs` | 1 | **new** — test seam for author tests |
| `src/tests/BaseApi.Tests/Support/InMemoryL2.cs` | 2 | `KeyCopyAsync`, `When.NotExists` |
| `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs`, `src/Orchestrator/Messaging/NextStepHandoffHandler.cs`, `src/Messaging.Contracts/NextStepHandoff.cs` | 3 | **deleted** |

---

# Part 1 — Release 1

Deploy order for this part (Task 10): the orchestrator image from Task 3 goes out **before** any processor image.

### Task 0: Branch and spec

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md:3-5`

- [ ] **Step 1: Create the branch from the current HEAD**

```bash
git switch -c feature/in-process-post
```

- [ ] **Step 2: Mark the spec approved**

Replace lines 3-5 of the spec:

```markdown
**Date:** 2026-10-12, revised 2026-10-13
**Status:** Approved 2026-10-13. Implementation plan:
`docs/superpowers/plans/2026-10-13-in-process-post-derived-keys.md`.
```

- [ ] **Step 3: Commit the spec and this plan**

```bash
git add docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md docs/superpowers/plans/2026-10-13-in-process-post-derived-keys.md
git commit -m "docs: in-process post hops and derived entry ids — approved design and plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: UUIDv5 and the entry-id formulas (`Messaging.Contracts`)

**Files:**
- Create: `src/Messaging.Contracts/Uuid5.cs`
- Create: `src/Messaging.Contracts/EntryIds.cs`
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` (after `ExecutionData`, line 153)
- Test: `src/tests/BaseApi.Tests/Messaging/Uuid5Tests.cs`, `src/tests/BaseApi.Tests/Messaging/EntryIdsTests.cs`

**Interfaces:**
- Produces: `Uuid5.Create(Guid namespaceId, string name) : Guid`; `EntryIds.Namespace : Guid`; `EntryIds.Branch(Guid inputEntryId, Guid workflowId, Guid stepId, Guid executionId) : Guid`; `EntryIds.Successor(Guid entryId, Guid correlationId, Guid stepId, Guid nextStepId) : Guid`; `EntryIds.HandoffSource(Guid entryId, Guid correlationId, Guid stepId) : Guid`; `L2ProjectionKeys.ExecutionHandoffs(Guid sourceId) : string` (`skp:handoff:{id:D}`).

- [ ] **Step 1: Write the failing tests**

`src/tests/BaseApi.Tests/Messaging/Uuid5Tests.cs`:

```csharp
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Messaging;

public sealed class Uuid5Tests
{
    /// <summary>The RFC's DNS namespace, so the vector below can be checked against any implementation.</summary>
    private static readonly Guid Dns = Guid.Parse("6ba7b810-9dad-11d1-80b4-00c04fd430c8");

    [Fact]
    public void MatchesThePublishedVector()
    {
        // Python: uuid.uuid5(uuid.NAMESPACE_DNS, "python.org"). Pins the byte order: .NET's Guid
        // layout is little-endian in its first three fields and RFC 9562 is big-endian throughout,
        // so an implementation that forgot to swap would still be deterministic — and wrong.
        Assert.Equal(Guid.Parse("886313e1-3b8a-5372-9b90-0c9aee199e5d"), Uuid5.Create(Dns, "python.org"));
    }

    [Fact]
    public void IsStableAndCarriesVersionFiveAndTheRfcVariant()
    {
        var a = Uuid5.Create(Dns, "skp");
        var text = a.ToString("D");

        Assert.Equal(a, Uuid5.Create(Dns, "skp"));
        Assert.Equal('5', text[14]);
        Assert.Contains(text[19].ToString(), "89ab", StringComparison.Ordinal);
    }

    [Fact]
    public void DifferentNamesGiveDifferentIds()
        => Assert.NotEqual(Uuid5.Create(Dns, "a"), Uuid5.Create(Dns, "b"));
}
```

`src/tests/BaseApi.Tests/Messaging/EntryIdsTests.cs`:

```csharp
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Messaging;

public sealed class EntryIdsTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid N = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid X = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid In = Guid.Parse("66666666-6666-6666-6666-666666666666");

    [Fact]
    public void ABranchWithAnInputKeyIsDerivedFromThatKeyAndTheExecution()
    {
        // §5.1 row 1: the input key is unique per run, which separates the two runs of a fan-in step,
        // a diamond and a loop — so the workflow and step ids add nothing and are not inputs.
        Assert.Equal(EntryIds.Branch(In, W, S, X), EntryIds.Branch(In, Guid.NewGuid(), Guid.NewGuid(), X));
        Assert.NotEqual(EntryIds.Branch(In, W, S, X), EntryIds.Branch(In, W, S, N));
    }

    [Fact]
    public void AnEntryBranchIsDerivedFromTheWorkflowTheStepAndTheExecution()
    {
        // §5.1 row 2: no input key, so the lineage is all there is.
        Assert.Equal(EntryIds.Branch(Guid.Empty, W, S, X), EntryIds.Branch(Guid.Empty, W, S, X));
        Assert.NotEqual(EntryIds.Branch(Guid.Empty, W, S, X), EntryIds.Branch(Guid.Empty, W, N, X));
    }

    [Fact]
    public void ASuccessorIsDerivedFromItsPredecessorsKeyAndItsOwnStep()
    {
        Assert.Equal(EntryIds.Successor(In, C, S, N), EntryIds.Successor(In, Guid.NewGuid(), Guid.NewGuid(), N));
        Assert.NotEqual(EntryIds.Successor(In, C, S, N), EntryIds.Successor(In, C, S, W));
    }

    [Fact]
    public void AnEntryStepsSuccessorIsDerivedFromTheRun()
    {
        // §5.2 row 2: an entry step's Failed or Cancelled outcome names Guid.Empty, and an entry step
        // is dispatched once per fire, so the correlation id makes the key unique.
        Assert.NotEqual(EntryIds.Successor(Guid.Empty, C, S, N), EntryIds.Successor(Guid.Empty, X, S, N));
    }

    [Fact]
    public void TheFormulasNeverMeet()
    {
        // A purpose tag separates them: Branch(a, b) and Successor(a, b) hash different names.
        Assert.NotEqual(EntryIds.Branch(In, W, S, X), EntryIds.Successor(In, C, S, X));
    }

    [Fact]
    public void TheHandoffSourceIsTheEntryIdWhenThereIsOne()
    {
        Assert.Equal(In, EntryIds.HandoffSource(In, C, S));
        Assert.NotEqual(Guid.Empty, EntryIds.HandoffSource(Guid.Empty, C, S));
        Assert.NotEqual(EntryIds.HandoffSource(Guid.Empty, C, S), EntryIds.HandoffSource(Guid.Empty, X, S));
    }

    [Fact]
    public void TheHandoffSetLivesBesideTheData()
        => Assert.Equal($"skp:handoff:{In:D}", L2ProjectionKeys.ExecutionHandoffs(In));
}
```

- [ ] **Step 2: Build to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: FAIL — `CS0103: The name 'Uuid5' does not exist`.

- [ ] **Step 3: Implement**

`src/Messaging.Contracts/Uuid5.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;

namespace Messaging.Contracts;

/// <summary>
/// Name-based UUIDs, version 5 (RFC 9562 §5.5): SHA-1 over a namespace id and a name, so the same
/// inputs give the same id on every host and every run. .NET 8 has none built in.
/// <para>
/// <b>SHA-1 is not used for security here.</b> It is the hash the RFC fixes for version 5; nothing
/// relies on the id being hard to forge, only on it being stable and well spread.
/// </para>
/// </summary>
public static class Uuid5
{
    public static Guid Create(Guid namespaceId, string name)
    {
        ArgumentNullException.ThrowIfNull(name);

        var nameBytes = Encoding.UTF8.GetBytes(name);
        var input = new byte[16 + nameBytes.Length];

        // Big-endian, as the RFC lays a UUID out. Guid.ToByteArray() would swap the first three
        // fields and give a stable id that no other implementation agrees with.
        namespaceId.TryWriteBytes(input.AsSpan(0, 16), bigEndian: true, out _);
        nameBytes.CopyTo(input, 16);

        Span<byte> hash = stackalloc byte[20];
        SHA1.HashData(input, hash);

        hash[6] = (byte)((hash[6] & 0x0F) | 0x50);   // version 5
        hash[8] = (byte)((hash[8] & 0x3F) | 0x80);   // RFC variant

        return new Guid(hash[..16], bigEndian: true);
    }
}
```

`src/Messaging.Contracts/EntryIds.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// Every derived <c>data:</c> key in the execution path, in one place, so the processor and the
/// orchestrator cannot drift apart. See §5 of
/// <c>docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md</c>.
/// <para>
/// <b>Derived, not random, and that is the whole point.</b> A replay of the same work names the same
/// key and rewrites it, so L2 converges instead of collecting a second copy that nothing will ever
/// read or delete — <c>data:</c> keys have no TTL and no sweeper.
/// </para>
/// <para>
/// <b>Each formula carries a purpose tag</b> (<c>branch</c>, <c>entry-branch</c>, ...) and joins its
/// inputs with a separator, so two formulas, or two splits of the same inputs, can never hash the
/// same name.
/// </para>
/// </summary>
public static class EntryIds
{
    /// <summary>
    /// The namespace every derived entry id is minted under. <b>Never change it:</b> a different
    /// namespace derives different keys, and every blob in flight across the deploy would be orphaned.
    /// </summary>
    public static readonly Guid Namespace = Guid.Parse("b3a9e1d4-6c2f-4f7a-9e85-2d1c7b0a4f63");

    /// <summary>
    /// The key a processor writes one branch to (§5.1). With an input key: that key and the
    /// execution. Without one — an entry step dispatched by the fire — the workflow, the step and the
    /// execution.
    /// </summary>
    public static Guid Branch(Guid inputEntryId, Guid workflowId, Guid stepId, Guid executionId) =>
        inputEntryId != Guid.Empty
            ? Derive("branch", inputEntryId, executionId)
            : Derive("entry-branch", workflowId, stepId, executionId);

    /// <summary>
    /// The key the orchestrator hands one successor (§5.2). With the predecessor's key: that key and
    /// the successor's step. Without one — an entry step's Failed or Cancelled outcome — the run, the
    /// step that ended and the successor's step; an entry step is dispatched once per fire, so the
    /// correlation id keeps it unique.
    /// </summary>
    public static Guid Successor(Guid entryId, Guid correlationId, Guid stepId, Guid nextStepId) =>
        entryId != Guid.Empty
            ? Derive("successor", entryId, nextStepId)
            : Derive("entry-successor", correlationId, stepId, nextStepId);

    /// <summary>
    /// The id the orchestrator's <c>handoff:</c> set is named after: the outcome's own key, or for an
    /// outcome that names none, the same run-and-step pair <see cref="Successor"/> falls back to.
    /// </summary>
    public static Guid HandoffSource(Guid entryId, Guid correlationId, Guid stepId) =>
        entryId != Guid.Empty ? entryId : Derive("entry-handoff", correlationId, stepId);

    private static Guid Derive(string purpose, params Guid[] parts) =>
        Uuid5.Create(Namespace, purpose + "|" + string.Join("|", parts.Select(p => p.ToString("D"))));
}
```

`src/Messaging.Contracts/Projections/L2ProjectionKeys.cs`, after line 153 (`ExecutionData`):

```csharp
    /// <summary>
    /// The successors already dispatched for one outcome, as a set of step ids. Lets a redelivered
    /// outcome skip what an earlier attempt already sent. Deleted with the outcome's own data key.
    /// </summary>
    public static string ExecutionHandoffs(Guid sourceId) => $"{Prefix}handoff:{sourceId:D}";
```

- [ ] **Step 4: Pack and build**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: build succeeds. If the analyzer reports `CA5350` on `SHA1.HashData`, add above the method `[System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA5350", Justification = "RFC 9562 fixes SHA-1 for version 5; not a security use.")]` and re-run the step.

- [ ] **Step 5: Run the tests**

Run: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Messaging.Uuid5Tests" --filter-class "BaseApi.Tests.Messaging.EntryIdsTests"`
Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add src/Messaging.Contracts/Uuid5.cs src/Messaging.Contracts/EntryIds.cs src/Messaging.Contracts/Projections/L2ProjectionKeys.cs src/tests/BaseApi.Tests/Messaging/Uuid5Tests.cs src/tests/BaseApi.Tests/Messaging/EntryIdsTests.cs src/Messaging.Contracts/nugets
git add -u '*packages.lock.json'
git commit -m "feat(contracts): UUIDv5 and the derived entry-id formulas — EntryIds.Branch / Successor / HandoffSource, one place for every data: key both hosts derive

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Transient Redis server states (`BaseConsole.Core`)

**Files:**
- Modify: `src/BaseConsole.Core/Gating/L2FaultClassifier.cs:16-31`
- Test: `src/tests/BaseApi.Tests/Console/ConsoleL2FaultClassifierTests.cs`

**Interfaces:**
- Produces: `L2FaultClassifier.IsTransient(Exception)` (BaseConsole) now also true for a `RedisServerException` whose message starts with `OOM`, `READONLY`, `LOADING` or `BUSY` as a whole word.

- [ ] **Step 1: Write the failing test**

```csharp
using BaseConsole.Core.Gating;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The server states that clear on their own. Before the in-process post hop, a full or failing-over
/// store refused a write on the post queue's own delivery; now the refusal lands inside the dispatch,
/// and parking it would lose a branch the store would have accepted a minute later.
/// </summary>
public sealed class ConsoleL2FaultClassifierTests
{
    [Theory]
    [InlineData("OOM command not allowed when used memory > 'maxmemory'.")]
    [InlineData("READONLY You can't write against a read only replica.")]
    [InlineData("LOADING Redis is loading the dataset in memory")]
    [InlineData("BUSY Redis is busy running a script.")]
    public void AServerStateThatClearsOnItsOwnIsTransient(string message)
    {
        Assert.True(L2FaultClassifier.IsTransient(new RedisServerException(message)));
        Assert.Equal(DeliveryDisposition.RequeueAndTrip,
                     DeliveryClassifier.Classify(new RedisServerException(message)));
    }

    [Theory]
    [InlineData("NOPERM this user has no permissions to run the 'copy' command")]
    [InlineData("ERR unknown command 'COPY'")]
    [InlineData("WRONGTYPE Operation against a key holding the wrong kind of value")]
    [InlineData("BUSYGROUP Consumer Group name already exists")]
    public void ARejectedCommandIsStillDeterministic(string message)
        => Assert.False(L2FaultClassifier.IsTransient(new RedisServerException(message)));

    [Fact]
    public void AWrappedServerStateIsStillFound()
        => Assert.True(L2FaultClassifier.IsTransient(
            new InvalidOperationException("outer", new RedisServerException("OOM full"))));
}
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Console.ConsoleL2FaultClassifierTests"`
Expected: FAIL — the four transient cases and the wrapped case report `False`.

- [ ] **Step 3: Implement**

Replace the `IsTransient` member and its doc's last `<para>` in `src/BaseConsole.Core/Gating/L2FaultClassifier.cs` (lines 16-31) with:

```csharp
    /// <summary>
    /// True when the failure is the store being unreachable rather than the message being wrong.
    /// <para>
    /// <b>The whole exception chain is walked, not just the outermost type.</b> A handler that wraps
    /// its failure, or one that fails inside a combinator and surfaces an aggregate, would otherwise
    /// fall through to the deterministic branch — turning a transient outage into permanently parked
    /// work, which is the most expensive mistake available here.
    /// </para>
    /// <para>
    /// <b>A server-side error is transient only for the four states that clear on their own</b>:
    /// <c>OOM</c> (maxmemory reached under <c>noeviction</c>), <c>READONLY</c> (a failover in
    /// progress), <c>LOADING</c> and <c>BUSY</c>. Every other server error is a rejected command —
    /// <c>NOPERM</c>, <c>WRONGTYPE</c>, an unknown command — and requeueing it would retry a message
    /// the store will refuse every time. The match is on the first word of the reply, so
    /// <c>BUSYGROUP</c> is not <c>BUSY</c>.
    /// </para>
    /// </summary>
    public static bool IsTransient(Exception ex) =>
        Unwrap(ex).Any(e => e is RedisConnectionException or RedisTimeoutException || IsTransientServerState(e));

    private static readonly string[] TransientServerStates = ["OOM", "READONLY", "LOADING", "BUSY"];

    private static bool IsTransientServerState(Exception e)
    {
        if (e is not RedisServerException server)
        {
            return false;
        }

        var space = server.Message.IndexOf(' ', StringComparison.Ordinal);
        var word = space < 0 ? server.Message : server.Message[..space];
        return TransientServerStates.Contains(word, StringComparer.Ordinal);
    }
```

- [ ] **Step 4: Pack, build, run**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Console.ConsoleL2FaultClassifierTests"`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseConsole.Core/Gating/L2FaultClassifier.cs src/tests/BaseApi.Tests/Console/ConsoleL2FaultClassifierTests.cs src/BaseConsole.Core/nugets
git add -u '*packages.lock.json'
git commit -m "feat(console): OOM, READONLY, LOADING and BUSY are transient — the store refusing a write while full or failing over requeues and trips the gate instead of parking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The orchestrator reads an empty blob as no data (release-1 orchestrator)

**Files:**
- Modify: `src/Orchestrator/Messaging/StepOutcomeHandler.cs:421-475` (`ReadAsync` and its doc)
- Test: `src/tests/BaseApi.Tests/Orchestrator/ExecutionRoundTripTests.cs` (new fact after `AStepsOutputBecomesTheNextStepsInput`)

**Interfaces:**
- Consumes: nothing new.
- Produces: a Completed outcome whose `data:{E}` holds `""` advances with no data (successors get `Guid.Empty`, as every no-data hand-off does in release 1) and `E` is reclaimed.

- [ ] **Step 1: Write the failing test**

Add to `ExecutionRoundTripTests` after `AStepsOutputBecomesTheNextStepsInput`:

```csharp
    [Fact]
    public async Task ACompletedOutcomeWhoseKeyHoldsNoDataAdvancesWithNoData()
    {
        // The processor now writes "" under a no-data branch's own key instead of reporting
        // Guid.Empty. Read with IsNullOrEmpty that key looked absent — a duplicate — and the step's
        // successors were never dispatched. Empty means "no data"; only absent means "already done".
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, "");

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));
        await h.Drain();

        var dispatch = h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single();
        Assert.Equal(B, dispatch.StepId);
        Assert.Equal(Guid.Empty, dispatch.EntryId);
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
        Assert.DoesNotContain(h.PreLog.Records,
            r => r.Message.Contains("duplicate delivery", StringComparison.Ordinal));
    }
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.ExecutionRoundTripTests"`
Expected: FAIL — `ACompletedOutcomeWhoseKeyHoldsNoDataAdvancesWithNoData`: sequence contains no elements (nothing dispatched).

- [ ] **Step 3: Implement**

In `ReadAsync`, replace

```csharp
        if (raw.IsNullOrEmpty)
        {
            // Null, not an exception: the caller returns without advancing or reclaiming, and the
            // consumer acks. Matches ProcessDispatchHandler's "entry absent" branch, which is the
            // divergence this closes.
            return null;
        }

        return (byte[])raw!;
```

with

```csharp
        // IsNull, NOT IsNullOrEmpty. Redis keeps "" as a value and answers Null only for a missing
        // key, and the processor writes "" under a no-data branch's own key: absent is a duplicate,
        // empty is a step that finished with nothing to hand on. Reading "" as absent dropped that
        // step's successors as a duplicate. See §4 of the in-process post design.
        if (raw.IsNull)
        {
            // Null, not an exception: the caller returns without advancing or reclaiming, and the
            // consumer acks. Matches ProcessDispatchHandler's "entry absent" branch, which is the
            // divergence this closes.
            return null;
        }

        return (byte[])raw!;
```

In the `<summary>` of `ReadAsync`, change "Returns <c>null</c> when the key is absent, which the caller treats as a duplicate delivery." to "Returns <c>null</c> when the key is absent, which the caller treats as a duplicate delivery, and an empty array when the key holds no data."

- [ ] **Step 4: Build and run**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.ExecutionRoundTripTests"`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/Orchestrator/Messaging/StepOutcomeHandler.cs src/tests/BaseApi.Tests/Orchestrator/ExecutionRoundTripTests.cs
git commit -m "fix(orchestrator): an empty execution blob is no data, not a duplicate — IsNull on the read, so a processor's no-data branch key still advances its successors (ships before the release-1 processors)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The processor reads an empty input key as no data

**Files:**
- Modify: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs:107-188`
- Test: `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`

**Interfaces:**
- Produces: input table §6.1 — `Guid.Empty` → entry step; `IsNull` → duplicate; empty → run on `[]`, input schema skipped; data → validate.

- [ ] **Step 1: Write the failing tests**

Add to `ProcessDispatchHandlerTests` after `ReturnsWithoutAResultWhenTheEntryIsAlreadyGone`:

```csharp
    [Fact]
    public async Task RunsTheAuthorOnEmptyDataWhenTheInputKeyHoldsNoData()
    {
        // Empty is not absent. The orchestrator hands a no-data successor a real key holding "" —
        // reading it as "already reclaimed" would drop a step that has not run yet, silently.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns(RedisValue.EmptyString);
        var probe = new Probe((d, p) => p.Send(d));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.True(probe.Ran);
        Assert.Empty(probe.SawData!);
        await h.Db.Received(1).KeyDeleteAsync(L2ProjectionKeys.ExecutionData(E), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task SkipsTheInputSchemaWhenTheInputKeyHoldsNoData()
    {
        // No document, nothing to validate: parsing "" against a schema would fail a step that was
        // never wrong, exactly as it would for an entry step.
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns(RedisValue.EmptyString);
        var outcomes = new List<StepOutcome>();
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(outcomes.Add),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((d, p) => p.Send(d));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.True(probe.Ran);
        Assert.DoesNotContain(outcomes, o => o.Result == StepResult.Failed);
        Assert.DoesNotContain(h.Log.Records, r => r.Message.Contains("failed its schema", StringComparison.Ordinal));
    }
```

- [ ] **Step 2: Build and run to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessDispatchHandlerTests"`
Expected: FAIL — both new facts: `probe.Ran` is false.

- [ ] **Step 3: Implement**

In `ProcessDispatchHandler.RunAsync` replace the block from `if (raw.IsNullOrEmpty)` through `data = (byte[])raw!;` (lines 128-179) with:

```csharp
            // IsNull, NOT IsNullOrEmpty: absent and empty are different answers. Redis keeps "" as a
            // value and returns Null only for a missing key. An empty key is a real input that holds
            // no data — a no-data predecessor, or a failed one whose successors run on nothing — and
            // the author runs on it. See §4 of the in-process post design.
            if (raw.IsNull)
            {
                // Read as "an earlier attempt at this dispatch already reclaimed this key", and
                // returning is right for that reading: reporting a failure would overwrite a finished
                // workflow's outcome. The reclaim runs only once the WHOLE author has returned — see
                // the reclaim at the end of RunAsync — so an absent key never means a fan-out was
                // caught mid-flight with some branches sent and others lost; that state cannot arise.
                //
                // A replay of the author no longer forks the run: branch keys are derived from this
                // input key and the execution id (EntryIds.Branch), so a re-run rewrites the same keys
                // with the same bytes. Returning here still saves the re-run itself, which is free for
                // a pure transform and is not for a step with side effects.
                //
                // Every successor has a key of its own — the orchestrator derives one per successor
                // and copies the blob into it — so the absent key is never a sibling's input that
                // someone else consumed. With no TTL on execution blobs, this branch has exactly two
                // readings: reclaimed, or never written.
                _logger.LogInformation("entry absent — treating as a duplicate delivery");
                return;
            }

            data = (byte[])raw!;
```

Replace the schema condition (lines 186-187)

```csharp
        if (!isSource
            && !ProcessorJsonSchemaValidator.TryValidate(identity.InputDefinition, data, out var errors))
```

with

```csharp
        // An empty input is "no data", like an entry step's: there is no document to validate.
        if (!isSource
            && data.Length > 0
            && !ProcessorJsonSchemaValidator.TryValidate(identity.InputDefinition, data, out var errors))
```

and extend the comment above it (lines 182-185) with one sentence: `An input key holding "" skips it for the same reason.`

- [ ] **Step 4: Pack, build, run**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.ProcessDispatchHandlerTests"`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs src/BaseProcessor.Core/nugets
git add -u '*packages.lock.json'
git commit -m "feat(processor): an empty input key is no data, not a duplicate — the author runs on [] with the input schema skipped; only an absent key returns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `BranchFinisher` — the post hop as an awaited call

**Files:**
- Create: `src/BaseProcessor.Core/Processing/IBranchSink.cs`
- Create: `src/BaseProcessor.Core/Processing/OutputSchemaPendingException.cs`
- Create: `src/BaseProcessor.Core/Processing/BranchFinisher.cs`
- Test: `src/tests/BaseApi.Tests/Processor/BranchFinisherTests.cs`

**Interfaces:**
- Produces: `internal interface IBranchSink { Task FinishAsync(ProcessedData branch, CancellationToken ct); }`; `internal sealed class BranchFinisher(IConnectionMultiplexer redis, IQueueSender sender, IProcessorContext context, ILogger<BranchFinisher> logger) : IBranchSink`; `internal sealed class OutputSchemaPendingException : TransientSendException` with ctor `(Guid outputSchemaId)`.
- Contract: `branch.EntryId` is already the derived `E`. Returns after `data:{E}` is written and the outcome is broker-confirmed. A send fault leaves as `TransientSendException`; a store fault leaves raw.

- [ ] **Step 1: Write the failing tests**

`src/tests/BaseApi.Tests/Processor/BranchFinisherTests.cs`:

```csharp
using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class BranchFinisherTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid X = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid E = Guid.Parse("66666666-6666-6666-6666-666666666666");
    private static readonly Guid OutSchema = Guid.Parse("88888888-8888-8888-8888-888888888888");

    private const string NumberSchema =
        """{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""";

    private sealed class Harness
    {
        public InMemoryL2 L2 { get; } = new();
        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();
        public ProcessorContext Context { get; } = new();
        public RecordingLogger<BranchFinisher> Log { get; } = new();
        public List<StepOutcome> Outcomes { get; } = [];

        /// <summary>Whether data:{E} existed at the moment each outcome was sent.</summary>
        public List<bool> KeyPresentAtSend { get; } = [];

        public Harness(string? outputSchema = null)
        {
            Context.SetIdentity(new ProcessorIdentityFound(
                P, null, outputSchema is null ? null : OutSchema, null, "sample", "1.0.0"));
            if (outputSchema is not null)
            {
                Context.SetDefinition(OutSchema, outputSchema);
            }

            Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o =>
                  {
                      Outcomes.Add(o);
                      KeyPresentAtSend.Add(L2.Has(L2ProjectionKeys.ExecutionData(o.EntryId)));
                  }),
                  Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .Returns(Task.CompletedTask);
        }

        public BranchFinisher Build() => new(L2.Multiplexer, Sender, Context, Log);
    }

    private static ProcessedData Branch(string json) =>
        new(C, X, W, S, P, E, Encoding.UTF8.GetBytes(json));

    [Fact]
    public async Task WritesTheBytesUnderTheBranchKeyThenReportsCompleted()
    {
        var h = new Harness();

        await h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None);

        Assert.Equal("""{"number":7}""", h.L2.Value(L2ProjectionKeys.ExecutionData(E)));
        var outcome = Assert.Single(h.Outcomes);
        Assert.Equal(StepResult.Completed, outcome.Result);
        Assert.Equal(E, outcome.EntryId);
        Assert.Equal(X, outcome.ExecutionId);

        // Write, then report: the orchestrator reads the key the outcome names.
        Assert.True(Assert.Single(h.KeyPresentAtSend));
        await h.Sender.Received(1).SendAsync(OrchestratorQueues.Result, MessageTypes.StepOutcome,
            Arg.Any<StepOutcome>(), Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task ANoDataBranchWritesAnEmptyValueUnderItsOwnKey()
    {
        // §4: every key is real; empty means no data. The key buys the branch a unique successor key
        // and a redelivery token, which Guid.Empty could not.
        var h = new Harness(NumberSchema);

        await h.Build().FinishAsync(Branch(""), CancellationToken.None);

        Assert.Equal("", h.L2.Value(L2ProjectionKeys.ExecutionData(E)));
        var outcome = Assert.Single(h.Outcomes);
        Assert.Equal(StepResult.Completed, outcome.Result);
        Assert.Equal(E, outcome.EntryId);
    }

    [Fact]
    public async Task AnOutputThatFailsItsSchemaWritesAnEmptyKeyAndReportsFailedUnderItsOwnKey()
    {
        // Naming the branch's own key gives every failed branch its own successor key. Reporting
        // Guid.Empty, as the queue hop did, made every schema-failed branch of one fire share one
        // recorder key — all but one failure record lost.
        var h = new Harness(NumberSchema);

        await h.Build().FinishAsync(Branch("""{"number":"seven"}"""), CancellationToken.None);

        Assert.Equal("", h.L2.Value(L2ProjectionKeys.ExecutionData(E)));
        var outcome = Assert.Single(h.Outcomes);
        Assert.Equal(StepResult.Failed, outcome.Result);
        Assert.Equal(E, outcome.EntryId);

        var line = Assert.Single(h.Log.Records, r => r.Message.Contains("failed its schema", StringComparison.Ordinal));
        Assert.Contains(OutSchema.ToString("D"), line.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RequeuesWhileTheOutputSchemaHasNotResolved()
    {
        // A non-null schema id with a null definition is "not yet". Validating against null passes by
        // contract, so the branch would go out unvalidated. Requeue: it resolves in seconds.
        var h = new Harness();
        h.Context.SetIdentity(new ProcessorIdentityFound(P, null, OutSchema, null, "sample", "1.0.0"));

        var thrown = await Assert.ThrowsAsync<OutputSchemaPendingException>(
            () => h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None));

        Assert.IsAssignableFrom<TransientSendException>(thrown);
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(E)));
        Assert.Empty(h.Outcomes);
    }

    [Fact]
    public async Task AStoreFaultLeavesRawSoTheGateCanTrip()
    {
        // Wrapped in a send exception, L2FaultClassifier would never see it and the L2 gate would
        // never close. And nothing is reported for a key that was never written.
        var h = new Harness();
        h.L2.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                               Arg.Any<When>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None));

        Assert.Empty(h.Outcomes);
    }

    [Fact]
    public async Task ASendFaultLeavesAsATransientSendException()
    {
        var h = new Harness();
        h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<StepOutcome>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>())
            .ThrowsAsync(new IOException("socket closed"));

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None));

        // The key was written first, so the replay rewrites the same key: converges.
        Assert.True(h.L2.Has(L2ProjectionKeys.ExecutionData(E)));
    }

    [Fact]
    public async Task ScopesTheBranchUnderItsOwnIds()
    {
        var h = new Harness();

        await h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None);

        Assert.Contains(h.Log.Scopes,
            s => s.TryGetValue(ExecutionLogScope.EntryId, out var v) && Equals(v, E.ToString("D")));
    }
}
```

- [ ] **Step 2: Build to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: FAIL — `CS0246: The type or namespace name 'BranchFinisher' could not be found`.

- [ ] **Step 3: Implement**

`src/BaseProcessor.Core/Processing/IBranchSink.cs`:

```csharp
using Messaging.Contracts;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Where <see cref="BaseProcessor.SendToPostAsync"/> hands one finished branch. In production that is
/// <see cref="BranchFinisher"/>, awaited in-process: the branch is in L2 and its outcome is
/// broker-confirmed when the call returns. A seam rather than a concrete type so author tests can
/// capture branches without a store.
/// </summary>
internal interface IBranchSink
{
    Task FinishAsync(ProcessedData branch, CancellationToken ct);
}
```

`src/BaseProcessor.Core/Processing/OutputSchemaPendingException.cs`:

```csharp
using Messaging.Transport;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// The output schema this processor declares has not resolved yet, so a branch cannot be validated.
/// <para>
/// <b>A <see cref="TransientSendException"/> on purpose</b>: that is the type the consumer requeues
/// without tripping the L2 gate. The queue hop parked this case on its own dead-letter queue; inside
/// the dispatch a park would throw the author's work away over a condition that clears in seconds.
/// <see cref="BaseProcessor.SendToPostAsync"/> lets it through unwrapped.
/// </para>
/// </summary>
internal sealed class OutputSchemaPendingException : TransientSendException
{
    public OutputSchemaPendingException(Guid outputSchemaId)
        : base(
            $"Output schema {outputSchemaId:D} has not resolved yet, so the branch cannot be validated",
            new InvalidOperationException("the processor has not reached Healthy"))
    {
    }
}
```

`src/BaseProcessor.Core/Processing/BranchFinisher.cs`:

```csharp
using System.Diagnostics;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Finishes one branch, in-process: validate the output, write it under the branch's own key, report
/// the outcome. What <c>ProcessedDataHandler</c> did on the post queue, minus the queue.
/// <para>
/// <b>Why there is no queue any more.</b> The organisation caps RabbitMQ's message size, and the post
/// queue carried the whole output inside every message. The queue's durability was what let the
/// dispatch reclaim its input and ack right after the send; here the dispatch does not reclaim or ack
/// until this call returns, so the work's completion replaces the durable copy. See
/// <c>docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md</c>.
/// </para>
/// <para>
/// <b>Every branch has a real key.</b> <see cref="ProcessedData.EntryId"/> arrives derived
/// (<see cref="EntryIds.Branch"/>), so a replay of the dispatch rewrites the same key with the same
/// bytes. A branch with no data writes <c>""</c> there; a branch that fails its output schema writes
/// <c>""</c> and reports Failed under that same key, so every failed branch gets a successor key of
/// its own.
/// </para>
/// <para>
/// <b>Faults.</b> A send fault leaves as the <see cref="TransientSendException"/> the sender raised;
/// <see cref="BaseProcessor.SendToPostAsync"/> renames it. A store fault leaves raw, so
/// <c>L2FaultClassifier</c> sees it and the L2 gate closes. Neither is caught here.
/// </para>
/// </summary>
internal sealed class BranchFinisher : IBranchSink
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IQueueSender _sender;
    private readonly IProcessorContext _context;
    private readonly ILogger<BranchFinisher> _logger;

    public BranchFinisher(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        ILogger<BranchFinisher> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender  = sender ?? throw new ArgumentNullException(nameof(sender));
        _context = context ?? throw new ArgumentNullException(nameof(context));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task FinishAsync(ProcessedData branch, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(branch);

        // The branch's own ids, nested inside the dispatch's scope: its execution and entry ids are
        // not the dispatch's, and these lines are about the branch.
        using (_logger.BeginScope(ExecutionLogScope.BuildScope(branch)))
        {
            await RunAsync(branch, ct).ConfigureAwait(false);
        }
    }

    private async Task RunAsync(ProcessedData b, CancellationToken ct)
    {
        _logger.LogDebug("validating and persisting a branch");
        var started = Stopwatch.GetTimestamp();

        // Resolved before the author ran — ProcessDispatchHandler refuses a dispatch otherwise — so
        // reaching this with no identity is a wiring fault, not a race.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "A branch was sent before identity resolved — the dispatch that sent it must not have run.");

        if (b.Data.Length > 0)
        {
            // "Not applicable" vs "not yet", as on the input side. A non-null id whose definition is
            // still null would validate against nothing and pass by contract.
            if (identity.OutputSchemaId is { } outputSchemaId && identity.OutputDefinition is null)
            {
                throw new OutputSchemaPendingException(outputSchemaId);
            }

            if (!ProcessorJsonSchemaValidator.TryValidate(identity.OutputDefinition, b.Data, out var errors))
            {
                // The template is unchanged from the queue hop — Kibana and the live tests match it —
                // and the schema id stays on the line: the edge is a shared row that gets re-pointed,
                // so the errors alone cannot say whether the document or the contract moved.
                using (_logger.BeginScope(OutcomeLogScope.BuildScope(StepResult.Failed)))
                {
                    _logger.LogWarning(
                        "output failed its schema {OutputSchemaId} — reported failed: {SchemaErrors}",
                        identity.OutputSchemaId, string.Join("; ", errors));
                }

                // "" under the branch's own key, then Failed naming it. The rejected bytes are never
                // written: a failed step's output is not data (spec D6).
                await WriteAsync(b.EntryId, RedisValue.EmptyString).ConfigureAwait(false);
                await SendAsync(Outcome(b, StepResult.Failed), ct).ConfigureAwait(false);
                return;
            }
        }

        // Write, then report: the outcome names this key and the orchestrator reads it.
        await WriteAsync(b.EntryId, b.Data.Length == 0 ? RedisValue.EmptyString : (RedisValue)b.Data)
            .ConfigureAwait(false);
        await SendAsync(Outcome(b, StepResult.Completed), ct).ConfigureAwait(false);

        using (_logger.BeginScope(OutcomeLogScope.BuildScope(StepResult.Completed)))
        {
            _logger.LogInformation(
                "branch completed in {ElapsedMs}ms", (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
    }

    /// <summary>
    /// All five arguments, to pin the (key, value, expiry, When, flags) overload over the keepTtl one.
    /// No expiry: this blob is the successor's input, and an expiry would delete it mid-run.
    /// </summary>
    private Task<bool> WriteAsync(Guid entryId, RedisValue value)
    {
        _logger.LogDebug("writing the branch output to L2");

        return _redis.GetDatabase().StringSetAsync(
            L2ProjectionKeys.ExecutionData(entryId), value, null, When.Always, CommandFlags.None);
    }

    private static StepOutcome Outcome(ProcessedData b, StepResult result) =>
        new(b.CorrelationId, b.ExecutionId, b.WorkflowId, b.StepId, b.ProcessorId, b.EntryId, result);

    private Task SendAsync(StepOutcome outcome, CancellationToken ct)
        => _sender.SendTransientAsync(OrchestratorQueues.Result, MessageTypes.StepOutcome, outcome, ct);
}
```

- [ ] **Step 4: Pack, build, run**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Processor.BranchFinisherTests"`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseProcessor.Core/Processing/IBranchSink.cs src/BaseProcessor.Core/Processing/OutputSchemaPendingException.cs src/BaseProcessor.Core/Processing/BranchFinisher.cs src/tests/BaseApi.Tests/Processor/BranchFinisherTests.cs src/BaseProcessor.Core/nugets
git add -u '*packages.lock.json'
git commit -m "feat(processor): BranchFinisher — the post hop as an awaited call: validate, write data:{E} (\"\" for no data or a failed schema), report the outcome under E; an unresolved output schema requeues

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `SendToPostAsync` derives `E` and finishes in-process

**Files:**
- Modify: `src/BaseProcessor.Core/Processing/DispatchState.cs` (whole class)
- Modify: `src/BaseProcessor.Core/Processing/BaseProcessor.cs:107-217`
- Modify: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs:24-44, 215-219`
- Modify: `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs:253-256`
- Create: `src/tests/BaseApi.Tests/Support/SenderBranchSink.cs`, `src/tests/BaseApi.Tests/Support/TestDispatch.cs`
- Modify (mechanical): every `new DispatchState(` in `src/tests/BaseApi.Tests` (35 sites, listed in Step 6)
- Modify: `src/tests/BaseApi.Tests/Processor/BaseProcessorSeamTests.cs`, `ProcessDispatchHandlerTests.cs`, `ProcessorHostWiringTests.cs`

**Interfaces:**
- Consumes: `EntryIds.Branch` (Task 1), `IBranchSink` / `BranchFinisher` / `OutputSchemaPendingException` (Task 5).
- Produces: `DispatchState(IBranchSink sink, Guid inputEntryId, Guid correlationId, Guid workflowId, Guid stepId, Guid processorId)` with properties `Sink`, `InputEntryId`; `ProcessDispatchHandler(IConnectionMultiplexer, IQueueSender, IProcessorContext, BaseProcessor, IBranchSink, ILogger<ProcessDispatchHandler>)`; test helpers `TestDispatch.State(IQueueSender sender, Guid c, Guid w, Guid s, Guid p, Guid inputEntryId = default)` and `SenderBranchSink(IQueueSender)`.

- [ ] **Step 1: Add the test seam**

`src/tests/BaseApi.Tests/Support/SenderBranchSink.cs`:

```csharp
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;

namespace BaseApi.Tests.Support;

/// <summary>
/// A branch sink that hands each finished branch to a substituted sender, so an author test keeps
/// capturing <see cref="ProcessedData"/> with <c>Arg.Do&lt;ProcessedData&gt;</c> exactly as it did
/// when branches went to the post queue. Through <c>SendTransientAsync</c>, so a substituted fault is
/// classified the same way a real send fault is.
/// <para>
/// The queue and type names are literals on purpose: no queue exists, and nothing must look up a
/// production constant that Part 3 of the in-process post plan deletes.
/// </para>
/// </summary>
internal sealed class SenderBranchSink(IQueueSender sender) : IBranchSink
{
    public Task FinishAsync(ProcessedData branch, CancellationToken ct)
        => sender.SendTransientAsync("test-branch-sink", "processed-data", branch, ct);
}
```

`src/tests/BaseApi.Tests/Support/TestDispatch.cs`:

```csharp
using BaseProcessor.Core.Processing;
using Messaging.Transport;

namespace BaseApi.Tests.Support;

/// <summary>The dispatch state an author test opens: branches go to <paramref name="sender"/>.</summary>
internal static class TestDispatch
{
    public static DispatchState State(
        IQueueSender sender, Guid correlationId, Guid workflowId, Guid stepId, Guid processorId,
        Guid inputEntryId = default)
        => new(new SenderBranchSink(sender), inputEntryId, correlationId, workflowId, stepId, processorId);
}
```

- [ ] **Step 2: Rewrite the seam tests to the new contract (failing)**

In `src/tests/BaseApi.Tests/Processor/BaseProcessorSeamTests.cs`:

1. Add `using BaseApi.Tests.Support;`.
2. Replace every `new DispatchState(sender, C, W, S, P)` with `TestDispatch.State(sender, C, W, S, P)` and `new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P)` with `TestDispatch.State(Substitute.For<IQueueSender>(), C, W, S, P)`.
3. Replace the assertion block at the end of `StampsTheDispatchIdsOntoEveryBranch` (lines 85-87) with:

```csharp
        // The entry id is derived, never random: no input key here, so it is the entry-step formula.
        Assert.Equal(EntryIds.Branch(Guid.Empty, W, S, E), sent.EntryId);
```

4. Replace `GivesEachBranchOfAFanOutItsOwnEntryId` (lines 108-126) with:

```csharp
    [Fact]
    public async Task GivesEachBranchOfAFanOutTheKeyItsExecutionIdDerives()
    {
        // The author's contract (§5.1): every output carries a distinct execution id, and the key
        // follows it. Distinct ids, distinct keys.
        var ids = new List<Guid>();
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => ids.Add(p.EntryId)),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var x1 = Guid.Parse("a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1");
        var x2 = Guid.Parse("a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2");
        var input = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var processor = new Probe(async (_, _, _, self) =>
        {
            await self.Send(Encoding.UTF8.GetBytes("{}"), x1);
            await self.Send(Encoding.UTF8.GetBytes("{}"), x2);
        });
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P, input));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal([EntryIds.Branch(input, W, S, x1), EntryIds.Branch(input, W, S, x2)], ids);
    }

    [Fact]
    public async Task TwoOutputsUnderOneExecutionIdShareOneKey()
    {
        // The other half of the contract, pinned so it stays a documented cost rather than a
        // surprise: an author that reuses one execution id for two outputs writes both to one key,
        // and the second overwrites the first.
        var ids = new List<Guid>();
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => ids.Add(p.EntryId)),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var processor = new Probe(async (_, _, _, self) =>
        {
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
        });
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Single(ids.Distinct());
    }
```

5. Replace `ReplayingADispatchProducesFreshBranchIds` (lines 128-158) with:

```csharp
    [Fact]
    public async Task ReplayingADispatchRewritesTheSameBranchKey()
    {
        // INVERTED from "replaying produces fresh ids". Keys are derived from the input key and the
        // execution id now, so a replay of the same dispatch names the same keys: L2 converges and
        // the successor subtree is absorbed rather than forked.
        var input = Guid.Parse("99999999-9999-9999-9999-999999999999");

        async Task<List<Guid>> RunOnce()
        {
            var ids = new List<Guid>();
            var sender = Substitute.For<IQueueSender>();
            await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(),
                                   Arg.Do<ProcessedData>(p => ids.Add(p.EntryId)),
                                   Arg.Any<CancellationToken>(), Arg.Any<string?>());
            var processor = new Probe((_, _, x, self) => self.Send(Encoding.UTF8.GetBytes("{}"), x));
            processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P, input));
            await processor.ExecuteAsync([], "", E, CancellationToken.None);
            return ids;
        }

        Assert.Equal(await RunOnce(), await RunOnce());
    }

    [Fact]
    public async Task RefusesAnEmptyExecutionId()
    {
        // Every output sent under Guid.Empty would share one key. An author error, so it fails loudly
        // inside the dispatch and the framework reports the step Failed.
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), Guid.Empty));
        processor.BeginDispatch(TestDispatch.State(Substitute.For<IQueueSender>(), C, W, S, P));

        var thrown = await Assert.ThrowsAsync<ArgumentException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Contains("execution id", thrown.Message, StringComparison.Ordinal);
    }
```

6. Delete `SendsToTheProcessorsOwnPostQueueUnderTheProcessedDataType` (lines 160-176) — there is no post queue send any more; the in-process path is pinned in `ProcessDispatchHandlerTests` below.
7. In `ReportsWhichBranchWasLostWhenASendFails` replace `Assert.NotEqual(Guid.Empty, thrown.EntryId);` with `Assert.Equal(EntryIds.Branch(Guid.Empty, W, S, E), thrown.EntryId);`.
8. Add after `LetsADeterministicSendFaultPropagateUnwrappedSoTheDispatchParks`:

```csharp
    [Fact]
    public async Task LetsAnUnresolvedOutputSchemaThroughUnwrapped()
    {
        // OutputSchemaPendingException is already the requeue type; renaming it PostSendException
        // would claim a send failed when none was attempted.
        var sink = Substitute.For<IBranchSink>();
        sink.FinishAsync(Arg.Any<ProcessedData>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new OutputSchemaPendingException(Guid.NewGuid()));
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(new DispatchState(sink, Guid.Empty, C, W, S, P));

        await Assert.ThrowsAsync<OutputSchemaPendingException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));
    }
```

- [ ] **Step 3: Rewrite the dispatch-handler tests that captured branches on the wire (failing)**

In `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`:

1. Change the harness so the real finisher runs on the same substitutes:

```csharp
        public RecordingLogger<BranchFinisher> FinisherLog { get; } = new();

        public ProcessDispatchHandler Build(BaseProcessor.Core.Processing.BaseProcessor processor)
            => new(Redis, Sender, Context, processor, new BranchFinisher(Redis, Sender, Context, FinisherLog), Log);
```

2. Replace `SendsANoDataBranchUnderAnEmptyEntryId` and `TreatsANullSendAsNoDataAndPutsAnEmptyArrayOnTheWire` (lines 177-213) with:

```csharp
    [Fact]
    public async Task ANoDataBranchWritesAnEmptyKeyAndReportsCompletedUnderIt()
    {
        // §4: a no-data branch has a real key holding "". The key is derived from the input key and
        // the execution id, like every branch.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, p) => p.Send([]));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        var key = EntryIds.Branch(E, W, S, E);
        await h.Db.Received(1).StringSetAsync(
            L2ProjectionKeys.ExecutionData(key), RedisValue.EmptyString, null, When.Always, CommandFlags.None);
        Assert.Equal(StepResult.Completed, sent!.Result);
        Assert.Equal(key, sent.EntryId);
    }

    [Fact]
    public async Task TreatsANullSendAsNoData()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, p) => p.SendNullable(null));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        await h.Db.Received(1).StringSetAsync(
            L2ProjectionKeys.ExecutionData(EntryIds.Branch(E, W, S, E)), RedisValue.EmptyString,
            null, When.Always, CommandFlags.None);
    }

    [Fact]
    public async Task FinishesTheBranchBeforeReclaimingTheInput()
    {
        // The in-process hop replaces the durable post queue only if the input outlives it: the
        // input is deleted after the branch is in L2 and its outcome confirmed, never before.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var order = new List<string>();
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(_ => order.Add("outcome")),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        h.Db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(_ => { order.Add("reclaim"); return Task.FromResult(true); });
        var probe = new Probe((d, p) => p.Send(d));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.Equal(["outcome", "reclaim"], order);
    }
```

3. In `LetsAFailedBranchSendEscapeRatherThanReportingTheStepFailed` (line 605) change the faulted call from `Arg.Any<ProcessedData>()` to `Arg.Any<StepOutcome>()`.
4. Replace `CarriesTheDispatchsProcessorIdOntoEveryBranch` (lines 643-664) with:

```csharp
    [Fact]
    public async Task CarriesTheDispatchsProcessorIdOntoEveryBranchsOutcome()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, self) => self.Send(Encoding.UTF8.GetBytes("{}")));

        var foreign = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd");
        await h.Build(probe).HandleAsync(Body(Dispatch(E) with { ProcessorId = foreign }), CancellationToken.None);

        Assert.Equal(foreign, sent!.ProcessorId);
        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }
```

- [ ] **Step 4: Migrate the author tests mechanically**

Run from the repo root (Git Bash):

```bash
cd src/tests/BaseApi.Tests
grep -rl "new DispatchState(" --include=*.cs . | xargs sed -i -E \
  -e 's/new DispatchState\(Substitute\.For<IQueueSender>\(\), C, W, S, P\)/TestDispatch.State(Substitute.For<IQueueSender>(), C, W, S, P)/g' \
  -e 's/new DispatchState\(sender, C, W, S, P\)/TestDispatch.State(sender, C, W, S, P)/g'
grep -rn "new DispatchState(" --include=*.cs .
cd ../../..
```

Expected: the final `grep` prints only the one deliberate site in `BaseProcessorSeamTests.LetsAnUnresolvedOutputSchemaThroughUnwrapped`. Then add `using BaseApi.Tests.Support;` to every file the `sed` touched that lacks it:

```bash
cd src/tests/BaseApi.Tests
for f in $(grep -rl "TestDispatch.State(" --include=*.cs .); do
  grep -q "^using BaseApi.Tests.Support;" "$f" || sed -i '1i using BaseApi.Tests.Support;' "$f"
done
cd ../../..
```

Files touched (from the survey): `Analyst/AnalystOpensItsOwnLineageTests.cs`, `ArchiveCollapser/ProcessorArchiveCollapserTests.cs`, `ArchiveExpander/{ArchiveExpanderDepthTests,ArchiveExpanderDocumentTests,ArchiveExpanderEnvelopeTests,GzipExtractorTests,RarExtractorTests,TarExtractorTests,ZipExtractorTests}.cs`, `FileFetcher/{FileFetcherEnvelopeTests,FileFetcherGuardTests,FileFetcherLocatorTests}.cs`, `FilePersister/FilePersisterTests.cs`, `KafkaExporter/KafkaExporterTests.cs`, `KafkaImporter/{KafkaImporterCacheTests,KafkaImporterLoopTests}.cs`, `OutcomeRecorder/ProcessorOutcomeRecorderTests.cs`, `SKNormalizer/ProcessorSKNormalizerTests.cs`, `Sample/SampleProcessorTests.cs`, `Processor/BaseProcessorSeamTests.cs`, and `EnvelopeContractTests.cs` if it builds a state.

- [ ] **Step 5: Wiring test (failing)**

Add to `src/tests/BaseApi.Tests/Processor/ProcessorHostWiringTests.cs`:

```csharp
    [Fact]
    public async Task TheBranchSinkIsOneFinisherSharedByEveryDispatch()
    {
        // The post hop is an awaited call now. Its dependencies are all singletons, so one instance
        // serves every scope — and the dispatch handler must resolve with it.
        await using var sp = BuildWithIdentity();
        await using var scope = sp.CreateAsyncScope();

        var sink = sp.GetRequiredService<BaseProcessor.Core.Processing.IBranchSink>();
        Assert.IsType<BaseProcessor.Core.Processing.BranchFinisher>(sink);
        Assert.Same(sink, scope.ServiceProvider.GetRequiredService<BaseProcessor.Core.Processing.IBranchSink>());
        Assert.Contains(scope.ServiceProvider.GetServices<IQueueMessageHandler>(),
                        h => h is BaseProcessor.Core.Processing.ProcessDispatchHandler);
    }
```

(Add `using Microsoft.Extensions.DependencyInjection;` and `using Messaging.Transport;` if the file lacks them.)

- [ ] **Step 6: Build to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: FAIL — `DispatchState` has no 6-argument constructor; `ProcessDispatchHandler` has no 6-argument constructor.

- [ ] **Step 7: Implement `DispatchState`**

Replace the class in `src/BaseProcessor.Core/Processing/DispatchState.cs`:

```csharp
namespace BaseProcessor.Core.Processing;

/// <summary>
/// Everything the seam helpers need about the dispatch currently being handled: where a finished
/// branch goes, the input key branch ids are derived from, and the four ids every branch is stamped
/// with.
/// <para>
/// <b>The dispatch's own entry id is back, and it is load-bearing again.</b> A branch's key is
/// <see cref="Messaging.Contracts.EntryIds.Branch"/> of this input key and the branch's execution id,
/// so a replayed dispatch derives the same keys and L2 converges. <see cref="Guid.Empty"/> means an
/// entry step dispatched by the fire, which has no input key; the formula then falls back to the
/// workflow and step ids. The reclaim still takes the key straight off the <c>ProcessDispatch</c> in
/// <see cref="ProcessDispatchHandler"/>.
/// </para>
/// <para>
/// <b>No sequence counters.</b> The execution id separates one branch from the next — the author's
/// contract is a distinct execution id per output — so a position counter would add nothing but a
/// dependency on call order.
/// </para>
/// </summary>
internal sealed class DispatchState(
    IBranchSink sink,
    Guid inputEntryId,
    Guid correlationId,
    Guid workflowId,
    Guid stepId,
    Guid processorId)
{
    private bool _branchSent;

    public IBranchSink Sink { get; } = sink;
    public Guid InputEntryId { get; } = inputEntryId;
    public Guid CorrelationId { get; } = correlationId;
    public Guid WorkflowId { get; } = workflowId;
    public Guid StepId { get; } = stepId;
    public Guid ProcessorId { get; } = processorId;

    // BranchSent and MarkBranchSent: keep the existing members and their doc comments unchanged,
    // except the last summary, which becomes:
    // "Records that a branch was finished. Called only after the sink returns."
}
```

Keep the existing `BranchSent` / `MarkBranchSent` members and their comments; only edit `MarkBranchSent`'s summary as noted. Remove `using Messaging.Transport;` if nothing else in the file uses it.

- [ ] **Step 8: Implement `SendToPostAsync` and the doc comments**

In `src/BaseProcessor.Core/Processing/BaseProcessor.cs`, replace the `SendToPostAsync` doc comment and body (lines 107-199) with:

```csharp
    /// <summary>
    /// Hands one branch of output on, and returns once it is in L2 and its outcome is confirmed.
    /// <para>
    /// The framework stamps every id: the dispatch's correlation, workflow, step and processor ids,
    /// plus an entry id naming the L2 key this branch's output is written to. The author supplies the
    /// bytes and the execution id and nothing else.
    /// </para>
    /// <para>
    /// <b>The entry id is derived, not random</b> (<see cref="EntryIds.Branch"/>): from the dispatch's
    /// input key and <paramref name="executionId"/>, or for an entry step from the workflow, the step
    /// and <paramref name="executionId"/>. A redelivered dispatch replays this call, names the same
    /// key, rewrites the same bytes and reports the same outcome — L2 converges.
    /// </para>
    /// <para>
    /// <b>The author's contract: every output carries a distinct, non-empty execution id.</b> A
    /// one-output transform passes on the execution id it received. A splitter or an entry step opens
    /// one per output. Two outputs under one id share one key and the second overwrites the first;
    /// <see cref="Guid.Empty"/> is refused outright.
    /// </para>
    /// <para>
    /// <b>An id minted in-process does not converge.</b> <see cref="NewExecutionId"/> is random, so a
    /// replay of the same input opens a different lineage under a different key. A crash between this
    /// call's write and its outcome then leaves the first key with no outcome naming it — an orphan
    /// nothing ever deletes — and a replay after the outcome runs the successor subtree twice. An author
    /// that wants convergence derives the id from what it received: the input's lineage, a record
    /// header, a stable business key. See limit 4 of the in-process post design.
    /// </para>
    /// <para>
    /// <b>No data is a branch too.</b> <paramref name="processedData"/> null or empty writes <c>""</c>
    /// under the branch's key, skips the output schema and reports Completed. It still counts as
    /// having sent a branch. An author that intends to pass data on must check that it is non-empty.
    /// </para>
    /// <para>
    /// <b>Never catch <see cref="PostSendException"/>.</b> It must propagate: the framework redelivers
    /// the dispatch and replays the author, which is a duplicate. Swallowing it, or rethrowing it as
    /// <see cref="FailedException"/>, reports a success as a failure. This system always takes the
    /// duplicate.
    /// </para>
    /// </summary>
    protected async Task SendToPostAsync(byte[]? processedData, Guid executionId, CancellationToken ct)
    {
        // Every output under Guid.Empty would derive one shared key. An author error, raised inside
        // the dispatch so the framework reports the step Failed and the log names the cause.
        if (executionId == Guid.Empty)
        {
            throw new ArgumentException(
                "SendToPostAsync needs a non-empty execution id: pass on the one the dispatch carries, "
                + "or open one per output (NewExecutionId, a record header, a business key).",
                nameof(executionId));
        }

        // NO DATA IS A LEGAL BRANCH (spec D4). Null and empty are the same thing.
        var data = processedData ?? [];

        var state = Current;
        var entryId = EntryIds.Branch(state.InputEntryId, state.WorkflowId, state.StepId, executionId);

        var branch = new ProcessedData(
            state.CorrelationId, executionId, state.WorkflowId, state.StepId, state.ProcessorId,
            entryId, data);

        try
        {
            // AWAITED, IN-PROCESS. The post queue carried the whole output in a message, which the
            // organisation's message-size cap no longer allows. The dispatch reclaims its input and
            // acks only after the author returns, so this call returning — branch in L2, outcome
            // confirmed — replaces the durable copy the queue used to hold.
            await state.Sink.FinishAsync(branch, ct).ConfigureAwait(false);

            // AFTER the call returns, never before it. The flag means "this branch's outcome is on its
            // way", which is the only thing that makes the orchestrator advance — a call that threw
            // must not mark one, or a dispatch whose every branch failed would look, to the check in
            // ProcessDispatchHandler, exactly like one that worked.
            state.MarkBranchSent();
        }
        catch (TransientSendException ex) when (ex is not OutputSchemaPendingException)
        {
            // ONLY the already-classified send fault is renamed. Naming it lets an author fanning out
            // see which branch was lost, and it stays a TransientSendException, so the consumer still
            // returns the dispatch to the queue. An unresolved output schema is already the requeue
            // type and is not a send failure. A store fault is not caught at all: it must reach
            // L2FaultClassifier raw, or the L2 gate would never close.
            throw new PostSendException(entryId, executionId, ex);
        }
    }

    /// <summary>
    /// A fresh, random execution id for a branch.
    /// <para>
    /// <b>It does not survive a replay.</b> A redelivered dispatch gets a different id, so its branch
    /// gets a different key: a crash between the branch's write and its outcome orphans the first key
    /// for good (no TTL, no sweeper), and a replay after the outcome runs the successor subtree twice.
    /// Use it only where that is acceptable; an author that wants a replay to converge derives the id
    /// from what it received instead. See <see cref="SendToPostAsync"/>.
    /// </para>
    /// </summary>
```

(Keep `NewExecutionId`'s body unchanged.) Add `using Messaging.Contracts;` at the top if missing (it is present today).

- [ ] **Step 9: Wire the handler and the container**

In `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs`:

```csharp
    private readonly IBranchSink _sink;

    public ProcessDispatchHandler(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        BaseProcessor processor,
        IBranchSink sink,
        ILogger<ProcessDispatchHandler> logger)
    {
        _redis     = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender    = sender ?? throw new ArgumentNullException(nameof(sender));
        _context   = context ?? throw new ArgumentNullException(nameof(context));
        _processor = processor ?? throw new ArgumentNullException(nameof(processor));
        _sink      = sink ?? throw new ArgumentNullException(nameof(sink));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }
```

and the state construction (lines 218-219):

```csharp
        var state = new DispatchState(
            _sink, d.EntryId, d.CorrelationId, d.WorkflowId, d.StepId, d.ProcessorId);
```

In `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`, after line 256 (`AddScoped<IQueueMessageHandler, ProcessedDataHandler>()`):

```csharp
        // The post hop as an awaited call (BranchFinisher). A singleton: its dependencies are all
        // singletons and it holds no per-dispatch state. ProcessedDataHandler and the post queue's
        // consumer below stay for release 1 ONLY, to drain branches already queued by the previous
        // processor build; Part 3 of the in-process post plan removes them once the queue reads zero.
        services.TryAddSingleton<BranchFinisher>();
        services.TryAddSingleton<IBranchSink>(sp => sp.GetRequiredService<BranchFinisher>());
```

and change the comment above `AddGatedQueue(ProcessorQueues.Post(processorId))` to begin: `// DRAIN-ONLY since the in-process post hop: nothing sends here any more.` (keep the rest).

- [ ] **Step 10: Pack, build, run the whole suite**

Run: `bash scripts/pack-all.sh && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: 0 failed, every skip under `Live/`. If an author test fails with `ArgumentException` "needs a non-empty execution id", that test called a transform with `Guid.Empty` and expected a send: pass `E` (the test's execution-id constant) instead — the transform receives a real lineage in production.

- [ ] **Step 11: Commit**

```bash
git add src/BaseProcessor.Core src/tests/BaseApi.Tests
git add -u '*packages.lock.json'
git status --short   # confirm nothing outside these paths is staged
git commit -m "feat(processor): SendToPostAsync derives E (EntryIds.Branch) and finishes the branch in-process — no ProcessedData on the post queue; a replay rewrites the same key; Guid.Empty execution ids are refused

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: KafkaImporter takes its execution id from the record header

**Files:**
- Modify: `src/Processor.KafkaImporter/Kafka/KafkaRecord.cs:31`
- Modify: `src/Processor.KafkaImporter/Kafka/KafkaRecordConsumer.cs:122`
- Modify: `src/Processor.KafkaImporter/KafkaImporterProcessor.cs:25-28, 36-41, 107-229`
- Modify: `src/tests/BaseApi.Tests/KafkaImporter/FakeRecordConsumer.cs:47-71`
- Test: `src/tests/BaseApi.Tests/KafkaImporter/KafkaImporterLoopTests.cs`

**Interfaces:**
- Produces: `KafkaRecord(byte[]? Value, string Offset, string? ExecutionId = null)` with `public const string ExecutionIdHeader = "execution-id"`; fake: `WithRecords(...)` stamps a distinct valid header per record, `WithRecord(string value, string? executionId)` sets it explicitly.

- [ ] **Step 1: Give the fake its headers**

In `FakeRecordConsumer.cs` replace the record-queueing members (lines 47-71) with:

```csharp
    /// <summary>
    /// The execution id the fake stamps on the record at <paramref name="position"/>: distinct per
    /// record and valid, as the feeds' producer contract requires.
    /// </summary>
    public static string IdAt(int position) => $"00000000-0000-0000-0000-{position + 1:D12}";

    /// <summary>Queues records whose values are the UTF-8 encoding of these strings.</summary>
    public FakeRecordConsumer WithRecords(params string[] values)
        => WithRecords(values.Select(Encoding.UTF8.GetBytes).ToArray());

    /// <summary>
    /// Queues records with exactly these bytes, each carrying its own valid <c>execution-id</c>. The
    /// overload exists so a test can queue a value that is not valid UTF-8 and prove the loop hands it
    /// through untouched — the one fact the string-based overload above cannot express.
    /// </summary>
    public FakeRecordConsumer WithRecords(params byte[][] values)
    {
        foreach (var value in values)
        {
            var position = _records.Count;
            _records.Enqueue(new KafkaRecord(value, $"records [0] @{position}", IdAt(position)));
        }

        return this;
    }

    /// <summary>One record with exactly this header value — null for a record with no header.</summary>
    public FakeRecordConsumer WithRecord(string value, string? executionId)
    {
        _records.Enqueue(new KafkaRecord(
            Encoding.UTF8.GetBytes(value), $"records [0] @{_records.Count}", executionId));
        return this;
    }

    /// <summary>A record whose value is null, which is how Confluent hands over a tombstone.</summary>
    public FakeRecordConsumer WithTombstone()
    {
        _records.Enqueue(new KafkaRecord(null, $"records [0] @{_records.Count}"));
        return this;
    }
```

- [ ] **Step 2: Write the failing tests**

In `KafkaImporterLoopTests.cs`, replace `IgnoresAnInboundExecutionIdAndMintsPerRecord` (lines 215-235) with:

```csharp
    /// <summary>
    /// The record's header is the lineage (§7): a producer contract, and what makes a re-read record
    /// derive the same key instead of opening a second lineage. The inbound id is still ignored.
    /// </summary>
    [Fact]
    public async Task UsesEachRecordsExecutionIdHeaderAsItsLineage()
    {
        var inbound = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var consumer = new FakeRecordConsumer().WithRecords("value-a", "value-b");
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync([], Payload(2), inbound, CancellationToken.None);

        Assert.Equal(
            [Guid.Parse(FakeRecordConsumer.IdAt(0)), Guid.Parse(FakeRecordConsumer.IdAt(1))],
            sends.Select(s => s.ExecutionId).ToArray());
    }

    [Fact]
    public async Task AReReadRecordDerivesTheSameBranchKey()
    {
        // The point of the header: a record read again after a commit fault, by a replay or a later
        // fire, names the same key and is absorbed, rather than forking a second lineage.
        async Task<Guid> ReadOnce()
        {
            var consumer = new FakeRecordConsumer().WithRecords("value-a");
            var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));
            return (await Run(processor, sender, messageCount: 1)).Single().EntryId;
        }

        Assert.Equal(await ReadOnce(), await ReadOnce());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("not-a-guid")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    public async Task RefusesARecordWithoutAValidExecutionIdCommittingItAndFailingTheDispatch(string? header)
    {
        // The producer's contract with the importer (§7, limit 5). Commit FIRST, or the record is
        // re-read and refused on every fire — a poison record that stops the partition.
        var consumer = new FakeRecordConsumer().WithRecord("value-a", header);
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));

        Assert.Empty(sends);
        Assert.Equal(["value-a"], consumer.Committed);
        Assert.Contains("execution-id", failed.Message, StringComparison.Ordinal);
        Assert.Contains("stopped because Refused", Summary(log));
    }

    [Fact]
    public async Task ARefusedRecordFailsTheDispatchEvenAfterEarlierRecordsWereSent()
    {
        // The records before it were sent and committed and carry on; the dispatch still reports the
        // refusal, so the recorder on the PreviousFailed edge records it. The rest wait for the next fire.
        var consumer = new FakeRecordConsumer()
            .WithRecords("value-a")
            .WithRecord("value-b", null)
            .WithRecords("value-c");
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));

        Assert.Equal(["value-a"], sends.Select(ValueIn).ToArray());
        Assert.Equal(["value-a", "value-b"], consumer.Committed);
    }

    [Fact]
    public async Task ARefusedRecordWhoseCommitFaultsIsStillRefused()
    {
        // A commit fault before the throw only means the next fire refuses it again.
        var consumer = new FakeRecordConsumer { CommitThrowsOnCall = 1 }.WithRecord("value-a", null);
        var (processor, _, log) = Build(new FakeRecordConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));

        Assert.Empty(consumer.Committed);
        Assert.Contains("stopped because Faulted", Summary(log));
    }
```

- [ ] **Step 3: Build and run to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q`
Expected: FAIL — `KafkaRecord` has no 3-argument constructor.

- [ ] **Step 4: Implement the record and the adapter**

`KafkaRecord.cs` line 31 becomes (and add a `<para>` to the summary: "<b><paramref name="ExecutionId"/> is the record's <c>execution-id</c> header</b>, decoded as UTF-8 text, or null when the record carries none. Text rather than a <c>Guid</c> so the importer, not the adapter, decides what an invalid one means."):

```csharp
public sealed record KafkaRecord(byte[]? Value, string Offset, string? ExecutionId = null)
{
    /// <summary>The header a producer stamps the record's lineage in (§7 of the in-process post design).</summary>
    public const string ExecutionIdHeader = "execution-id";
}
```

`KafkaRecordConsumer.cs` line 122 becomes:

```csharp
        _lastConsumed = result;

        // The lineage rides a header, never the value: the value is forwarded byte for byte and its
        // schema refuses any key but filePath.
        var executionId = result.Message.Headers is { } headers
                          && headers.TryGetLastBytes(KafkaRecord.ExecutionIdHeader, out var header)
            ? Encoding.UTF8.GetString(header)
            : null;

        return new KafkaRecord(result.Message.Value, result.TopicPartitionOffset.ToString(), executionId);
```

(add `using System.Text;` if missing).

- [ ] **Step 5: Implement the importer**

In `KafkaImporterProcessor.cs`:

1. Replace the class-summary paragraph "**The input execution id is ignored**…" (lines 25-28) with:

```csharp
/// <para>
/// <b>Each record's lineage is its <c>execution-id</c> header</b>, a contract between the producer and
/// this processor (§7 of the in-process post design): a record re-read after a commit fault derives
/// the same key and is absorbed instead of forking. A record without a valid one is committed, not
/// imported, and the dispatch reports Failed. The input execution id is ignored.
/// </para>
```

2. Add `Refused` to `StopReason` (after `Faulted`), with the comment `// A record carried no valid execution-id header.`
3. Add `string? refused = null;` beside `KafkaException? fault = null;`.
4. Replace `var lineage = NewExecutionId();` (line 165) with:

```csharp
                // THE PRODUCER'S CONTRACT. Missing, not a GUID, or empty: refuse the record. Commit it
                // FIRST, or it is re-read and refused on every fire — a poison record that stops the
                // partition. Nothing is sent for it, so nothing is written to L2.
                if (!Guid.TryParse(record.ExecutionId, out var lineage) || lineage == Guid.Empty)
                {
                    refused = record.Offset;
                    reason = StopReason.Refused;

                    try
                    {
                        consumer.Commit(record);
                    }
                    catch (KafkaException ex)
                    {
                        logger.LogWarning(ex,
                            "committing a refused record from {Source} faulted after {Imported} item(s); "
                            + "it will be read and refused again",
                            config.Topic, imported);

                        fault = ex;
                        reason = StopReason.Faulted;
                    }

                    logger.LogWarning(
                        "refused the record at {Origin}: it carries no valid {Header} header", record.Offset,
                        KafkaRecord.ExecutionIdHeader);
                    break;
                }
```

5. Before `if (sent > 0)` (line 215) insert:

```csharp
        // Even after earlier records were sent: they carry on, and the refusal is reported so the
        // PreviousFailed edge records it.
        if (refused is not null)
        {
            throw new FailedException(
                $"the record at {refused} carries no valid {KafkaRecord.ExecutionIdHeader} header; "
                + "it was committed and not imported");
        }
```

- [ ] **Step 6: Build and run**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterLoopTests" --filter-class "BaseApi.Tests.KafkaImporter.KafkaImporterCacheTests"`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/Processor.KafkaImporter src/tests/BaseApi.Tests/KafkaImporter
git commit -m "feat(kafka-importer): the lineage is the record's execution-id header — a re-read record derives the same key; a record without a valid one is committed, not imported, and fails the dispatch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The feeds stamp `execution-id`

**Files:**
- Modify: `tools/kafka-produce-records.py` (imports; `main` produce loop ~line 144; docstring)
- Modify: `tools/simulate-endless-feed.py` (imports ~line 90; `produce()` ~lines 386-397)

**Interfaces:**
- Produces: every produced record carries header `execution-id = str(uuid5(NS_FEED, path))`.

- [ ] **Step 1: `kafka-produce-records.py`**

Add `import uuid` to the imports, then after the imports:

```python
# The importer's lineage contract: every record carries an `execution-id` header, a GUID unique per
# file. Derived from the path, so re-seeding a path names the same lineage and a record re-read
# after a commit fault is absorbed instead of forking. NEVER change this namespace: the same path
# would then open a new lineage. Must match NS_FEED in simulate-endless-feed.py.
NS_FEED = uuid.UUID("5d0e7c2a-9f41-4b6e-8a3d-1e2f6c9b7a40")


def execution_id(path):
    return str(uuid.uuid5(NS_FEED, path)).encode("utf-8")
```

Replace `producer.produce(args.topic, value=record(path), on_delivery=on_delivery)` with:

```python
        producer.produce(
            args.topic,
            value=record(path),
            headers=[("execution-id", execution_id(path))],
            on_delivery=on_delivery,
        )
```

Add to the module docstring, after the ONE KEY paragraph:

```
THE LINEAGE RIDES A HEADER. Each record carries `execution-id: uuid5(NS_FEED, filePath)`. The
importer refuses a record without one -- commits it, imports nothing, fails the dispatch -- so a
record produced by anything other than this script must carry it too.
```

- [ ] **Step 2: `simulate-endless-feed.py`**

Add `import uuid` to the imports (alphabetical, after `import time`), then the same `NS_FEED` constant and `execution_id(path)` function (comment: "Must match NS_FEED in kafka-produce-records.py.") after the imports. In `produce()` replace:

```python
        producer.produce(topic, value=value, on_delivery=on_delivery)
```

with

```python
        producer.produce(
            topic,
            value=value,
            headers=[("execution-id", execution_id(path))],
            on_delivery=on_delivery,
        )
```

- [ ] **Step 3: Verify both scripts parse and derive the same id**

Run:

```bash
python -c "import ast,sys; [ast.parse(open(f, encoding='utf-8').read()) for f in ('tools/kafka-produce-records.py','tools/simulate-endless-feed.py')]; print('ok')"
python -c "import uuid; print(uuid.uuid5(uuid.UUID('5d0e7c2a-9f41-4b6e-8a3d-1e2f6c9b7a40'), '/mnt/skp-files/in/file-001.zip'))"
```

Expected: `ok`, then one GUID. `grep -n "NS_FEED = " tools/*.py` shows the identical literal in both files.

- [ ] **Step 4: Commit**

```bash
git add tools/kafka-produce-records.py tools/simulate-endless-feed.py
git commit -m "feat(tools): the feeds stamp execution-id = uuid5(NS_FEED, filePath) on every record — the importer's lineage contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Redis `maxmemory` and the sizing comments

**Files:**
- Modify: `k8s/11-redis.yaml:5-9, 49`
- Modify: `k8s/37-processor-archiveexpander.yaml:9-15`, `k8s/38-processor-filefetcher.yaml:21-28`, `k8s/40-processor-filepersister.yaml:32-35`

- [ ] **Step 1: Redis**

Line 49 becomes:

```yaml
          command: ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "144mb", "--maxmemory-policy", "noeviction"]   # D-12 persistence args unchanged; maxmemory: see header
```

Append to the header comment (after line 9):

```yaml
# MAXMEMORY 144mb, noeviction, below the 192Mi container limit. Since the in-process post hop no step
# output rides a RabbitMQ message: every branch and every successor input lives here, so this store
# is the pipeline's only data-size limit. Full, it refuses writes with OOM, which the processors and
# the orchestrator classify transient (requeue and trip the L2 gate) — instead of the container being
# OOM-killed and taking every in-flight blob with it. Eviction would silently delete a live input.
```

- [ ] **Step 2: Sizing comments**

`k8s/37-processor-archiveexpander.yaml` — replace "the broker message body (that document base64'd again inside the ProcessedData envelope, ~1.78x), and a full JsonDocument DOM at validation can all coexist — and the work and post consumers are the SAME process, so a dispatch and a branch overlap." with "the bytes written to L2 (no broker copy since the in-process post hop), and a full JsonDocument DOM at output validation can all coexist inside one dispatch."

`k8s/38-processor-filefetcher.yaml` — replace "the broker message body (that envelope base64'd again inside the ProcessedData envelope, ~1.78x), and a JsonDocument DOM at output validation can all coexist — and the work and post consumers are the SAME process, so a dispatch and a branch overlap." with "the bytes written to L2 (no broker copy since the in-process post hop), and a JsonDocument DOM at output validation can all coexist inside one dispatch."

`k8s/40-processor-filepersister.yaml` — replace "The envelope arrives base64'd inside a ProcessedData message, is decoded to the raw bytes, and both coexist with a JsonDocument DOM at input validation — and the work and post consumers are the SAME process, so a dispatch and a branch overlap." with "The envelope is read from L2, decoded to the raw bytes, and both coexist with a JsonDocument DOM at input validation."

- [ ] **Step 3: Validate the YAML**

Run: `python -c "import yaml,sys; [list(yaml.safe_load_all(open(f))) for f in sys.argv[1:]]; print('ok')" k8s/11-redis.yaml k8s/37-processor-archiveexpander.yaml k8s/38-processor-filefetcher.yaml k8s/40-processor-filepersister.yaml`
Expected: `ok`. (If PyYAML is absent: `kubectl apply --dry-run=client -f <file>` for each.)

- [ ] **Step 4: Commit**

```bash
git add k8s/11-redis.yaml k8s/37-processor-archiveexpander.yaml k8s/38-processor-filefetcher.yaml k8s/40-processor-filepersister.yaml
git commit -m "chore(k8s): Redis maxmemory 144mb noeviction — the store is now the only data-size limit; sizing comments no longer count a broker copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Release 1 gate and rollout

- [ ] **Step 1: Full suite**

Run: `bash scripts/pack-all.sh && dotnet build SK_P.sln --nologo -v q && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: build clean (warnings are errors); 0 failed, exit 0, every skip under `Live/`.

- [ ] **Step 2: Rollout (operator — confirm with the user before touching a cluster)**

Order is load-bearing (§11): an orchestrator that reads `""` as absent would drop a no-data branch's successors.

1. Apply `k8s/11-redis.yaml` (Redis restarts; it is ephemeral by design — do this between runs).
2. Build and roll out the **orchestrator** image. Wait for every replica Ready.
3. Build and roll out every **processor** image (they all consume `BaseProcessor.Core` 1.0.0, repacked).
4. Re-seed through the updated feeds; confirm in Kibana: `imported record … as execution <header id>`, `branch completed in`, and no `refused the record`.
5. Watch `processor-{id}-post` depths fall to 0 (drain-only consumers). Inspect or redrive any `.dead` queue before Part 3.

---

# Part 2 — Release 2: the orchestrator's hop in-process

### Task 11: In-memory L2 gains `COPY` and `SET NX`

**Files:**
- Modify: `src/tests/BaseApi.Tests/Support/InMemoryL2.cs:166-191` (`Wire`)
- Test: `src/tests/BaseApi.Tests/Support/InMemoryL2Tests.cs`

- [ ] **Step 1: Failing tests**

```csharp
    [Fact]
    public async Task CopyWithoutReplaceCopiesOnceAndNeverOverwrites()
    {
        var l2 = new InMemoryL2();
        await l2.Db.StringSetAsync("skp:data:a", "bytes");

        Assert.True(await l2.Db.KeyCopyAsync("skp:data:a", "skp:data:b"));
        await l2.Db.StringSetAsync("skp:data:a", "changed");
        Assert.False(await l2.Db.KeyCopyAsync("skp:data:a", "skp:data:b"));
        Assert.False(await l2.Db.KeyCopyAsync("skp:data:absent", "skp:data:c"));

        Assert.Equal("bytes", l2.Value("skp:data:b"));
        Assert.False(l2.Has("skp:data:c"));
    }

    [Fact]
    public async Task SetNotExistsWritesOnlyAnAbsentKey()
    {
        var l2 = new InMemoryL2();

        Assert.True(await l2.Db.StringSetAsync("skp:data:a", "", null, When.NotExists, CommandFlags.None));
        Assert.False(await l2.Db.StringSetAsync("skp:data:a", "x", null, When.NotExists, CommandFlags.None));

        Assert.Equal("", l2.Value("skp:data:a"));
        Assert.True((await l2.Db.StringGetAsync("skp:data:a")).IsNullOrEmpty);
        Assert.False((await l2.Db.StringGetAsync("skp:data:a")).IsNull);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Support.InMemoryL2Tests"`
Expected: FAIL — `KeyCopyAsync` returns `false` (NSubstitute default); the NX write overwrites.

- [ ] **Step 3: Implement**

In `Wire`, replace the five-argument `StringSetAsync` wiring with:

```csharp
        target.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                              Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var key = ci.ArgAt<RedisKey>(0).ToString();
                var when = ci.ArgAt<When>(3);

                // NX / XX, as a real server answers them: false and no write when the condition fails.
                if ((when == When.NotExists && Exists(key)) || (when == When.Exists && !Exists(key)))
                {
                    return Task.FromResult(false);
                }

                _strings[key] = ci.ArgAt<RedisValue>(1).ToString();
                if (ci.ArgAt<TimeSpan?>(2) is { } ttl)
                {
                    _ttls[key] = ttl;
                }

                return Task.FromResult(true);
            });
```

and add after the `KeyExistsAsync` wiring:

```csharp
        // COPY, strings only — the one shape the orchestrator copies (an execution blob). Without
        // REPLACE a real server refuses when the destination exists, and answers false for an absent
        // source; both are modelled because the hand-off's convergence depends on the first.
        target.KeyCopyAsync(Arg.Any<RedisKey>(), Arg.Any<RedisKey>(), Arg.Any<int>(), Arg.Any<bool>(),
                            Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var source = ci.ArgAt<RedisKey>(0).ToString();
                var destination = ci.ArgAt<RedisKey>(1).ToString();
                var replace = ci.ArgAt<bool>(3);

                if (!_strings.TryGetValue(source, out var value) || (!replace && Exists(destination)))
                {
                    return Task.FromResult(false);
                }

                _strings[destination] = value;
                return Task.FromResult(true);
            });
```

Update the `Wire` doc summary's list to include "COPY, SET NX/XX".

- [ ] **Step 4: Run**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Support.InMemoryL2Tests"`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Support/InMemoryL2.cs src/tests/BaseApi.Tests/Support/InMemoryL2Tests.cs
git commit -m "test(support): InMemoryL2 models COPY without REPLACE and SET NX/XX

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `StepOutcomeHandler` derives `S`, copies in Redis and dispatches in-process

**Files:**
- Modify: `src/Orchestrator/Messaging/StepOutcomeHandler.cs:13-38` (type remarks), `213-253` (guard), `291-319` (loop), `371-475` (reclaim and helpers)
- Test: `src/tests/BaseApi.Tests/Orchestrator/ExecutionRoundTripTests.cs`

**Interfaces:**
- Consumes: `EntryIds.Successor`, `EntryIds.HandoffSource`, `L2ProjectionKeys.ExecutionHandoffs` (Task 1); `L2FaultClassifier` (BaseConsole, Task 2); `KeyCopyAsync` / NX in `InMemoryL2` (Task 11).
- Produces: for each matched successor, `data:{S}` (copy of `data:{E}` for Completed with a key; `""` NX otherwise), a broker-confirmed `ProcessDispatch(S)` on `processor-{id}`, then `SADD skp:handoff:{source} nextStepId`; finally `DEL data:{E} handoff:{source}`. No `NextStepHandoff` is sent.

- [ ] **Step 1: Let the test bus fault by queue**

In `ExecutionRoundTripTests.Bus`, add a queue-aware fault beside `FaultOn`:

```csharp
        /// <summary>Faults sends to one queue — to fail one successor of a fan-out and not its siblings.</summary>
        public Func<string, Exception?>? FaultOnQueue { get; set; }
```

and in `SendAsync`, before the existing `FaultOn` check:

```csharp
            if (FaultOnQueue?.Invoke(queue) is { } byQueue)
            {
                return Task.FromException(byQueue);
            }
```

- [ ] **Step 2: Update the existing facts to the new hop (failing)**

1. `AStepsOutputBecomesTheNextStepsInput`: replace `Assert.NotEqual(Entry, dispatch.EntryId);` with `Assert.Equal(EntryIds.Successor(Entry, Corr, A, B), dispatch.EntryId);`.
2. `AFailedStepsSuccessorReceivesNoDataAndTheInputIsReclaimed`: replace the last two assertions with

```csharp
        var successor = EntryIds.Successor(Entry, Corr, A, B);
        Assert.Equal(successor, dispatch.EntryId);
        Assert.Equal("", h.L2.Value(L2ProjectionKeys.ExecutionData(successor)));
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
        Assert.Equal([L2ProjectionKeys.ExecutionData(successor)], h.L2.Keys());
```

3. `AFailedOutcomeWhoseHandOffFailsKeepsItsKeyForTheReplay`, `AFailedHandOffLeavesTheSourceBlobForTheReplay`, `ARequeuedOutcomeKeepsItsBlobBecauseTheRedeliveryStillNeedsIt`: change `MessageTypes.NextStepHandoff` in `FaultOn` to `MessageTypes.ProcessDispatch`.
4. `AnOutcomeWithNoBlobDispatchesItsSuccessorAsASourceStep` → rename `AnEntryStepsFailureGivesItsSuccessorAKeyDerivedFromTheRun` and replace its assertions:

```csharp
        var dispatch = h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single();
        var successor = EntryIds.Successor(Guid.Empty, Corr, A, B);
        Assert.Equal(successor, dispatch.EntryId);
        Assert.Equal([L2ProjectionKeys.ExecutionData(successor)], h.L2.Keys());
```

5. `AStoreFaultOnTheReadEscapesSoTheGateCanTrip`: stub `h.L2.Db.KeyExistsAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())` instead of `StringGetAsync`.
6. `AFailedOrCancelledOutcomeNeverReadsTheBlob` → keep, and add the Completed case to a new fact: `ACompletedOutcomeNeverLoadsTheBlobEither` — deliver `Outcome(StepResult.Completed, Entry)` with `Seed(h, Entry, Output)` and assert `StringGetAsync` was not received and `KeyCopyAsync` was received once.

- [ ] **Step 3: New facts (failing)**

```csharp
    // ---------------------------------------------------------------- the in-process hand-off

    [Fact]
    public async Task NoHandOffMessageCarriesData()
    {
        // The reason for the whole change: the organisation caps message size, and only ids may travel.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.DoesNotContain(h.Bus.Sent, s => s.Type == MessageTypes.NextStepHandoff);
        Assert.Single(h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch));
    }

    [Fact]
    public async Task AReplayedOutcomeDerivesTheSameSuccessorKey()
    {
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);
        h.Bus.FaultOn = t => t == MessageTypes.ProcessDispatch
            ? new TransientSendException("broker blip", new IOException("reset"))
            : null;

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry)));
        var first = h.L2.Snapshot();

        h.Bus.FaultOn = null;
        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        var dispatch = h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single();
        Assert.Contains(L2ProjectionKeys.ExecutionData(dispatch.EntryId), first, StringComparison.Ordinal);
        Assert.Equal(Output, h.L2.Value(L2ProjectionKeys.ExecutionData(dispatch.EntryId)));
    }

    [Fact]
    public async Task ACopyThatAlreadyExistsIsNotOverwritten()
    {
        // COPY without REPLACE: a successor key an earlier attempt made is kept as it is.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);
        var successor = EntryIds.Successor(Entry, Corr, A, B);
        Seed(h, successor, "earlier");

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Equal("earlier", h.L2.Value(L2ProjectionKeys.ExecutionData(successor)));
        Assert.Equal(successor, h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single().EntryId);
    }

    [Fact]
    public async Task ARedeliveryDoesNotResendASuccessorAlreadyDispatched()
    {
        // Review focus 4. An unroutable send is transient and the WHOLE outcome retries; without
        // handoff:{E} every sibling dispatched before the failing one would be re-sent on every retry.
        var h = new Harness(Step(A, PA, 1, "{}", B, C), Step(B, PB, 1, "{}"), Step(C, PC, 1, "{}"));
        Seed(h, Entry, Output);
        h.Bus.FaultOnQueue = q => q == ProcessorQueues.Work(PC)
            ? new TransientSendException("unroutable", new IOException("no route"))
            : null;

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry)));

        h.Bus.FaultOnQueue = null;
        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        var dispatched = h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Select(d => d.StepId).ToList();
        Assert.Equal([B, C], dispatched);
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
        Assert.Empty(h.L2.Members(L2ProjectionKeys.ExecutionHandoffs(Entry)));
    }

    [Fact]
    public async Task ADeterministicDispatchFailureCostsOnlyThatSuccessor()
    {
        // Review focus 5. The failing successor is reported Failed under its own key — so its own
        // outcome reclaims it — and its siblings are dispatched; the outcome is acked.
        var h = new Harness(Step(A, PA, 1, "{}", B, C), Step(B, PB, 1, "{}"), Step(C, PC, 1, "{}"));
        Seed(h, Entry, Output);
        h.Bus.FaultOnQueue = q => q == ProcessorQueues.Work(PB) ? new NotSupportedException("no converter") : null;

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Equal(C, h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single().StepId);
        var failed = h.Bus.OfType<StepOutcome>(MessageTypes.StepOutcome).Single();
        Assert.Equal(StepResult.Failed, failed.Result);
        Assert.Equal(B, failed.StepId);
        Assert.Equal(PB, failed.ProcessorId);
        Assert.Equal(EntryIds.Successor(Entry, Corr, A, B), failed.EntryId);
        Assert.Contains(h.PreLog.Records, r => r.Message.Contains("could not start the step", StringComparison.Ordinal));
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task AFailureThatCannotEvenBeReportedReclaimsAndParksAfterTheSiblings()
    {
        var h = new Harness(Step(A, PA, 1, "{}", B, C), Step(B, PB, 1, "{}"), Step(C, PC, 1, "{}"));
        Seed(h, Entry, Output);
        h.Bus.FaultOnQueue = q =>
            q == ProcessorQueues.Work(PB) || q == OrchestratorQueues.Result ? new NotSupportedException("broken") : null;

        await Assert.ThrowsAsync<NotSupportedException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry)));

        Assert.Equal(C, h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single().StepId);
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(EntryIds.Successor(Entry, Corr, A, B))));
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task TheSuccessorKeyIsWrittenBeforeItIsDispatched()
    {
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);
        var successor = EntryIds.Successor(Entry, Corr, A, B);
        var written = false;
        h.Bus.FaultOnQueue = q =>
        {
            if (q == ProcessorQueues.Work(PB))
            {
                written = h.L2.Has(L2ProjectionKeys.ExecutionData(successor));
            }

            return null;
        };

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.True(written);
    }
```

- [ ] **Step 4: Run to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.ExecutionRoundTripTests"`
Expected: FAIL — the new and updated facts (the handler still sends `NextStepHandoff`).

- [ ] **Step 5: Implement**

In `StepOutcomeHandler.cs`:

1. Add `using System.Runtime.ExceptionServices;` and `using BaseConsole.Core.Gating;`.
2. Replace the type remarks' first `<para>` (lines 16-23) with:

```csharp
/// <para>
/// <b>Check once, hand off N times in-process, reclaim last.</b> Each matched successor gets a key of
/// its own, derived (<see cref="EntryIds.Successor"/>) so a redelivery names the same one: a Completed
/// step's blob is copied there inside Redis (COPY without REPLACE), anything else gets <c>""</c> (no
/// data). The dispatch is sent from here — no hand-off message carries the blob any more, because the
/// organisation caps RabbitMQ's message size — and each dispatched successor is remembered in
/// <c>handoff:{E}</c>, so a redelivered outcome sends only what an earlier attempt did not. See
/// <c>docs/superpowers/specs/2026-10-12-in-process-post-derived-keys-design.md</c> §8.
/// </para>
```

3. Replace the data decision and the duplicate branch (lines 213-253, from `// READ BEFORE NARRATING.` through the closing brace of `if (data is null)`) with:

```csharp
        // CHECK BEFORE NARRATING: a delivery that advances nothing must not announce "the entry step
        // completed" first (RunLedger's I8 counts that line exactly).
        //
        // EXISTS, never a read: the blob is copied inside Redis and never loaded here. Absent means an
        // earlier delivery of this outcome advanced and reclaimed it — the absent-key disposition
        // (docs/superpowers/specs/2026-09-01-absent-key-disposition-design.md). Guid.Empty names no
        // key at all — an entry step's Failed or Cancelled outcome — and skips the check.
        if (m.EntryId != Guid.Empty && !await ExistsAsync(m.EntryId).ConfigureAwait(false))
        {
            _logger.LogWarning(
                "the execution blob is absent — treating as a duplicate delivery, advancing nothing");
            return;
        }
```

4. Replace the hand-off loop (lines 293-319) with:

```csharp
        var db = _redis.GetDatabase();
        var source = EntryIds.HandoffSource(m.EntryId, m.CorrelationId, m.StepId);
        var handoffs = L2ProjectionKeys.ExecutionHandoffs(source);

        // A failure report that could not itself be sent. Rethrown AFTER the loop, so one broken
        // successor no longer stops its siblings; the keys it named are reclaimed first.
        ExceptionDispatchInfo? park = null;
        var unreported = new List<Guid>();

        foreach (var next in selection.Matches)
        {
            var successorId = EntryIds.Successor(m.EntryId, m.CorrelationId, m.StepId, next.StepId);
            var dispatchStarted = Stopwatch.GetTimestamp();

            try
            {
                await MaterializeAsync(db, m, successorId).ConfigureAwait(false);

                // Already sent by an earlier attempt at this outcome: an unroutable send is transient
                // and requeues the WHOLE outcome, and without this set every sibling before it would
                // be dispatched again on every retry.
                if (await db.SetContainsAsync(handoffs, next.StepId.ToString("D")).ConfigureAwait(false))
                {
                    continue;
                }

                // A dispatch STARTS a step, so the clock starts here rather than being inherited from
                // the outcome being handled.
                MessageClock.BeginChain();

                await _sender
                    .SendTransientAsync(
                        ProcessorQueues.Work(next.ProcessorId), MessageTypes.ProcessDispatch,
                        new ProcessDispatch(
                            m.CorrelationId, m.ExecutionId, m.WorkflowId, next.StepId, next.ProcessorId,
                            next.Payload, successorId),
                        ct)
                    .ConfigureAwait(false);

                // After the confirm, never before: a crash between the two dispatches this successor
                // again — a duplicate, which this system prefers to a loss.
                await db.SetAddAsync(handoffs, next.StepId.ToString("D")).ConfigureAwait(false);

                _logger.LogInformation(
                    "handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}",
                    next.StepId, next.ProcessorId, successorId);
                _logger.LogInformation(
                    "dispatched in {ElapsedMs}ms", (int)Stopwatch.GetElapsedTime(dispatchStarted).TotalMilliseconds);
            }
            catch (Exception ex) when (!IsRecoverable(ex))
            {
                // Deterministic: redelivery cannot help. Report THIS successor failed under its own key
                // — so that outcome reclaims it and the graph's failure branch runs — and carry on with
                // its siblings. The message is logged, never sent.
                _logger.LogError(ex, "could not start the step — reporting it failed");

                try
                {
                    await _sender.SendTransientAsync(
                            OrchestratorQueues.Result,
                            MessageTypes.StepOutcome,
                            new StepOutcome(
                                m.CorrelationId, m.ExecutionId, m.WorkflowId, next.StepId, next.ProcessorId,
                                successorId, StepResult.Failed),
                            ct)
                        .ConfigureAwait(false);

                    await db.SetAddAsync(handoffs, next.StepId.ToString("D")).ConfigureAwait(false);
                }
                catch (Exception report) when (!IsRecoverable(report))
                {
                    // Nothing will ever name this key: reclaim it and park, after the siblings.
                    _logger.LogError(
                        report, "could not report the failed step either — reclaiming its input and parking");
                    unreported.Add(successorId);
                    park ??= ExceptionDispatchInfo.Capture(report);
                }
            }
        }
```

5. Replace the final reclaim (lines 371-374) with:

```csharp
        // Unconditional, and last — after every hand-off. See the type remarks: every path reaching
        // here has acked the outcome as final, and a store fault must propagate so the classifier trips
        // the gate and requeues rather than acknowledging a hand-off whose source was never reclaimed.
        foreach (var orphan in unreported)
        {
            await db.KeyDeleteAsync(L2ProjectionKeys.ExecutionData(orphan)).ConfigureAwait(false);
        }

        await ReclaimAsync(m.EntryId, handoffs).ConfigureAwait(false);

        park?.Throw();
```

6. Change the L1-miss reclaim call (line 167) to `await ReclaimAsync(m.EntryId, L2ProjectionKeys.ExecutionHandoffs(EntryIds.HandoffSource(m.EntryId, m.CorrelationId, m.StepId))).ConfigureAwait(false);`.
7. Replace `ReclaimAsync`, delete `ReadAsync` (and its doc), and add `MaterializeAsync` and `IsRecoverable`:

```csharp
    /// <summary>
    /// Deletes the outcome's blob and its hand-off set, in one call.
    /// <para>
    /// <b>Called on every disposition that ends this replica's responsibility for the message —
    /// acked and parked alike.</b> Only a requeue-nack skips it, because that delivery is coming back
    /// and will need both to still be there. A store fault propagates on both callers.
    /// </para>
    /// </summary>
    private async Task ReclaimAsync(Guid entryId, string handoffs)
    {
        _logger.LogDebug("reclaiming the source blob from L2");

        // Guid.Empty names no blob; the hand-off set may exist either way.
        var keys = new List<RedisKey> { handoffs };
        if (entryId != Guid.Empty)
        {
            keys.Add(L2ProjectionKeys.ExecutionData(entryId));
        }

        await _redis.GetDatabase().KeyDeleteAsync([.. keys]).ConfigureAwait(false);
    }

    /// <summary>
    /// Gives one successor its input under <paramref name="successorId"/>.
    /// <para>
    /// <b>Only a Completed outcome's blob is data (spec D6)</b>: copied inside Redis, never loaded
    /// here. COPY without REPLACE: <c>false</c> means an earlier attempt made the key, and dispatching
    /// is still correct. Anything else — Failed, Cancelled, or an outcome naming no key — gets
    /// <c>""</c>, written NX for the same reason.
    /// </para>
    /// </summary>
    private async Task MaterializeAsync(IDatabase db, StepOutcome m, Guid successorId)
    {
        var target = L2ProjectionKeys.ExecutionData(successorId);

        if (m.Result == StepResult.Completed && m.EntryId != Guid.Empty)
        {
            _logger.LogDebug("copying the finished step's blob to the successor's key");
            await db.KeyCopyAsync(L2ProjectionKeys.ExecutionData(m.EntryId), target).ConfigureAwait(false);
            return;
        }

        await db.StringSetAsync(target, RedisValue.EmptyString, null, When.NotExists, CommandFlags.None)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Whether redelivering the outcome could succeed where this attempt did not: a transport fault on
    /// a send, or the store being unreachable (or OOM, READONLY, LOADING, BUSY). Everything else is
    /// deterministic, and misclassifying in that direction reports one step failed rather than
    /// requeueing a message that fails identically forever.
    /// </summary>
    private static bool IsRecoverable(Exception ex) =>
        ex is TransientSendException || L2FaultClassifier.IsTransient(ex);
```

8. Update the `ExistsAsync` summary to: "Whether the outcome's key is still present. Absent means an earlier delivery of this outcome already advanced and reclaimed it." and its debug text to `"checking the finished step's key is still in L2"`.
9. Delete the now-unused `data` variable and the comment block that justified `data.Length == 0 ? Guid.Empty : Guid.NewGuid()`.

- [ ] **Step 6: Build and run**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Orchestrator.ExecutionRoundTripTests"`
Expected: all pass. The post-hop facts (`TheInputKeyIsWrittenBeforeTheStepIsDispatched` … `AReplayedHandOffRewritesTheSameKeyWithTheSameBytes`) still pass: `NextStepHandoffHandler` stays registered to drain release-1 hand-offs.

- [ ] **Step 7: Full suite, then commit**

Run: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: 0 failed.

```bash
git add src/Orchestrator/Messaging/StepOutcomeHandler.cs src/tests/BaseApi.Tests/Orchestrator/ExecutionRoundTripTests.cs
git commit -m "feat(orchestrator): successors get derived keys (EntryIds.Successor), the blob is copied inside Redis, the dispatch is sent in-process and remembered in handoff:{E}; one failing successor no longer stops its siblings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Rollout (operator — confirm with the user first)**

Processors from Part 1 must already be everywhere (they read empty keys). Roll out the orchestrator image. Watch `orchestrator-result-post` fall to 0 (drained by `NextStepHandoffHandler`), and `skp:handoff:*` stay near zero between runs (`redis-cli --scan --pattern 'skp:handoff:*' | wc -l`).

---

# Part 3 — Remove the post queues (after `processor-*-post`, `orchestrator-result-post` and their `.dead` queues all read 0)

### Task 13: Delete the drains, constants and topology

**Files:**
- Delete: `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs`, `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`, `src/Orchestrator/Messaging/NextStepHandoffHandler.cs`, `src/Messaging.Contracts/NextStepHandoff.cs`
- Modify: `src/Messaging.Contracts/ProcessorQueues.cs` (remove `Post`, `PostDead`), `src/Messaging.Contracts/OrchestratorQueues.cs` (remove `ResultPost`, `ResultPostDead`), `src/Messaging.Contracts/MessageTypes.cs:50-51, 61-62` (remove `ProcessedData`, `NextStepHandoff`)
- Modify: `src/BaseProcessor.Core/Messaging/ProcessorTopology.cs` (remove the second `DeadLetteredPair.DeclareAsync`), `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs:256, 260-269, 312-319, 357-364` (remove the handler, the post consumer, the post probe entry, the post dead seed and probe entry; reword the "two queues" comments to one)
- Modify: `src/Orchestrator/Messaging/OrchestratorTopology.cs:88-89`, `src/Orchestrator/OrchestratorHost.cs:260-276, 307-313, 415-428` (remove `ResultPost`/`ResultPostDead` from the seeds, the probes, the handler registration and `AddGatedQueue`)
- Modify tests: `ProcessorTopologyTests`, `ProcessorHostWiringTests` (`BothQueuesGetTheirOwnGatedConsumer`, `BothQueueProbesRunAsHostedServices` → one queue), `OrchestratorTopologyTests:48, 86`, `OrchestratorFanoutTests:58`, `OrchestratorHostWiringTests:162`, `ExecutionRoundTripTests` (delete `Post`, the `NextStepHandoff` arm of `Deliver`, `Drain` and every `await h.Drain();`, the `PostLog` property, and the six facts under `// ---- the post hop`)
- Modify docs: `grafana/README.md:1432, 1540`; optionally drop `(-post)?` at `grafana/skp-processor.json:1175, 1276, 1368`; comments naming `ProcessedDataHandler` / `NextStepHandoffHandler` in `ProcessDispatchHandler.cs`, `StepOutcomeHandler.cs`, `ProcessorLivenessWriter.cs`, `IProviderHandler.cs`, `tools/kafka-produce-records.py`

- [ ] **Step 1: Delete and edit as listed**, then find stragglers:

```bash
grep -rn "ProcessedDataHandler\|NextStepHandoff\|ProcessorQueues.Post\|PostDead\|ResultPost\|MessageTypes.ProcessedData" src --include=*.cs | grep -v "/obj/"
```

Expected: no output. (Fixtures `Resilience/Fixtures/complete-run.json` and `tools/classification-fixture.json` are captured history and stay as they are.)

- [ ] **Step 2: Pack, build, full suite**

Run: `bash scripts/pack-all.sh && dotnet build SK_P.sln --nologo -v q && dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj --nologo -v q && src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`
Expected: 0 failed, every skip under `Live/`.

- [ ] **Step 3: Commit**

```bash
git add -u src grafana tools
git add src/Messaging.Contracts/nugets src/BaseProcessor.Core/nugets src/BaseConsole.Core/nugets
git status --short   # only the files above
git commit -m "refactor: remove the drained post queues — ProcessedDataHandler, NextStepHandoffHandler, NextStepHandoff, the -post queue constants, topology, consumers and probes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Rollout and queue deletion (operator — confirm with the user first)**

Roll out the orchestrator and every processor. Then, on each environment, delete the four queues (per processor for the first two):

```bash
kubectl -n skp exec rabbitmq-0 -- rabbitmqctl delete_queue processor-<id>-post
kubectl -n skp exec rabbitmq-0 -- rabbitmqctl delete_queue processor-<id>-post.dead
kubectl -n skp exec rabbitmq-0 -- rabbitmqctl delete_queue orchestrator-result-post
kubectl -n skp exec rabbitmq-0 -- rabbitmqctl delete_queue orchestrator-result-post.dead
```

(`rabbitmqctl list_queues name messages | grep -- -post` lists them first; delete only those reading 0.)
