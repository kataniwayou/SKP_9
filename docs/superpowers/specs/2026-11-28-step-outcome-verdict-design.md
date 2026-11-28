# Step outcome verdict — design

Date: 2026-11-28 · Branch: `feature/acto` · Status: approved 2026-11-28; implemented 2026-11-28

## 1. Intent

A step outcome (`Completed` / `Cancelled` / `Failed`) says **how** a step ended. It does not say **why**. The user wants
every processor to be able to say why, and the operator board to show it: when one step's outcomes have more than one
reason, that step's bin is **stacked by outcome + verdict**, and the parts always add up to the step's outcome count.

Example, 24 outcomes of one step in one bin:

| Part | Count |
|---|---|
| Completed:Listed | 6 |
| Cancelled:Unlisted | 12 |
| Cancelled:Duplicated | 6 |

That bin is the full story of what the processor did with those 24 items.

### Two things that must not be confused

| | Check log | Outcome verdict |
|---|---|---|
| What | one record per check the author makes (e.g. each whitelist lookup) | the reason the author gives for the step's outcome |
| How many | 0..n per item | **0 or 1 per outcome** |
| Who writes it | the author, in its own code (today: `RedisFieldWhitelist` → `WhitelistVerdict`) | the framework, on the outcome record, with the author's value |
| Counted in bins | no | yes |
| Explains | which list / which rule answered (`WhitelistRoot`, `WhitelistValue`) | why this outcome happened |

Example: a processor checks two whitelists. Listed in WL1 → check WL2 → listed → `Completed` with verdict `Listed`.
Unlisted in WL1 → `Cancelled` with verdict `Unlisted`. Either way it is **one outcome counted once**; the outcome verdict
does not say which list decided, and must not — the check logs say that.

## 2. Rulings (from the user, 2026-11-28)

1. **The author decides** the verdict of each outcome, or gives none. The framework never derives, checks or overrides
   a verdict's meaning.
2. **An outcome without a verdict is normal.** A step that never gives verdicts keeps a plain outcome bin.
3. **New verdict reasons must not change the framework.** Each processor owns its own vocabulary.
4. **Kibana: one legend entry per stacked part is accepted** (`sk-normalizer-sample · Completed:Listed`, …). One legend
   entry per step is not required in Kibana.

## 3. Goals, non-goals, anti-goals

**Goals**
- An author can attach a verdict to every outcome it reports: each `SendToPostAsync` branch (`Completed`), and
  `CancelledException` / `FailedException`.
- The verdict lands on **the same log record as `Result`**, as `attributes.Verdict` (the value) and
  `attributes.VerdictKind` (its enum type), so counting outcome records counts outcomes and the stack parts add up by
  construction.
- Verdict values come from an author-owned enum and are written by name (`ToString()`), never hand-typed.
- The pilot dashboard stacks the Acme bar by `Result` + `Verdict` from outcome records only.

**Non-goals**
- Putting the verdict on the wire. `StepOutcome` is unchanged; the orchestrator neither sees nor needs it.
- Routing on a verdict. Successors are entered by `StepResult` only.
- A framework-wide catalogue of verdicts.
- Changing or removing the whitelist check log (`WhitelistVerdict`). It stays as the diagnostic record.

**Anti-goals** (things this design must make impossible or loud)
- Two verdicts on one outcome.
- A verdict on a record that is not an outcome record (it would be counted as an extra part).
- A verdict stored as a number (`0`, `1`): it would make every board unreadable and silently split on a reorder.
- A verdict that changes which successor runs.

## 4. Today (verified 2026-11-28)

- `Messaging.Contracts/OutcomeLogScope.cs` builds the `Result` scope from `StepResult.ToString()`. It is a log-scope
  helper only; the type also lives beside the wire contracts, which is why the `Messaging.Contracts` project is touched.
- Outcome records the processor writes, one per outcome, all scoped with `OutcomeLogScope`:

  | Outcome | Where | Record |
  |---|---|---|
  | Completed (per branch) | `BranchFinisher.RunAsync` | `branch completed in {ElapsedMs}ms` |
  | Failed, output schema | `BranchFinisher.RunAsync` | `output failed its schema …` |
  | Failed, input schema | `ProcessDispatchHandler` | `input failed its schema …` |
  | Failed, author | `ProcessDispatchHandler` (catch `FailedException`) | `the author reported the step failed: {Reason}` |
  | Cancelled, author | `ProcessDispatchHandler` (catch `CancelledException`) | `the author cancelled the branch: {Reason}` |
  | Failed, transform fault | `ProcessDispatchHandler` (general catch) | `the transform faulted …` |
  | Failed, no branch sent | `ProcessDispatchHandler` | `the step returned without sending a branch …` |

- The orchestrator writes its own `Result`-bearing lines; the boards already exclude them
  (`not resource.attributes.service.name:"orchestrator"`).
- In Elasticsearch, `attributes.Result` and `attributes.WhitelistVerdict` are dynamically mapped `keyword`.
  `attributes.Verdict` and `attributes.VerdictKind` will map the same way.
- The current pilot (`lens/skp-pilot-verdict-bins`) stacks Acme by `WhitelistVerdict`, i.e. by **check logs**. In the
  last 30 minutes: 2158 `Completed` outcome records with no verdict and 2158 `Listed` check records with no `Result`.
  They match only because Acme makes one lookup per item and nothing failed. Two lookups per item would double the
  stack; a blank artist (cancelled before any lookup) is missing from it.

## 5. Design

### 5.1 Author API (`BaseProcessor.Core`)

```csharp
// BaseProcessor — a Completed branch with a verdict. The existing overload stays and means "no verdict".
protected Task SendToPostAsync(byte[]? processedData, Guid executionId, CancellationToken ct);
protected Task SendToPostAsync(byte[]? processedData, Guid executionId, Enum verdict, CancellationToken ct);

// ProcessStatusException and both subclasses — an optional verdict.
public abstract class ProcessStatusException : Exception
{
    public Enum? Verdict { get; }
}
public sealed class CancelledException
{
    public CancelledException(string message, Exception? innerException = null);
    public CancelledException(string message, Enum verdict, Exception? innerException = null);
}
public sealed class FailedException   // same two constructors
```

Author code, e.g. Acme:

```csharp
public enum ArtistVerdict { Listed, Unlisted }

throw new CancelledException($"artist '{artist}' is not on this workflow's whitelist", ArtistVerdict.Unlisted);
await SendToPostAsync(document, executionId, ArtistVerdict.Listed, ct);
```

**Why `Enum`, not `string`.** It forces the value to be a member of an author-owned type, and its name is what gets
written. A `string` would let every call site type its own spelling — the drift `OutcomeLogScope` already rules out for
`Result`.

**Why not a generic `TVerdict`.** The exceptions are caught by type in `ProcessDispatchHandler`; a generic exception
cannot be caught without knowing the type argument. `Enum` works the same on both paths.

### 5.2 Validation (framework, at the hand-over)

- `Enum.IsDefined(verdict.GetType(), verdict)` must be true. An undefined value (`(ArtistVerdict)7`) or a `[Flags]`
  combination would be written as `7` or `Listed, Unlisted`.
  - On `SendToPostAsync`: throw `ArgumentException` inside the dispatch, so the step reports **Failed with no verdict**
    and the log names the cause (the same treatment as `Guid.Empty`).
  - On an exception: the outcome the author asked for is kept, the verdict is dropped, and one Warning names the bad
    value. The author's outcome is more important than its label.
- No other rule. The framework does not know what any value means.

### 5.3 Carrying it to the outcome record

- **Completed.** `SendToPostAsync` passes the verdict to `IBranchSink.FinishAsync(branch, verdict, ct)`. `BranchFinisher`
  scopes the `branch completed` record with it. `ProcessedData` is unchanged.
  - Fan-out: each branch is its own outcome and carries the verdict given on its own `SendToPostAsync`.
  - If that branch then fails its **output schema**, the outcome becomes Failed **without** the verdict: the author's
    verdict was the reason for a completion that did not happen.
- **Cancelled / Failed by the author.** `ProcessDispatchHandler` reads `ex.Verdict` and scopes the existing record with
  it.
- **Failed by the framework** (input schema, transform fault, no branch sent, bad verdict value): **never** a verdict. The
  author did not decide these; they appear as `Failed` with no verdict, a part of their own.

### 5.4 Log scope (`Messaging.Contracts/OutcomeLogScope.cs`)

```csharp
public const string Verdict     = "Verdict";
public const string VerdictKind = "VerdictKind";

public static IReadOnlyDictionary<string, object> BuildScope(StepResult result, Enum? verdict)
    => verdict is null
        ? BuildScope(result)
        : new Dictionary<string, object>
        {
            [Result]      = result.ToString(),
            [Verdict]     = verdict.ToString(),          // e.g. "Unlisted"
            [VerdictKind] = verdict.GetType().Name,      // e.g. "ArtistVerdict"
        };
```

- One builder for all three fields, so a record cannot get a verdict without a `Result`, nor a `Verdict` without its
  `VerdictKind`.
- **Both values come from the author's one enum value.** The author passes `ArtistVerdict.Unlisted` and nothing else;
  the framework reads the value's name and its type's name. The author never types either string.
- `VerdictKind` is the type's **simple name** (`ArtistVerdict`), not its namespace-qualified name: it is a label for a
  board, and a namespace move must not split history. Two processors may each define an `ArtistVerdict`; they are told
  apart by `StepName`/`ProcessorName`, which every record already carries.
- **What `VerdictKind` is for:** filtering and grouping by mechanism (`VerdictKind:"DedupVerdict"` — every dedup
  outcome whatever its value), and telling apart two enums that share a value name (`Released` in two mechanisms of one
  step). The stacked bin itself still counts `Result` + `Verdict`.
- Renaming an enum type now splits history the same way renaming a value does (§5.6).
- `ToString()` only — same reasoning as the existing `Result` remarks.
- Scoped, not templated: `body.text` of every outcome line is unchanged, so existing saved queries keep matching.

### 5.5 What does not change

- `StepOutcome`, `StepResult`, the orchestrator, routing, `ProcessedData`, the RabbitMQ transport.
- Every processor that never passes a verdict: same records, same fields. The overloads without a verdict stay.
- The whitelist check log (`WhitelistVerdict`, `WhitelistRoot`, `WhitelistValue`) and the whitelist donut.

### 5.6 Adding a verdict reason later

| Change | Framework | Processor | Dashboard |
|---|---|---|---|
| New value on an existing enum | none | add the member, pass it, test it | none — a new part appears |
| A second verdict mechanism in the same step (e.g. dedup) | none | its own enum; still one verdict per outcome | none |
| A verdict in another processor | none | as above | one stacked layer for that step (§6) |

Never rename or remove a value, or rename an enum type, already in use: history and new data would show as two parts
(or two kinds).

## 6. SKNormalizer adoption (first author)

- `AcmeHandler.Augment` throws `CancelledException(…, ArtistVerdict.Unlisted)` on a miss.
- The blank-artist case stays as it is today — a `CancelledException` **with no verdict** (Q1; the code cancels here,
  it does not fail). `ArtistVerdict` is therefore `Listed` and `Unlisted` only.
- Completed: the verdict is decided inside the pipeline (`NormalizationPipeline` → handler) but sent in
  `SKNormalizerProcessor` (`SendToPostAsync`). Each handler declares `IProviderHandler.CompletedVerdict` (base: `null`;
  Acme: `ArtistVerdict.Listed`, because completing means every artist passed the gate). The pipeline copies it into
  `NormalizationResult.Verdict` and the processor passes it on.
- `RedisFieldWhitelist` keeps logging its check records unchanged.

## 7. Dashboard

**Pilot (`lens/skp-pilot-verdict-bins`, built by `make_pilot.py`).** *Deleted 2026-11-28 after it was applied to the original; kept here as the record of how the design was reached.* The Acme layer changes source and breakdown:

- Query (the chart's own, shared by every layer): `attributes.Result:* and not resource.attributes.service.name:"orchestrator"`
  — outcome records only.
- Acme layer split (built 2026-11-28): Lens *Top values* on `StepShort` with `include` = `sk-normalizer-sample`, then
  `attributes.Verdict` (multi-terms), size 10, missing bucket on, **no "Other" bucket**. The legend reads
  `sk-normalizer-sample › Unlisted`. **The outcome is not in the label** (the user, 2026-11-28). For Acme each
  verdict has one outcome (Listed = Completed, Unlisted = Cancelled). The accepted cost: every outcome without a
  verdict (blank-artist Cancelled, framework Failed) shares one `(missing value)` part. The step is chosen by `include`, not by a filter on the
  count column. Each stacked part is its own series, so it needs its own legend entry; the step name alone cannot
  tell the parts apart.
- `StepShort` is a keyword runtime field on the `skp-logs` data view: `attributes.StepName` cut at the first `_`
  (the version suffix). It is computed at query time, so it covers old records as well. It is in the export with the
  data view (see *Applied to the original*).
- Series type stays `bar_stacked`; the other steps stay plain `bar`.
- The chart's query drops `or attributes.WhitelistVerdict:*`.
- **Only the Acme layer has a breakdown.** The other steps are one count column per step, each filtered to its
  `attributes.StepName` and labelled with the short step name, with column ids unique across layers. Lens appends
  ` - <metric name>` to every legend entry once two or more layers have a breakdown
  (`getSeriesName`, `multipleLayersWithSplits`), and that is where the old ` - Count of records [n]` suffix came
  from. The y-axis title is set explicitly to `Count of records`.
  A second stacked step therefore costs that suffix back, unless its layer is combined with Acme's.

**Applied to the original (2026-11-28).** `lens/skp-outcomes-bins` (*Step outcomes over time* on
`skp-operator-outcomes`) now carries the verdict stack, and it stays generic over workflows. The pilot's hardcoded step
list worked for one workflow version only, and the Workflow dropdown serves about 50.

- **`layer1`** (the original layer): Top values on `StepShort` ordered by first seen, size 20, with `exclude` =
  the verdict steps. Count labelled `outcomes`.
- **`layer_verdicts`**: `StepShort` with `include` = the verdict steps, then `attributes.Verdict`, `bar_stacked`.
  Count labelled `verdicts`.
- **The legend suffix is accepted** (the user chose it over unstacked bars or a Vega chart):
  `split-importer - outcomes`, `sk-normalizer-sample › Listed - verdicts`. Two layers with a breakdown always get
  ` - <metric label>`, and an empty label becomes Lens's placeholder title (`getSafeLabel`), so the suffix cannot be
  removed. Distinct labels avoid the ` [n]` dedup.
- **Nothing else changed:** the dashboard object, the other four panels and the controls are untouched. Only the lens
  object and the data view's runtime field are new, and both are in `kibana/kibana-export.ndjson`. The live originals
  before the change are in the session scratchpad (`bins-live-before-apply.json`, `dash-live-before-apply.json`).
- **Adding a verdict step:** add its short name to `layer1`'s `exclude`, and give it **its own** stacked layer, copied
  from `layer_verdicts` with its own column ids. In one stacked layer, every series in a time bucket stacks into one
  bar, so two steps sharing `layer_verdicts` would be piled onto one bar.

**Limit of Lens.** A stacked bar per step needs its own layer, so a **new step** that starts giving verdicts needs one
new layer. A **new value** on an existing step needs nothing. A fully generic board (every step stacked by its own
verdicts with no per-step layer) needs the Vega panel or a custom chart.

**Invariant check.** For every step and bin, the sum of the stack equals that step's count in the original
`skp-outcomes-bins` panel. Add this to `tools/verify-kibana-dashboard.py`.

## 8. Tests

`src/tests/BaseApi.Tests` (note: the local .NET test runner is blocked by App Control; run in CI or the cluster
pipeline):

- `OutcomeLogScope`: `Verdict` and `VerdictKind` present only when a verdict is given, always together; `Verdict` is
  the value's name and `VerdictKind` the enum type's simple name; never without `Result`.
- `ProcessDispatchHandlerTests`: Cancelled and Failed with a verdict → the outcome record carries it; without → absent;
  undefined value → outcome kept, verdict dropped, one Warning.
- `BranchFinisher` / `SendToPostAsync`: Completed with a verdict; fan-out with different verdicts per branch; output
  schema failure drops the verdict; undefined value → Failed, no verdict.
- Framework-caught failures never carry a verdict.
- No record other than the outcome record gets `Verdict` (scope does not leak into later lines of the dispatch).
- SKNormalizer: `AcmeHandlerTests` assert the verdict on the cancel; pipeline/processor tests assert Listed on
  completion; `WhitelistVerdictLoggingTests` unchanged.

Live check after rollout: query ES for `sk-normalizer-sample*` outcome records grouped by `Result` × `Verdict`, run the
approved and unapproved feeds, compare with the pilot.

## 9. Rollout

1. `Messaging.Contracts` + `BaseProcessor.Core` (additive; existing processors compile and behave unchanged).
2. SKNormalizer adopts verdicts; rebuild and redeploy its image only.
3. Update the pilot (`make_pilot.py`) and the dashboard check script.
4. Old data has no `Verdict`; the pilot shows those outcomes as plain `Result` parts until they age out.

## 10. Decided questions (the user, 2026-11-28)

- **Q1. Blank artist in Acme keeps today's outcome with no verdict.** Today's outcome is `Cancelled` (checked in
  `AcmeHandler.Augment`), so it shows as a plain `Cancelled` part, apart from `Cancelled:Unlisted`.
- **Q2. `VerdictKind` is written** next to `Verdict`: the simple name of the author's enum type, read by the framework
  from the same value (§5.4). No author code beyond passing the value.
- **Q3. The orchestrator does not carry the verdict.** `StepOutcome` stays without it; the boards count processor records.
- **Q4. The pilot stays out of `kibana/kibana-export.ndjson`.** It lives only in Kibana, built by `make_pilot.py`.
  Its result was later applied to the original chart, which is exported (see *Applied to the original*).
