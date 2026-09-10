# FileFetcher / ArchiveExpander — the FileReader split

**Date:** 2026-09-10
**Status:** Designed. Not implemented.
**Introduces:** `src/Processor.FileFetcher/`.
**Renames:** `src/Processor.FileReader/` → `src/Processor.ArchiveExpander/`.
**Amends:** `docs/superpowers/specs/2026-09-09-file-reader-design.md`, whose §3 "two stages, one
`ProcessAsync`" and §11 "why not two processors" are both reversed here. That document stays as the
record of why the seam was originally drawn inside one pod; §11 of this one says what changed.
**Depends on:** `BaseProcessor.Core` unchanged. Every decision below lands in author code, a
manifest, or a schema row.

## 1. The decision

> **The FileReader is cut in two along the seam it already had.** `FileFetcher` owns everything dry
> and everything that touches the filesystem: it takes a branch naming an absolute path, admits the
> file against an extension **whitelist** and a size range without opening it, reads it to bytes, and
> sends one branch carrying the file's identity alongside its content. `ArchiveExpander` owns
> everything that involves looking inside: it takes that branch, expands archives recursively to
> `MaxDepth`, and emits the same `{metadata, content}` document FileReader emits today, unchanged.

Both are plain downstream transforms. Neither is an edge — each has an input and produces output —
so neither `BaseImporter` nor `BaseExporter` applies and neither inherits an `ExecutionId` guard.

Each passes through the `executionId` it was dispatched with. No `NewExecutionId()` at either hop:
one dispatch is still one lineage, and the split adds a step to the lineage rather than a lineage to
the workflow.

## 2. Why split at all

Three reasons, in the order they matter.

**The filter is a whitelist now, and a whitelist is a routing decision.** `ExpectedExtension` admits
exactly one extension per step. A feed that drops `.zip` and `.tar` into one directory needs two
steps over the same path, and one of them fails on every file. An array of admitted extensions is
what the requirement actually is, and it belongs in front of the read.

**The two halves have opposite resource profiles.** The dry half is metadata reads and one
`File.ReadAllBytes` — bounded by the file. The expansion half is bounded by what the archive expands
to, which the dry half cannot see. They are sized against different numbers and want different
container limits; today one pod is sized for the worse of the two and the manifest comment says so.

**The filesystem mount leaves the expander.** After the split `ArchiveExpander` performs no file IO
at all. Its `hostPath` volume, and the whole class of "can this pod see that directory" faults, moves
to one pod that exists for exactly that reason.

## 3. What each processor does

### FileFetcher — `FileFetcherProcessor.ProcessAsync`

Never looks inside the file. This is `FileReaderProcessor` above the `builder.Build(...)` call,
lifted whole.

1. **Validate the payload** (§5). Cheapest check, depends on nothing, runs before a path is parsed.
2. **Read the path.** Deserialize `{ "filePath": "..." }` into `FileLocator`; require
   `Path.IsPathFullyQualified`.
3. **Inspect, dry.** `new FileInfo(path)` → exists; extension against the whitelist; `Length` against
   the floor; `Length` against the ceiling.
4. **Read.** `File.ReadAllBytes`.
5. **Emit one branch** — the envelope of §4 — on the dispatch's own execution id.

Step 3's checks all read `FileInfo`, which never opens the file, so **a file that fails them is never
opened at all**. That property is the entire reason this stage exists and it survives the split
intact.

`providerName` remains unread, unvalidated and unrecorded, for the reason the FileReader design
gives: `filePath` is absolute and complete, and adding the field here would put it one edit from an
output document that must not carry it.

### ArchiveExpander — `ArchiveExpanderProcessor.ProcessAsync`

1. **Validate the payload** — `MaxDepth` only (§8).
2. **Read the envelope** into `FetchedFile`.
3. **Build** — `FileContentBuilder.Build(FetchedFile, config)`.
4. **Log** the shape: entry count, depth reached, `MaxDepth`.
5. **Emit one branch**, same execution id.

`FileContentBuilder` is otherwise untouched: the recursion, the signature-based extractor choice, the
expansion budget, the depth accounting, `ArchiveExtractionException`, all of it. §7 lists the two
edits it does take.

## 4. The envelope

The only thing that crosses a hop is one `byte[]` — `ProcessedData.Data`. So the file's identity and
its content travel as one JSON document:

```json
{
  "fileName":    "orders.zip",
  "extension":   ".zip",
  "sizeBytes":   148213,
  "createdUtc":  "2026-09-10T08:31:02Z",
  "modifiedUtc": "2026-09-10T08:31:02Z",
  "content":     "UEsDBBQAAAAIAA..."
}
```

```csharp
internal sealed record FetchedFile(
    string FileName, string Extension, long SizeBytes,
    DateTime? CreatedUtc, DateTime? ModifiedUtc, byte[] Content);
```

**No path.** `fileName` and `extension` only. The path is a location chosen by whoever authored the
workflow, and it already appears nowhere in the output document; carrying it here would put it one
edit away from doing so.

**The identity travels because a consumer needs it, and the cost is one base64.** Raw bytes with no
envelope was considered and is the cheaper wire format — the framework permits it, since
`OutputSchemaId` is `Guid?` and `ProcessorJsonSchemaValidator.TryValidate` returns true on a null
definition without decoding anything. It was rejected: `ArchiveExpander`'s output schema requires
`name`, `extension`, `createdUtc` and `modifiedUtc` on **every** metadata node, and the root node's
five values come only from the `FileInfo` that no longer exists downstream. Raw bytes would force the
root node to carry an empty name and null timestamps, force `minLength: 1` off the output schema, and
strand a downstream step that wants the filename for its own metadata. The envelope keeps the
filename flowing onward *inside the document*, so nothing after `ArchiveExpander` knows an envelope
existed.

**`sizeBytes` travels** because `FileContentBuilder` deliberately uses `FileInfo.Length` and not the
array length for the root node — for the root they agree, and the former is the number already
reported to an operator.

**Both schemas are registered**: `FileFetcher`'s `schema/output.json` and `ArchiveExpander`'s
`schema/input.json`, describing the same document. That restores a validated contract across the new
hop — wiring the wrong upstream into the expander becomes a reported schema failure rather than
arbitrary bytes reaching an extractor. It costs a `JsonDocument` DOM over the envelope at each end,
which is the same cost this system already pays and prices for FileReader's own output today.

## 5. FileFetcher configuration

### Step payload

```json
{
  "allowedExtensions": [".zip", ".tar", ".csv"],
  "minimumSizeBytes": 0,
  "maximumSizeBytes": 33554432
}
```

```csharp
public sealed record FileFetcherConfig(
    IReadOnlyList<string>? AllowedExtensions,
    long MinimumSizeBytes,
    long MaximumSizeBytes) : ProcessorConfig;
```

Bound case-insensitively by `ProcessorConfig.SerializerOptions`, which also ignores unknown
properties, so a field added later does not break workflows authored before it.

`MinimumSizeBytes` — floor, inclusive. Zero disables the check.

`MaximumSizeBytes` — ceiling, inclusive, for **the file on disk**. This is the field's whole meaning
now; the expansion half of its old job is gone from step config entirely (§8).

### Pod option

`FileFetcher__MaxFileSizeBytes`, default 32 MiB, from the `"FileFetcher"` section. What this pod can
survive, as against what a valid file for a feed looks like. A step payload naming more than this is
a rejected payload naming both numbers — **not clamped**, because silently lowering a 100 MB
expectation to 32 MB leaves nothing saying which number won.

## 6. The extension whitelist

Evaluated in `Inspect`, before the size checks and before the file is opened.

| Rule | Behaviour |
|---|---|
| Match | `FileInfo.Extension` against each entry, `OrdinalIgnoreCase` — `.ZIP` matches `.zip` |
| Sentinel | `"*.*"` present anywhere in the array admits everything, short-circuiting |
| Absent, null, or empty array | Defaults to `["*.*"]` |
| Well-formed entry | Must start with `.`, or be exactly `"*.*"` |
| Extensionless file | `FileInfo.Extension` is `""`; admitted only under `*.*` |

**`*.*` is both the default and the fallback**, so a step that says nothing about extensions admits
everything and the field is opt-in. This is the one place in either processor where an absent value
widens rather than narrows, and it is deliberate: the alternative default — admit nothing — makes an
omitted field fail every file with a message about a list the author never wrote.

**`"zip"` and `"*.zip"` are rejected payloads, not silently normalised.** `ExpectedExtension` behaves
this way today, and the house rule throughout this system is to name the wrong value rather than
quietly correct it. `*.*` is the single sentinel, and it is not a glob — no other `*` pattern is
recognised, so `*.z*` is a rejected payload too.

**`*.*` mixed with real entries is accepted and means everything.** `[".zip", "*.*"]` is a redundant
payload, not a wrong one, and rejecting it would be a rule with no failure behind it.

The rejection names the list, so an operator does not have to go and read the step payload:

```
file /mnt/skp-files/in/report.pdf rejected: extension '.pdf' is not in the allowed list (.zip, .tar, .csv)
```

## 7. What changes inside ArchiveExpander

**`Inspect()` and `Read()` are deleted.** Existence, extension matching and both size checks leave
with the config fields that drove them. Every `FileInfo` reference and all file IO goes with them.

**`ReadPath` becomes `ReadEnvelope`.** Same wrapping of `JsonException` — the exception's text quotes
the fragment that failed to parse, and that fragment is upstream content that must not reach a log
store — and the same failed-step message shape. A missing `content` or `fileName` is a rejected
payload.

**`FileContentBuilder.Build(byte[], FileInfo, config)` becomes `Build(FetchedFile, config)`.** The six
values it reads off `FileInfo` at `FileContentBuilder.cs:66-73` come from the record instead. That is
the only edit to the class's body.

**`ExpansionBudget` is constructed from the pod option, not from config** (§8).

**The declared-extension cross-check stays where it is.** `FileContentBuilder.cs:51` — a file *named*
`.zip` whose leading bytes match no known signature is thrown as corrupt rather than recorded as a
plain file, which is the false-HEALTHY case each extractor's internal guard exists to prevent,
reached from outside those guards. It needs the declared extension and the bytes together, and the
envelope carries both, so this is a zero-line change. Moving it into `FileFetcher` was considered:
it would fire one hop earlier and save shipping a corrupt file across the broker, at the cost of
teaching the fetcher about archive signatures. Not worth it while the extension travels.

Its premise shifts by one hop and is worth stating: the check reads "the name declares an archive,
and a workflow author made that claim." The claim used to be `ExpectedExtension` matching; it is now
the fetcher's whitelist admitting the file. Same guarantee, asserted upstream.

**Three of the four failure classes leave.** `BadPayload` stays (for `MaxDepth`). `Rejected` and
`Unreadable` move to `FileFetcher` with their message templates unchanged, so existing operator
queries for `rejected:` and `reading … failed:` keep working — they simply match a different pod.
`ArchiveExpander` keeps only `extracting {fileName} failed:`, which now names the file rather than
the path.

**The output document and `schema/output.json` are unchanged.** Nothing downstream sees the split.

## 8. ArchiveExpander configuration

### Step payload, in full

```json
{ "maxDepth": 1 }
```

`MaxDepth` is unchanged in every respect: absent still means 1, via the positional record's own
default parameter value, which `System.Text.Json` applies to a missing property — so absent arrives
as 1 rather than `default(int)` and an explicit `0` remains a rejected payload. The cap is still
`MaxSupportedDepth = 64`, and it is still what makes the recursion safe by fixing the stack depth
before any archive is opened. The registered output schema is still the other bound on it, and
nothing keeps the two in sync.

### The expansion ceiling is no longer a step field

`MaximumSizeBytes` bounded two different things: the file on disk, and the cumulative size of
everything the archive expands to across every level. The first goes to `FileFetcher`. The second
becomes **`ArchiveExpander__MaxExpandedBytes`**, a pod-level option, default 33554432 — the same
number, so the split preserves today's behaviour exactly.

**It is a pod option because it is a memory guard, not a workflow rule.** The quantity is one an
operator sizes against a container limit; a workflow author has no way to know what a given archive
expands to, and asking them for the number was always asking them to guess. Making it pod-level also
gives the answer to "why two size ceilings" a shape that holds: what a valid file looks like is one
place, the fetcher's step payload; what this pod can hold at once is the manifest.

Everything the ceiling does is otherwise unchanged — **one running total for the whole tree, not one
per level**, charged before each child is built, so the walk stops at the entry that crosses it
rather than after its subtree is materialised. A file that expands past it still fails with the
`extracting {fileName} failed:` template naming both the expanded total and the ceiling, and **not**
with `rejected` — the file itself broke no rule, and an operator searching for a size rejection must
not find a fault that only exists once the archive was opened.

**An OOM here is still a poison message, and that is still why this is a `FailedException`.** The
author never returns, the input key is never reclaimed, RabbitMQ requeues the unacked dispatch, and
the replacement pod dies the same way — one archive taking the processor down for every workflow on
the queue. A `FailedException` is acked and terminal, which is the whole difference.

## 9. Tracing

`ExecutionLogScope.BuildScope` puts `WorkflowId`, `StepId`, `ProcessorId`, `ExecutionId` and
`EntryId` on every record, and `CorrelationKeys.LogScope` adds the correlation id alongside. Because
both processors are transforms passing the dispatch's `executionId` through, **both hops' records
carry the same `ExecutionId` and the same `CorrelationId`**, and one Elasticsearch query spans the
split.

`FileFetcher` logs the file identity that `ArchiveExpander` no longer sees:

```
fetched {FileName} ({Extension}), {SizeBytes} bytes, modified {ModifiedUtc}
```

The **shape**, never the content — a name, a size and a timestamp are safe to log; the bytes are
upstream data and stay out of every template in this system. `ArchiveExpander` keeps its own shape
line: entry count, depth reached, and the `MaxDepth` asked for, both numbers, because a document that
fails its output schema is reported with `EntryId: Guid.Empty`, no payload and no file name, and
nothing in that failure says how deep the document actually went.

Two things to know before writing the join. **`EntryId` names the key a dispatch *read* on one hop
and the key a branch *writes* on the other** — two different keys under one field name — so join on
`ExecutionId`. And **scope the join to the message template**, not to the ids alone: an unscoped
`ExecutionId` join across processors over-counts, which is a mistake already recorded against this
codebase.

## 10. Failure classes, both pods

Neither processor logs a failure. `ProcessDispatchHandler` catches `FailedException` and writes the
author's message verbatim at Information, so a line here would emit every failure twice. The message
text **is** the operator-facing contract.

| Template | Pod | Meaning |
|---|---|---|
| `step payload rejected: {reason}` | both | Malformed or absent step payload, diagnosed before anything else |
| `input branch did not name a file path: {reason}` | FileFetcher | No branch, not JSON, no `filePath`, or a relative one |
| `file {path} rejected: {reason}` | FileFetcher | The file broke a rule — extension, floor, ceiling |
| `reading {path} failed: {reason}` | FileFetcher | Absent, or IO refused it |
| `input branch did not carry a fetched file: {reason}` | ArchiveExpander | Envelope absent, not JSON, or missing `content`/`fileName` |
| `extracting {fileName} failed: {reason}` | ArchiveExpander | Corrupt archive, unrecognised bytes under an archive name, or past the expansion ceiling |

`ArchiveExpander` still catches `ArchiveExtractionException` and nothing wider. Bare `Exception` stays
uncaught deliberately: a `NullReferenceException` in the builder is a programming error, and
reporting it to an operator as a corrupt file buries a bug under a plausible business failure.

## 11. Why this reverses §11 of the FileReader design

That document's §11 rejected a second processor on one specific ground, quoted in full:

> `ProcessedData` carries `(CorrelationId, ExecutionId, WorkflowId, StepId, ProcessorId, EntryId,
> Data)` and nothing else. A downstream step receiving raw file bytes would have no name, extension
> or timestamps — those are `FileInfo` facts only the step holding the path ever sees — so it could
> not build `metadata` at all.

**Every word of that is still true, and §4 is the answer to it.** The objection assumed the second
step would receive *raw file bytes*, and under that assumption it is unanswerable. The envelope
breaks the assumption: `Data` is a `byte[]` the sending author fills with whatever it likes, so the
`FileInfo` facts travel *inside* it. The step holding the path is still the only step that sees a
`FileInfo` — it now writes down what it saw before letting go.

That this was not seen a day ago is not an oversight; it is what happens when a rejected shape is
rejected for a reason that was sufficient at the time. What changed since is that three separate
pressures made the shape worth revisiting:

- **The filter grew from a scalar to a policy.** One `ExpectedExtension` is a parameter. A whitelist
  with a sentinel, a default, and a well-formedness rule is a component, and it is the one thing in
  the pipeline that decides whether work happens at all.
- **`MaximumSizeBytes` acquired a second meaning.** It came to bound the expanded tree as well as the
  file, and the two numbers want different owners — an author and an operator. A single pod could not
  express that; §8 is what expressing it looks like.
- **A downstream consumer now wants the filename as metadata**, which makes the file's identity a
  contract rather than an implementation detail of one processor's document. Once it is a contract it
  is worth a schema, and a schema across a hop is what makes the split cost nothing in clarity.

That §11's *other* rejected shape — a framework hook in `ProcessedDataHandler` — is not revisited and
stays rejected on its own terms. Its fatal objection was that the hook sees no step payload and so
cannot know what the extraction switches on, and that smuggling the state in a field is a live race
because work and post are two independent consumers. Nothing here touches either fact.

The costs are real and are being paid: one more image, one more manifest, one more identity row, one
more hop of broker traffic, and the file's bytes base64'd once more than before.

## 12. Memory

`FileFetcher`, at its 32 MiB ceiling: the raw file bytes, the serialized envelope (~1.33x the file —
base64 is 4 bytes per 3), the broker message body (that envelope base64'd again inside the
`ProcessedData` envelope, ~1.78x), and a `JsonDocument` DOM at output validation, all able to coexist
— and the work and post consumers are the **same process**, so a dispatch and a branch overlap.
That is roughly the profile FileReader has today for a leaf file. **Start at `limits: 512Mi`,
`requests: 256Mi`, and measure.** It is a starting number, not a derived guarantee.

`ArchiveExpander` keeps FileReader's `768Mi` unchanged, because it keeps the quantity that number was
sized against: `MaxExpandedBytes` at the same 33554432. It additionally holds the inbound envelope
and its DOM, which the fetcher's ceiling bounds.

`FileFetcher__MaxFileSizeBytes` and the fetcher's limit move together;
`ArchiveExpander__MaxExpandedBytes` and the expander's limit move together. Do not move one of a pair
without the other.

No intermediate base64 **string** sits alongside any of these figures at either end:
`JsonSerializer.SerializeToUtf8Bytes` and `Utf8JsonWriter.WriteBase64StringValue` write base64
straight into the UTF-8 output buffer, so there is no UTF-16 doubling to add on top.

## 13. Files

### New — `src/Processor.FileFetcher/`

`Processor.FileFetcher.csproj`, `Program.cs`, `ProcessorHost.cs`, `Dockerfile`, `appsettings.json`,
`FileFetcherProcessor.cs`, `FileFetcherConfig.cs`, `FileFetcherOptions.cs`, `FileLocator.cs` (moved),
`FetchedFile.cs`, `ExtensionWhitelist.cs`, `schema/output.json`, `schema/README.md`.

### Renamed — `src/Processor.FileReader/` → `src/Processor.ArchiveExpander/`

Namespace `Processor.FileReader` → `Processor.ArchiveExpander` throughout.
`FileReaderProcessor` → `ArchiveExpanderProcessor`, `FileReaderConfig` → `ArchiveExpanderConfig`,
`FileReaderOptions` → `ArchiveExpanderOptions`. `FileLocator.cs` leaves. `FetchedFile.cs` arrives.
`schema/input.json` arrives. `FileNode.cs`, `FileContentBuilder.cs`, `Extractors/*` and
`schema/output.json` keep their names and, apart from §7's edits, their contents.

### Manifests

`k8s/38-processor-filefetcher.yaml` — new, and it takes the `skp-files` `hostPath` volume, the mount,
and the `docker cp` seeding note verbatim from the FileReader manifest.

`k8s/37-processor-filereader.yaml` → `k8s/37-processor-archiveexpander.yaml`, losing the volume, the
mount, and `FileReader__MaxFileSizeBytes`, gaining `ArchiveExpander__MaxExpandedBytes`. **The
Deployment is renamed, so it must be deleted and applied, not rolled** — `kubectl apply` over a
changed `metadata.name` creates a second Deployment and leaves the first running.

Both images need `kind load`, and **both need their `SourceHash` repointed** — that is required on
every processor rebuild in this cluster, and there are two of them here.

### Database

`ArchiveExpander` needs a processor identity row and an input schema row it did not have.
`FileFetcher` needs a processor row, a config schema row and an output schema row. Every workflow
with a FileReader step must be re-authored as two steps: the payload fields it names no longer exist
on either processor.

**Expect both pods to sit Running/NotReady with zero restarts until their rows exist**, exactly as
every other processor here does. `kubectl rollout status` timing out is the expected signal, not a
fault.

### Tests — `src/tests/BaseApi.Tests/`

`FileReader/` splits. `FileReaderLocatorTests` and the extension/size half of `FileReaderGuardTests`
become `FileFetcher/`, joined by new whitelist tests: each row of §6's table, plus `*.*` mixed with
real entries, plus a rejected `"zip"`, plus a rejected `"*.z*"`. `FileReaderDepthTests`,
`FileReaderDocumentTests`, `FileReaderSchemaTests`, `ProcessorFileReaderTests` and the three extractor
test classes become `ArchiveExpander/`, with their `FileInfo` setup replaced by a `FetchedFile`.
`Fixtures/` moves to the expander. `Live/FileReader/FileReaderLiveTests` becomes two live suites —
the fetcher's needs the mount, the expander's does not.

A new hermetic test asserts the envelope round-trips: what `FileFetcher` writes deserializes into
what `ArchiveExpander` reads, and satisfies both registered schemas. That test is the contract across
the hop, and it is the one thing neither pod can verify alone.

## 14. Naming

`FileFetcher`, because it fetches the bytes for a path. Not `PathDiscovery` — nothing here discovers
or enumerates; it is handed one path. Not `PathResolver` — it does not resolve, it reads.

`ArchiveExpander`, because after the split expanding is the whole job and it performs no file IO, so
"Reader" is actively wrong. Not `ArchiveExtractor` or `FileExtractor`: `IArchiveExtractor`,
`ZipExtractor`, `TarExtractor` and `RarExtractor` already live *inside* it as the per-format pieces,
and keeping "Extractor" for those and "Expander" for the processor keeps the two levels readable.

The inverse transform, when it is built, is **`ArchiveCollapser`** — a node tree in, one byte array
out — with `IArchivePacker` / `ZipPacker` / `TarPacker` as its per-format internals, mirroring the
same two-level rule. Its IO counterpart is `FilePersister`. Neither is in scope here; they are named
now so the set is chosen together rather than one at a time.

| | read side | write side |
|---|---|---|
| IO | `FileFetcher` | `FilePersister` |
| transform | `ArchiveExpander` | `ArchiveCollapser` |
