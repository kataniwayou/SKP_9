# Input Reclaim and Single L2 Namespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a step's output blob *be* its successor's input blob — one `data:` namespace, no TTL,
no relocation — and move the input reclaim from the post handler to the pre handler, where it runs
once after the author's transform returns normally.

**Architecture:** Today the post handler writes output to `out:{messageId}` with a jittered TTL and
deletes the input `data:{entryId}` as its first act. After this plan the post handler writes to
`data:{messageId}` with no expiry and deletes nothing, and the pre handler reclaims
`data:{entryId}` once — after `ExecuteAsync` returns normally, outside the catch chain, skipped for
a source step. `messageId` therefore becomes the successor's `entryId` unchanged, so the
orchestrator hands the id straight through with no copy when a step has exactly one successor.

**Tech Stack:** .NET 8, StackExchange.Redis, xunit.v3 under the Microsoft Testing Platform runner,
NSubstitute.

**Spec:** `docs/superpowers/specs/2026-08-20-base-processor-consumers-design.md` — §7 and §7.1.
**This plan reverses a decision that spec records as considered-and-rejected. Read "Spec Divergence"
below before Task 1.**

**Depends on:** `2026-08-20-processor-execution-path.md`, complete and merged. Every file this plan
touches was built there.

---

## Global Constraints

- **Target framework:** `net8.0`. No language or BCL feature above C# 12.
- **`--filter` is silently ignored** by this repo's test runner. Run the whole project
  (`dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`) and read the summary; use
  `--filter-method` for a single test.
- **Baseline entering this plan:** 286 tests — 280 pass, 6 `Live/` tests skip without
  `SKP_REALSTACK`, exit 0, 0 build warnings. The gate is 0 failures, exactly 6 skips, exit 0, and the
  task's own tests present and passing — not an absolute count.
- **Never log a payload, a config, or processed data.** Ids and outcomes only. A deserialize
  `JsonException` quotes the offending fragment of the payload in its message, so its text must never
  reach a log template or the wire.
- **Never interpolate an id into a log template.** Ids are structured `{Placeholder}` arguments or
  scope values under a fixed key.
- **Rendering is fixed:** `CorrelationId` renders `ToString("N")`; `WorkflowId`, `StepId`,
  `ProcessorId`, `ExecutionId`, `EntryId` render `ToString("D")`.
- **Log attribute keys are PascalCase.**
- **Prefetch stays at 1.**
- **`Messaging.Contracts` stays BCL-only.**
- **A store fault must propagate.** Anything that swallows a Redis exception and reports a business
  outcome acknowledges a step whose real state is unknown. The L2 classifier trips the gate and
  requeues; that is the correct handling, and it only happens if the exception escapes.
- **Working-tree hazard:** uncommitted files under
  `src/BaseApi.Service/Features/Orchestration/Projection/` (an L2 orphan sweeper), a modified
  `OrchestrationServiceCollectionExtensions.cs`, and
  `src/tests/BaseApi.Tests/Orchestration/L2OrphanSweeperTests.cs` belong to the repository owner and
  are not part of this work. Never stage, commit, revert, or edit them. Always `git add` explicit
  paths — never `git add -A` or `git add .`.

---

## Spec Divergence — read this before writing any code

Spec §7.1 is titled "The output goes to `out:`, not `data:`" and says, verbatim:

> Collapsing the two namespaces — post writing straight into `data:{messageId}` so the next dispatch
> reads it directly — was considered and rejected. Fan-out breaks it.
>
> A step with three successors would produce three dispatches carrying the same `EntryId`, all
> reading one key. The first successor's post deletes it at step 1, and the other two find it absent,
> hit pre's clean-absent branch, and return with no result. Two branches lost silently.

**That objection is correct and this plan does not refute it.** Moving the reclaim to the pre hop
does not fix it either — the first successor's *pre* hop now reclaims the shared key after its author
returns, and the other two successors still find it absent and vanish. The window moves earlier; the
failure is identical.

What changes is **whose problem it is**. The repository owner has decided:

- A step with **one** successor passes `messageId` through as the successor's `entryId`. No copy, no
  relocation. This is the common path and it is free.
- A step with **more than one** successor is the orchestrator's problem: it must copy the blob into
  one key per successor under **derived** ids (derived, not minted, or a replay forks), or hold a
  refcount and reclaim on the last consumer.
- Cleanup after a step that ends in `FailedException` — where the pre hop never reclaims — is also
  the orchestrator's, not the processor's.

The processor therefore stops defending against multi-successor fan-out, and the orchestrator
inherits the duty. **If that inheritance is not written down, whoever builds the orchestrator will
not know they own it, and the silent two-branch loss §7.1 describes will ship.** Task 3 writes it
down in three places. Do not skip Task 3.

The TTL removal has the same shape: today an unreclaimed blob expires on its own; afterwards nothing
expires and every key must be explicitly deleted by the pre hop, by the orchestrator, or by the
orphan sweeper. This is the "tolerate duplication, never tolerate loss" direction taken to its
conclusion, and it is deliberate.

---

## File Structure

| File | Change | Responsibility after this plan |
|---|---|---|
| `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` | Modify | `ExecutionData(Guid)` is the only execution-blob key. `OutputData` and `OutputDataTtl` are gone. |
| `src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs` | Modify | Loses `ExecutionDataTtlSeconds` — nothing reads it once the TTL is gone. |
| `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs` | Modify | Validate, write, report. No delete, no TTL, no `IOptions` dependency. |
| `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` | Modify | Gains the input reclaim, after the catch chain, guarded by a success flag. |
| `src/Messaging.Contracts/Execution.cs` | Modify | `ProcessedData.EntryId`'s doc comment — it no longer names the post handler as the reclaimer. |
| `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs` | Modify | Loses the reclaim and TTL tests; the write assertions move to the `data:` key. |
| `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs` | Modify | `NeverDeletesOrWritesAnything` is replaced by the reclaim's own tests. |
| `docs/superpowers/specs/2026-08-20-base-processor-consumers-design.md` | Modify | §7 and §7.1 rewritten to match, with the orchestrator's inherited duty stated. |
| `docs/superpowers/plans/2026-08-20-processor-execution-path.md` | Modify | Known Gaps gains the multi-successor and failed-step-cleanup entries. |

---

### Task 1: Collapse the output blob into `data:` and drop its TTL

**Files:**
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs:18-60`
- Modify: `src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs:35-40`
- Modify: `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs` (class doc, constructor, write site)
- Test: `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`

**Interfaces:**
- Consumes: nothing from a prior task — this is the first.
- Produces: `L2ProjectionKeys.ExecutionData(Guid)` is the sole execution-blob key builder, returning
  `skp:data:{guid:D}`. `ProcessedDataHandler`'s constructor becomes
  `(IConnectionMultiplexer, IQueueSender, IProcessorContext, ILogger<ProcessedDataHandler>)` — the
  `IOptions<ProcessorLivenessOptions>` parameter is removed. Task 2 edits the same handler and must
  use the reduced constructor.

- [ ] **Step 1: Rewrite the two write-site tests to expect the new key and no TTL**

In `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`, replace
`WritesTheOutputUnderTheMessageIdSoAReplayRewritesIt` and delete
`WritesWithATtlSoAnOrphanedOutputExpires` entirely, putting this in their place:

```csharp
    [Fact]
    public async Task WritesTheOutputUnderTheMessageIdSoAReplayRewritesIt()
    {
        // The message id is derived, so a redelivered branch lands on this same key and rewrites the
        // same bytes rather than creating a second blob.
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E, """{"number":7}""")), CancellationToken.None);

        await h.Db.Received(1).StringSetAsync(
            L2ProjectionKeys.ExecutionData(M), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
            Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task WritesWithNoExpirySoNothingVanishesBeforeItsSuccessorRuns()
    {
        // This blob IS the successor's input — data:{messageId} is read back as data:{entryId}. An
        // expiry here would delete a workflow's input out from under it if the next step were slow to
        // be dispatched. Reclaim is explicit: the successor's pre hop deletes it, or the orchestrator
        // does after a failed step.
        var h = new Harness();
        TimeSpan? ttl = TimeSpan.MaxValue;
        await h.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Do<TimeSpan?>(t => ttl = t),
                                  Arg.Any<When>(), Arg.Any<CommandFlags>());

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        Assert.Null(ttl);
    }
```

Then replace **every** remaining `L2ProjectionKeys.OutputData(M)` in the file with
`L2ProjectionKeys.ExecutionData(M)` — at the time of writing there are two, in
`IsIdempotentAcrossAReplay` and in the branch-stamping test, but grep for them rather than trusting
that count. Leave every other assertion in those tests untouched.

- [ ] **Step 2: Delete the two TTL-guard tests**

Remove `RefusesATtlThatWouldMakeEveryWriteFail` (the `[Theory]` with `[InlineData(0)]` and
`[InlineData(-1)]`) and `AcceptsTheSmallestTtlThatActuallyWorks` from the same file. They exist only
to guard `ExecutionDataTtlSeconds`, which Step 5 removes. Then change the harness's `Build` to drop
its options parameter:

```csharp
        public ProcessedDataHandler Build() => new(Redis, Sender, Context, Log);
```

and remove the now-unused `using Microsoft.Extensions.Options;` and
`using BaseProcessor.Core.Configuration;` if nothing else in the file needs them.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: compile failure on `Build()`'s arity, and — once that is the only error left — failures in
`WritesTheOutputUnderTheMessageIdSoAReplayRewritesIt` (wrong key: it will report `skp:out:9999…`
where `skp:data:9999…` was expected) and `WritesWithNoExpiry…` (a non-null TTL).

- [ ] **Step 4: Collapse the key builders**

In `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs`, delete the `OutputData` method and the
`OutputDataTtl` method outright, and replace `ExecutionData`'s doc comment with:

```csharp
    /// <summary>
    /// The execution blob key, and the only one. A step's output is written here under its
    /// <c>MessageId</c> and read back by its successor under that same id as the successor's
    /// <c>EntryId</c> — output and input are one blob under one key, so the hand-off is a no-op
    /// rather than a copy.
    /// <para>
    /// <b>No TTL, ever.</b> Reclaim is explicit: the pre handler deletes the key once its author's
    /// transform returns normally, and the orchestrator reclaims after a step that failed. An expiry
    /// here would delete a live workflow's input during a slow hand-off, which is a silent loss —
    /// and loss is the one outcome this design refuses. An unreclaimed key is the orphan sweeper's
    /// problem, not this key builder's.
    /// </para>
    /// </summary>
    public static string ExecutionData(Guid entryId) => $"{Prefix}data:{entryId:D}";
```

Then fix the class-level doc comment at line 20, which lists the namespaces: delete the
`<item><description>OutputData: <c>{Prefix}out:{messageId}</c> …</description></item>` line entirely
and make sure the surviving `ExecutionData` entry reads `{Prefix}data:{guid}` — the blob for both
roles.

- [ ] **Step 5: Remove the dead option**

In `src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs`, delete the whole
`ExecutionDataTtlSeconds` member including its `[ConfigurationKeyName("ExecutionDataTtl")]`
attribute and its three-line doc comment. Nothing in `src/` reads it once Step 6 lands — verify with
`grep -rn "ExecutionDataTtl" src/` at the end of this task, which must print nothing. (Hits under
`references/` are the prior-repo copy and are read-only; ignore them.)

- [ ] **Step 6: Write to the collapsed key with no expiry, and drop the option dependency**

In `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs`:

Remove the `_options` field, the `IOptions<ProcessorLivenessOptions> options` constructor parameter,
its null guard, and the whole `ArgumentOutOfRangeException.ThrowIfLessThan(...)` block with its
comment. The constructor becomes:

```csharp
    public ProcessedDataHandler(
        IConnectionMultiplexer redis,
        IQueueSender sender,
        IProcessorContext context,
        ILogger<ProcessedDataHandler> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _sender  = sender ?? throw new ArgumentNullException(nameof(sender));
        _context = context ?? throw new ArgumentNullException(nameof(context));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }
```

Drop the `using BaseProcessor.Core.Configuration;` and `using Microsoft.Extensions.Options;`
directives if nothing else in the file needs them. Then change the write site:

```csharp
        // When/flags passed explicitly: StackExchange.Redis overloads a bare (key, value, expiry) call
        // between a keepTtl-bool overload and an Expiration-struct overload, and the compiler resolves
        // it to the former — silently a different method than the (expiry, When, CommandFlags) one
        // most call sites (and tests) expect. Naming all five parameters pins the overload.
        //
        // The expiry is null on purpose. This blob is the successor's input, and an expiry would
        // delete a live workflow's input mid-hand-off.
        await db.StringSetAsync(
                L2ProjectionKeys.ExecutionData(p.MessageId),
                p.Data,
                null,
                When.Always,
                CommandFlags.None)
            .ConfigureAwait(false);
```

- [ ] **Step 7: Rewrite the class-doc paragraph that justified the `out:` namespace**

The third paragraph of `ProcessedDataHandler`'s class doc currently begins "**The output goes to the
`out:` namespace, never straight to `data:`.**" and argues the multi-successor case. Replace that
whole paragraph with:

```csharp
/// <para>
/// <b>The output is written to <c>data:{messageId}</c>, which is the successor's input key
/// unchanged.</b> One blob, one namespace, no relocation — the orchestrator hands the id straight
/// through when a step has exactly one successor.
/// </para>
/// <para>
/// <b>That makes multi-successor fan-out the orchestrator's problem, not this handler's.</b> Three
/// successors dispatched against one key means the first one's PRE hop reclaims it and the other two
/// find it absent and return with no result — two branches lost silently. The orchestrator must copy
/// the blob into one key per successor under derived ids, or refcount it. Nothing in this assembly
/// defends against it, by decision rather than by oversight.
/// </para>
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: 0 failures, exactly 6 skips, exit 0, 0 build warnings. The total drops by 3 from the
baseline (two TTL-guard cases plus the deleted expiry test, minus the one added).

- [ ] **Step 9: Verify the option is genuinely dead**

Run: `grep -rn "ExecutionDataTtl\|OutputData" src/`
Expected: no output at all.

- [ ] **Step 10: Commit**

```bash
git add src/Messaging.Contracts/Projections/L2ProjectionKeys.cs \
        src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs \
        src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs \
        src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs
git commit -m "feat: write a step's output to the key its successor reads"
```

---

### Task 2: Move the input reclaim to the pre handler

**Files:**
- Modify: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` (the `RunAsync` tail)
- Modify: `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs` (remove the delete)
- Modify: `src/Messaging.Contracts/Execution.cs` (`ProcessedData`'s doc comment)
- Test: `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`
- Test: `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`

**Interfaces:**
- Consumes: `L2ProjectionKeys.ExecutionData(Guid)` and `ProcessedDataHandler`'s four-parameter
  constructor, both from Task 1.
- Produces: no new public surface. After this task `ProcessDispatchHandler` issues exactly one
  `KeyDeleteAsync` per successful dispatch and `ProcessedDataHandler` issues none.

- [ ] **Step 1: Write the failing tests for the pre handler's reclaim**

In `src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs`, **delete**
`NeverDeletesOrWritesAnything` (around line 121) — the invariant it pins is the one this task
deliberately changes — and add these five tests in its place. The existing `Harness`, `Probe`,
`Body` and `Dispatch` helpers at the top of the file are what they use; do not add new ones.

```csharp
    [Fact]
    public async Task ReclaimsTheInputOnceTheAuthorReturns()
    {
        // The input is finished with only when the author's transform has returned normally, which
        // means every branch it wanted to send was sent.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        await h.Db.Received(1).KeyDeleteAsync(L2ProjectionKeys.ExecutionData(E), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LeavesTheInputAloneWhenTheAuthorThrows()
    {
        // A failed step's input must survive: the orchestrator decides whether to reclaim it, and a
        // reclaim here would destroy the only copy while reporting a business outcome.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => throw new FailedException("author said no"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LeavesTheInputAloneWhenTheInputFailsItsSchema()
    {
        // The author never ran, so the dispatch may yet be re-run against this input.
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"""{"number":"seven"}""");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.False(probe.Ran);
        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ReclaimsNothingForASourceStepButStillRunsTheAuthor()
    {
        // A source step produces its own input, so there is no key — but it is a normal run in every
        // other respect.
        var h = new Harness();
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(Guid.Empty)), CancellationToken.None);

        Assert.True(probe.Ran);
        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LetsAFailedReclaimEscapeRatherThanReportingAFailedStep()
    {
        // The reclaim sits OUTSIDE the catch chain on purpose. Inside it, a Redis fault would be
        // caught by the general catch and reported as StepFailed — a business outcome that never
        // happened, with the delivery acknowledged. Escaping lets the L2 classifier trip the gate and
        // requeue, and the replay is harmless: the same author runs again and sends the same derived
        // message ids, so the post handler rewrites identical bytes.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        h.Db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));
        var probe = new Probe((_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None));

        Assert.Empty(h.Sender.ReceivedCalls());
    }
```

- [ ] **Step 2: Write the failing test for the post handler no longer deleting**

In `src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs`, **delete**
`ReclaimsTheInputKeyFirst` and `LeavesNothingToReclaimForASourceStep`, and add:

```csharp
    [Fact]
    public async Task ReclaimsNothingAtAll()
    {
        // The pre handler owns the reclaim now: it deletes the input once its author's transform
        // returns, which is the only point at which every branch is known to have been sent. A delete
        // here would race the pre hop of a sibling branch's successor.
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }
```

Then fix `IsIdempotentAcrossAReplay` (around line 213): drop its `deleted` capture and its
`Assert.Equal([L2ProjectionKeys.ExecutionData(E), L2ProjectionKeys.ExecutionData(E)], deleted);`
line. Keep every write and `StepCompleted` assertion exactly as they are — those are what the test's
name promises and they still hold.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `ReclaimsTheInputOnceTheAuthorReturns` fails (zero `KeyDeleteAsync` calls received),
`LetsAFailedReclaimEscape…` fails (no exception thrown), and `ReclaimsNothingAtAll` fails (one
`KeyDeleteAsync` received). The other three new pre-handler tests will already pass — they assert an
absence that is currently true for a different reason, and they are there to keep it true.

- [ ] **Step 4: Remove the post handler's delete**

In `src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs`, delete this block from `RunAsync`:

```csharp
        // A source step had no input key to begin with.
        if (p.EntryId != Guid.Empty)
        {
            await db.KeyDeleteAsync(L2ProjectionKeys.ExecutionData(p.EntryId)).ConfigureAwait(false);
        }
```

The `var db = _redis.GetDatabase();` line above it stays — the write still needs it.

Then remove the two class-doc paragraphs that describe the delete: the one opening "**The delete goes
first, and not merely because the input is finished with.**" (its whole ordering argument is moot),
and the clause "the delete no-ops on an absent key" inside the idempotence paragraph. Change the
class summary's first line from "Finishes one branch: reclaim the input, validate the output, persist
it, report the outcome." to "Finishes one branch: validate the output, persist it, report the
outcome."

- [ ] **Step 5: Add the reclaim to the pre handler**

In `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs`, change the `try` that wraps the
author call so it records success, and add the reclaim after the whole `try`/`catch`/`finally`
construct — as the last statements of `RunAsync`:

```csharp
        _processor.BeginDispatch(new DispatchState(
            _sender, d.WorkflowId, d.StepId, self, d.CorrelationId, d.EntryId));

        // Set only on the normal path. Every catch below leaves it false, which is what keeps a failed
        // or cancelled step's input intact for the orchestrator to deal with.
        var ran = false;
        try
        {
            await _processor.ExecuteAsync(data, d.Payload, d.ExecutionId, ct).ConfigureAwait(false);
            ran = true;
        }
```

…leaving all four `catch` clauses and the `finally` exactly as they are, and then, after the closing
brace of the `finally` block:

```csharp
        // The input is reclaimed HERE rather than in the post handler, and only after the author's
        // transform returned normally. A fan-out sends N branches from inside one ProcessAsync; the
        // return is the only signal that all N went out. Reclaiming per branch instead would delete
        // the input after branch 1, so a failed branch-2 send would requeue a dispatch whose input is
        // already gone — the redelivery would read an absent key, take the duplicate-delivery branch,
        // and lose branch 2 silently.
        //
        // Outside the catch chain on purpose: a store fault on this delete must propagate so the L2
        // classifier trips the gate and requeues. Inside the try it would be caught by the general
        // catch and reported as a StepFailed that never happened. The replay is safe — the author
        // re-runs and its branches carry the same derived message ids, so the post handler rewrites
        // identical bytes.
        //
        // Skipped for a source step, which produced its own input and has no key. The author still
        // ran; only the delete is skipped.
        if (ran && d.EntryId != Guid.Empty)
        {
            await _redis.GetDatabase()
                .KeyDeleteAsync(L2ProjectionKeys.ExecutionData(d.EntryId))
                .ConfigureAwait(false);
        }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: 0 failures, exactly 6 skips, exit 0, 0 build warnings.

- [ ] **Step 7: Rewrite `ProcessedData.EntryId`'s doc comment**

In `src/Messaging.Contracts/Execution.cs`, the `ProcessedData` summary's third paragraph currently
reads "`EntryId` is the input key the post handler reclaims. It is carried here rather than deleted
by the pre handler because pre must leave the input intact for any redelivery of itself." Both
sentences are now false. Replace that paragraph with:

```csharp
/// <para>
/// <see cref="EntryId"/> is the input key this branch was produced from. Nothing reclaims it on this
/// hop — the pre handler deletes it once the author's transform returns — so it rides along purely
/// for the log scope, which is what lets a branch's records be traced back to the input that
/// produced them.
/// </para>
```

- [ ] **Step 8: Run the tests once more and commit**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: 0 failures, exactly 6 skips, exit 0.

```bash
git add src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs \
        src/BaseProcessor.Core/Processing/ProcessedDataHandler.cs \
        src/Messaging.Contracts/Execution.cs \
        src/tests/BaseApi.Tests/Processor/ProcessDispatchHandlerTests.cs \
        src/tests/BaseApi.Tests/Processor/ProcessedDataHandlerTests.cs
git commit -m "feat: reclaim a step's input when its author returns, not when its branch lands"
```

---

### Task 3: Record what the orchestrator now owns

**Files:**
- Modify: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` (the absent-key comment)
- Modify: `docs/superpowers/specs/2026-08-20-base-processor-consumers-design.md:296-323` (§7, §7.1)
- Modify: `docs/superpowers/plans/2026-08-20-processor-execution-path.md` (Known Gaps)

**Interfaces:**
- Consumes: the behaviour Tasks 1 and 2 established.
- Produces: documentation only. No code behaviour changes in this task.

This task is not optional polish. Tasks 1 and 2 move a hazard from a place that defends against it to
a place that does not yet exist. If that is not written down, it ships.

- [ ] **Step 1: Tighten the absent-key comment now that nothing expires**

In `ProcessDispatchHandler.RunAsync`, the comment above the `raw.IsNullOrEmpty` return was softened
in an earlier review to say the completion reading is only one possible reading. With no TTL
anywhere, one of its three meanings is gone. Replace the comment with:

```csharp
            if (raw.IsNullOrEmpty)
            {
                // The key was reclaimed, so this dispatch already ran to completion and this is a
                // redelivery. Reporting a failure would overwrite a finished workflow's outcome.
                //
                // Nothing expires — execution blobs carry no TTL — so an absent key cannot mean
                // "timed out"; it means reclaimed or never written. THE ASSUMPTION THIS RESTS ON is
                // that one entry key has one consumer. A step with several successors dispatched
                // against the same key breaks it: the first successor's reclaim makes the others read
                // absent here and return with no result. The orchestrator is what keeps that from
                // arising, by copying the blob per successor under derived ids. See the known gaps in
                // the execution-path plan.
                _logger.LogInformation("entry absent — treating as a duplicate delivery");
                return;
            }
```

- [ ] **Step 2: Rewrite spec §7's numbered steps**

In `docs/superpowers/specs/2026-08-20-base-processor-consumers-design.md`, replace §7's five numbered
steps and the two paragraphs beneath them with:

```markdown
1. **Validate `Data` against the output schema.** Failure → `StepFailed("output failed schema
   validation")` and ack. No blob is written: no successor will read a failed step's output.
2. **Write `L2[data:messageId] = Data`** with no expiry.
3. **Send `StepCompleted`** to `OrchestratorQueues.Result`, carrying `EntryId = MessageId`.
4. Ack.

The post handler reclaims nothing. The input key is deleted by the **pre** handler, once the author's
transform has returned normally — the only point at which every branch of a fan-out is known to have
been sent. Reclaiming per branch would delete the input after the first one, so a later branch's
failed send would requeue a dispatch whose input no longer exists.

Every NACK path replays the whole handler under the same `MessageId` — the write rewrites the same
key with the same bytes and the result send repeats. All idempotent.
```

- [ ] **Step 3: Replace spec §7.1 with the decision that reversed it**

Replace the whole of §7.1 — heading and body — with:

```markdown
### 7.1 One namespace: output is the successor's input

An earlier revision of this spec wrote output to `out:{messageId}` and had the orchestrator relocate
it into one `data:{entryId}` key per successor. That was reversed: post writes `data:{messageId}`,
and the successor reads it as `data:{entryId}` with the same id. The hand-off is a no-op rather than
a copy, and `L2ProjectionKeys.ExecutionData` is the only execution-blob key builder.

**The fan-out objection that motivated `out:` is not refuted — it is reassigned.** A step with three
successors still produces three dispatches carrying one `EntryId`, and the first one's pre hop
reclaims the shared key when its author returns, leaving the other two to read absent and return with
no result. Two branches lost silently.

The processor does not defend against this. The orchestrator must, and owns two duties because of it:

- **More than one successor:** copy the blob into one key per successor before dispatching, under
  ids **derived** the way `DeterministicId` derives everything else. A minted id would fork on
  replay. A step with exactly one successor needs no copy — pass `MessageId` through as `EntryId`.
- **A step that failed:** the pre handler reclaims only after a normal return, so a step ending in
  `FailedException`, `CancelledException` or a framework fault leaves its input key in place. The
  orchestrator reclaims it. Note that `StepFailed` carries no input entry id — `EntryId` is fixed at
  `Guid.Empty` and means *output key* — so the orchestrator must reclaim from its own dispatch
  record, or the contract must gain a field. That choice is open.

**Nothing expires.** Execution blobs carry no TTL: an expiry would delete a live workflow's input
during a slow hand-off, and silent loss is the one outcome this design refuses. Every key is
reclaimed explicitly — by the pre handler, by the orchestrator, or by the orphan sweeper as a
backstop. The cost is that a leaked key leaks until something sweeps it, which is the accepted
direction of the trade: tolerate duplication, never tolerate loss.
```

Then fix the two other spots in the spec that still name the old scheme: the diagram line around
line 38 (`SendToPostAsync ──> write L2[out:messageId]` becomes `write L2[data:messageId]`), and the
bullet around line 132 (`the out: key the next step will read` becomes `the data: key the next step
reads directly`). Search the file for `out:` afterwards to be sure none survive.

- [ ] **Step 4: Add the inherited duties to the execution-path plan's Known Gaps**

In `docs/superpowers/plans/2026-08-20-processor-execution-path.md`, under
`## Known Gaps After This Plan`, add these three bullets and delete the existing bullet that reads
"Nobody relocates `out:{messageId}` into per-successor `data:{entryId}` keys, so a fan-out cannot
actually run yet — spec §7.1", which no longer describes the design:

```markdown
- A step with more than one successor is unsafe until the orchestrator copies its output blob into one
  key per successor under derived ids. All successors currently share one key and the first to run
  reclaims it, so the others read absent and return with no result — two branches lost silently for a
  three-successor step. A single-successor step is safe and needs no copy. Spec §7.1.
- Nothing reclaims the input key of a step that failed. The pre handler deletes it only after a normal
  return, so `FailedException`, `CancelledException` and framework faults all leave it behind, and
  execution blobs carry no TTL to catch it. The orchestrator owns this cleanup; the orphan sweeper is
  the backstop.
- `StepFailed` carries no input entry id — its `EntryId` is fixed at `Guid.Empty` and means *output
  key* — so an orchestrator reclaiming after a failure must do it from its own dispatch record. Adding
  an input-id field to the contract is the alternative. Deliberately left open until the orchestrator
  exists.
```

- [ ] **Step 5: Verify the docs and the code agree**

Run: `grep -rn "out:" src/ docs/superpowers/specs/2026-08-20-base-processor-consumers-design.md docs/superpowers/plans/2026-08-20-processor-execution-path.md`
Expected: no hits describing an `out:` L2 namespace. (A hit inside an unrelated English word such as
"outcome" or "without" is fine — read what you find rather than trusting the count.)

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: 0 failures, exactly 6 skips, exit 0 — this task changed only comments and markdown, so a
change here means something else broke.

- [ ] **Step 6: Commit**

```bash
git add src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs \
        docs/superpowers/specs/2026-08-20-base-processor-consumers-design.md \
        docs/superpowers/plans/2026-08-20-processor-execution-path.md
git commit -m "docs: hand multi-successor fan-out and failed-step cleanup to the orchestrator"
```

---

## Done When

- `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj` reports 0 failures, exactly 6 skips,
  exit 0, and 0 build warnings.
- `grep -rn "ExecutionDataTtl\|OutputData" src/` prints nothing.
- `ProcessedDataHandler` issues no `KeyDeleteAsync` on any path.
- `ProcessDispatchHandler` issues exactly one `KeyDeleteAsync` per successful non-source dispatch,
  and none when the author throws, when the input fails its schema, or for a source step.
- A store fault on the reclaim escapes `HandleAsync` rather than producing a `StepFailed`.
- The output blob is written to `skp:data:{messageId:D}` with a null expiry.
- Spec §7.1 describes the collapsed namespace and names the orchestrator's two inherited duties.

## Known Gaps After This Plan

- Multi-successor fan-out is unsafe until the orchestrator copies per successor. This plan makes the
  hazard reachable by design and documents it; it does not close it.
- Nothing reclaims a failed step's input key. With no TTL, it survives until the orchestrator or the
  orphan sweeper removes it.
- The orphan sweeper is untested against this design — it was written for a store that had TTLs as a
  backstop, and it is now the only backstop.
