# FileReader — Design

**Date:** 2026-09-09
**Status:** Implemented 2026-09-09, in `src/Processor.FileReader/`. Amended during
implementation where measurement contradicted the design — each correction is marked in place.
**Introduces:** `src/Processor.FileReader/`, the fourth concrete processor and the first that reads
the filesystem.
**Depends on:** `BaseProcessor.Core` unchanged. Every decision below lands in author code, a manifest,
or a schema row.

## 1. The decision

> **FileReader turns a file path into one structured document of metadata and content.** It receives
> a branch naming an absolute path, checks the file *dry* — extension and size, from `FileInfo`,
> without opening it — reads it to bytes, expands it one level if it is an archive it knows, and
> sends a single branch carrying `{metadata, content, entries}` on the dispatch's own execution id.

It is a plain downstream transform. It is **not** an edge: it has an input and it produces output, so
neither `BaseImporter` nor `BaseExporter` applies and neither `ExecutionId` guard is inherited.

## 2. Why one branch, and not one per entry

`SendToPostAsync` is called **once**, with the `executionId` the dispatch arrived on, passed through
unchanged. No `NewExecutionId()`. An archive of forty entries is still one branch; the entries nest
inside the document.

Fanning out per entry has no correct form here. Reusing one execution id across forty branches makes
the lineage joins count forty where they expect one. Minting forty fresh ones inside an existing
lineage orphans it — an execution id is opened by a *source* step, which this is not. Nesting is the
only shape that keeps one dispatch equal to one lineage.

## 3. Two stages, one `ProcessAsync`

The separation is a class boundary inside the processor, not a second processor and not a framework
seam. §11 records why both of those were rejected.

### Stage 1 — `FileReaderProcessor.ProcessAsync`, dry

Never looks inside the file.

1. Parse the input bytes as JSON into `FileLocator`; read `filePath`, an absolute path.
2. `new FileInfo(filePath)`. Absent → fail.
3. Extension against `ExpectedExtension`, case-insensitive → fail on mismatch.
4. `Length` against `MinimumSizeBytes` and the effective ceiling (§6) → fail outside.
5. `File.ReadAllBytes`.

Steps 3 and 4 read `FileInfo` **before** step 5, so a file that fails them is never opened. That is
the point of the stage being dry: the cheapest failures happen before the expensive work.

**`providerName` is not read, not validated, and not recorded.** The org's Kafka records carry it and
it is redundant here — `filePath` is absolute and complete. It appears nowhere in the output.

### Stage 2 — `FileContentBuilder`

Handed `(byte[] bytes, FileInfo info, FileReaderConfig config)`. Owns everything that involves
looking inside the file.

6. Resolve an `IArchiveExtractor` by the file's own **leading bytes**. None matches → the file is a
   leaf, unless its name declared an archive (see below).
7. Expand recursively until `MaxDepth` is reached or nothing left is an archive, whichever comes
   first. Each entry becomes a node with its own metadata and content, and is itself a candidate for
   expansion.
8. Build the document.

**`ExpectedExtension` admits; the signature chooses.** Those were one job and are now two. The old
resolution — extractor by declared extension — worked only because the top-level file has a
declaration the processor had already validated. Nested entries have none: an entry's name is a
string written by whoever built the archive, and below the first level there is nothing to check it
against. The signature answers at every depth, so it is what dispatches.

**The top level keeps one use for the declaration, and it is a corruption check.** Signature-only
dispatch would make a damaged zip a leaf carrying its raw bytes, and the step would report Completed
over a file nobody can open — the false-HEALTHY failure §7 builds guards against, arrived at from
outside those guards, because a corrupt header is never shown to an extractor at all. So a top-level
file whose name declares an archive and whose bytes are no archive at all fails the step. It asks
whether the bytes are *an* archive, not whether they are the named one: a tar called `.zip` is read
as a tar, because reading the content is a more useful answer than refusing the name. Nested entries
get no such check, and an entry called `.zip` that is not one is simply a leaf — otherwise whoever
built the archive would decide whether this processor succeeds.

**The structure is hard-coded in this class. The output schema does not drive it and is not read
here.** The schema judges the result one hop later; it never shapes it.

`ProcessAsync` then calls `SendToPostAsync(documentBytes, executionId, ct)` and returns.

## 4. What the framework does next

`ProcessedDataHandler` — `internal sealed`, on the processor's own `processor-{id}-post` queue,
consumed by the same pod on a second consumer — validates the output schema against **exactly** those
bytes, writes them to `L2[EntryId]` with no expiry, and sends `StepOutcome.Completed`.

There is no code between the send and the validation. That is the fact that decided §3 and §11.

## 5. The document

```json
{
  "metadata": { "name": "orders.zip", "extension": ".zip", "sizeBytes": 40219,
                "createdUtc": "2026-09-08T11:02:14Z", "modifiedUtc": "2026-09-08T11:02:14Z",
                "entryCount": 3 },
  "content": [
    { "metadata": { "name": "a.csv", "extension": ".csv", "sizeBytes": 118,
                    "createdUtc": null, "modifiedUtc": "2026-09-08T10:58:00Z", "entryCount": 0 },
      "content": "aWQsbmFtZQo..." }
  ]
}
```

- **Identical node shape at every level**, and it is `{metadata, content}` — two keys, not three.
- **`content` is one key holding one of three things:** a base64 string (a file's bytes), an array of
  nodes (what an archive expanded to), or `null` (an archive that expanded to nothing). An expanded
  archive never carries its own bytes as well — that doubles the blob for no consumer.
- **It was `content` plus `entries`, and collapsing them is deliberate.** The pair encoded the
  leaf/archive distinction twice — null content *and* empty entries — so nothing stopped the two
  from disagreeing. `FileContent` is a closed hierarchy, which makes the illegal states
  unrepresentable, and `FileNodeConverter` renders it as one JSON value. A hand-written converter
  rather than `[JsonDerivedType]`, whose `$type` discriminator would leak a serializer detail into a
  contract other systems read.
- **`null` means no entries, not "this is an archive".** An archive that was *not* opened — the depth
  limit stopped it, or nothing recognised the format — carries its own bytes like any other file,
  because an unexpanded archive is a file.
- **Depth is `MaxDepth`, and it defaults to 1.** At the default a zip inside a zip is a leaf,
  recorded with its bytes and metadata, exactly as before this field existed. Raising it is a
  decision taken against the registered output schema, not alone — see §8.
- Metadata is `FileInfo` only. Archive entries carry `createdUtc: null` where the format records none.
- **camelCase**, pinned explicitly in the document serializer. `MessagingJson`'s PascalCase governs
  the `ProcessedData` envelope, not the bytes inside `Data`, and getting that wrong is exactly what
  the schema catches.

**`content` is base64 and that is not avoidable.** JSON has no binary type. It costs an inner 1.33×
on top of the envelope's own base64 — `System.Text.Json` renders `byte[]` as base64 already — so the
document travels at roughly 1.78× the file on the broker and sits at 1.33× in Redis. The only escape
is a non-JSON container in `Data`, which forfeits output schema validation entirely, and the schema is
where the entry-count rule now lives (§8). The encoding cost is accepted; §6 is what bounds it.

## 6. Configuration

```csharp
public sealed record FileReaderConfig(
    string ExpectedExtension,   // ".zip" — leading dot, case-insensitive
    long   MinimumSizeBytes,    // 0 disables
    long   MaximumSizeBytes,    // read-time ceiling, per step; ALSO the expansion ceiling
    int    MaxDepth = 1         // levels of archive to expand; absent means 1
) : ProcessorConfig;
```

**`MaxDepth`'s fallback is the parameter's own default, and that was verified rather than assumed.**
`System.Text.Json` applies a C# default parameter value when a positional record's property is
missing from the payload, so an omitted field arrives as `1` and not as `default(int)`. A nullable
was drafted first on the opposite assumption and dropped once measured: absent is 1, an explicit `0`
stays `0` and is a rejected payload, as is anything above `MaxSupportedDepth` (64).

**It has no pod-level twin, and that is the ruling.** `MaxFileSizeBytes` exists because bytes cost
memory and an operator must bound them per environment. Depth costs nothing on its own — the bytes it
reaches are already bounded by `MaximumSizeBytes`, which is one running total across the whole tree —
so a `FileReader__MaxDepth` would guard a thing already guarded. The 64 cap is a stack bound, not a
memory one.

A null payload is a `FailedException`, not a set of defaults. There is no meaningful default
extension, and inventing one would have this processor accept files nobody asked for — the same
argument the PathImporter design makes for its topic.

**`ExpectedEntryCount` is deliberately absent.** Entry count moved to the output schema (§8). It is
the one expectation only knowable *after* the archive is opened, so checking it in config saves
nothing; extension and size are knowable from `FileInfo` and stay here, because checking them early is
what stops the read.

### Two ceilings, meaning different things

```csharp
public sealed class FileReaderOptions            // bound from the "FileReader" section
{
    [ConfigurationKeyName("MaxFileSizeBytes")]
    public long MaxFileSizeBytes { get; set; } = 33_554_432;   // 32 MB
}
```

`services.Configure<FileReaderOptions>(cfg.GetSection("FileReader"))`, injected as
`IOptions<FileReaderOptions>`. In the manifest, `FileReader__MaxFileSizeBytes` — the pattern
`Kafka__BrokerList` has used since the broker moved to configuration (1bc5c7f).

**The env var is what this pod can survive. `MaximumSizeBytes` in the payload is what a valid file for
this feed looks like.** A step payload naming more than the pod ceiling is a **config error and fails
the step by name** — not silently clamped, because clamping means the workflow author asked for 100 MB,
got failures at 32, and nothing said why. The effective ceiling is always the payload's, with the
pod's acting as an admission check on it.

The default lives in code so an unset variable is never unbounded.

**Memory is why this is a manifest value.** A 32 MB file does not cost 32 MB in flight. What
coexists is the raw file `byte[]`, the serialized UTF-8 document at ~1.33x the file, the broker
message body — that document base64'd *again* inside the `ProcessedData` envelope, ~1.78x — and, at
validation in the post handler, a full `JsonDocument` DOM over it. The work and post consumers are
the *same process*, so a dispatch and a branch overlap.

### The ceiling bounds the expansion too, and one term of it is still unbounded

**`MaximumSizeBytes` bounds the archive's expanded content as well as the file** — added during
implementation, because the paragraph above priced only the leaf case. An archive's document is
~1.33x its *expanded* content, not its file size, so an ordinary 10:1 CSV zip at a 32 MiB ceiling is
~320 MB expanded before the document and envelope are built at all. `FileContentBuilder` accumulates
expanded bytes as entries are read and fails with the `extracting` template naming both numbers.

**Why an OOM here would be worse than a failed step.** The author never returns, so
`ProcessDispatchHandler` never reclaims the input key; RabbitMQ requeues the unacked dispatch; the
replacement pod reads the same key and dies identically. That is a poison message, and it takes the
processor down for every workflow on its queue, not just the one that sent the file.

**One term remains unbounded, and it is recorded rather than fixed.** `IArchiveExtractor.Extract`
returns a materialised list, so every entry's bytes exist before the builder can check anything — the
bound aborts before the document and envelope are built, which is most of the cost at ordinary
compression ratios, but the extractor's own peak is not capped. A high-ratio archive is still
reachable poison. **The fix is to move the ceiling into the seam** — `Extract(Stream, long
maxExpandedBytes)`, with each extractor totalling as it reads — roughly four lines per extractor and
one interface change. An implementation note claiming this needs an iterator, and that C# forbids
`yield return` inside a try/catch so it cannot be done, is **wrong on the second half**: the manual
enumerator form puts the `yield return` outside the try and compiles. Recorded here so the next
person does not re-derive the wrong constraint.

**An earlier draft of this paragraph also listed "the base64 string during serialization", and there
is no such string.** `JsonSerializer.SerializeToUtf8Bytes` encodes a `byte[]` straight into its UTF-8
output buffer; nothing materialises base64 as a managed `string`, so there is no UTF-16 doubling to
budget for. Corrected 2026-09-09 during implementation and confirmed by measuring allocations against
a deliberate `Convert.ToBase64String` control. The claim is recorded because the wrong version of it
is the kind a reader would reason from when tuning the ceiling. That is comfortably over 200 MB transient against the
`384Mi` limit the other processors carry. **FileReader's manifest gets a higher limit, or its ceiling
is set well under 32 MB.** Being a manifest value is what lets that be tuned per environment without a
rebuild.

## 7. Extractors

```csharp
public interface IArchiveExtractor
{
    string Extension { get; }
    bool CanHandle(ReadOnlySpan<byte> header);
    IReadOnlyList<ExtractedEntry> Extract(Stream archive);
}
```

Resolved by signature, registered in the container. `Extension` is *not* how one is chosen — it
serves only the top-level corruption check in §3. **Tar is the awkward one:** it has no signature at
offset zero, its `ustar` marker sits at byte 257, so it needs 262 bytes where zip needs four. A
buffer shorter than a signature is answered `false` rather than thrown on — a two-byte file is a
legitimate leaf. **ZIP, TAR and RAR.** ZIP and TAR run on in-box
`System.IO.Compression` and `System.Formats.Tar`. RAR needs a package, and that package is the only
dependency this whole design adds.

### RAR costs one file in the offline feed

`NuGet.config` clears nuget.org — every restore resolves from repo-local `nugets/` — so a new package
is a deliberate act, not a `PackageReference`. **SharpCompress 1.0.0** was checked against that
constraint and passes cleanly:

- MIT licensed, and `lib/net8.0/SharpCompress.dll` ships in the package.
- **Its `net8.0` dependency group is empty.** The .NET Framework and netstandard2.0 groups pull four
  compatibility packages; net8.0 pulls none. So the feed gains exactly `sharpcompress.1.0.0.nupkg`
  and nothing else — no transitive tree to vendor alongside it.

The work is: drop the `.nupkg` into `nugets/`, add a `PackageVersion` to `Directory.Packages.props`,
`PackageReference` it from `Processor.FileReader` alone, and regenerate that project's lock file.
`NuGetAudit` is promoted to a build error in this repo, so a restore is what proves the pin is clean —
that check belongs in the plan's first task, before any extractor code is written, because a failed
audit changes the version rather than the design.

**SharpCompress reads RAR and does not write it**, and solid archives are only partly supported. That
is sufficient — this processor never writes an archive — but it decides how RAR is tested (§12).

### An archive library reporting nothing is not an archive containing nothing

**Both `System.Formats.Tar` and SharpCompress will open a corrupt archive, report success, and
enumerate zero entries.** Measured during implementation, not assumed:

- `TarReader` inspects only the first 512-byte block and treats an all-zero one as the terminator
  without reading further — so a zeroed header followed by garbage yields no entries and no
  exception.
- `RarArchive.Open` succeeds on the real fixture truncated to 8–11 bytes (past the RAR5 signature)
  or 23–26 bytes (past the main archive header), and enumerates nothing.

Either would have shipped a corrupt file reading as a **healthy empty archive** — the false-HEALTHY
class this system rejects everywhere, and one no test notices because nothing throws and the
document is structurally valid.

**So each extractor guards it: zero raw entries means the archive is unreadable, and it throws.**
Two details are load-bearing. The count is the **raw** yield, before the entry-type filter — gating
on the filtered count reports a valid directory-only archive as corrupt. And tar, unlike rar, needs
an exemption: a genuinely empty tar *is* a block of zeros, so it checks the bytes before deciding.

**The guard covers a class, not two byte patterns.** Any corruption that opens successfully and
yields nothing is caught however it arose. What remains unguarded is different and not reachable
from inside an archive: corruption that yields a *nonzero but wrong* entry count — three entries
silently becoming two — because nothing in the archive states how many there should have been.

**How both were found is the transferable part.** The first probe of each tried only the extremes,
all-zeros and all-garbage, and both extremes throw. The failure lives in the shape between them: a
valid header followed by damage. A probe that tests only the ends of a range proves nothing about
its middle.

## 8. The output schema

Authored as `src/Processor.FileReader/schema/output.json`: one `{metadata, content}` node
definition per level, required keys, `additionalProperties: false`, and `content` cardinality via
`minItems`/`maxItems`.

**Depth is structural, not declared.** JSON Schema has no depth keyword and cannot express "at most
N levels" without writing the levels out, so the baseline unrolls: `depth1` may hold an array of
`depth0`, and `depth0`'s `content` is a string and nothing else. You read the limit by counting the
definitions. A self-referencing `$ref` admitting any depth was rejected for exactly the reason it
sounds appealing — a schema that admits any depth can never tell you the depth was wrong.

**Nothing keeps `MaxDepth` and the schema in sync, deliberately.** The payload says what to expand;
the schema says what a document may look like. When they disagree the document fails validation,
exactly as a wrong entry count does. Note the cost before raising either: this failure is the
destructive one described below, so `ProcessAsync` logs the depth it actually reached — that line is
where the diagnosis lives, because the failure itself carries no path.

**The schema's depth caps every workflow using this processor.** `OutputSchemaId` is a column on the
processor row, not the step, so there is one output schema per processor identity. A step's
`MaxDepth` can sit at or below what the schema admits, never above it; a feed needing more than the
baseline allows needs its own processor identity, not just its own payload. The baseline stays at 1.

Mechanics it depends on, each a way to get it wrong:

- **`minContains`/`maxContains` must sit beside their own `contains`**, so two independent cardinality
  rules need two subschemas under `allOf`.
- **`$ref` with sibling keywords is legal in 2020-12 and not in draft-07** — that is what lets a
  narrowing subschema (`.wav` entries, say) refine a shared node definition instead of replacing it.
  `ProcessorJsonSchemaValidator`'s static constructor sets `Dialect.Default = Dialect.Draft202012`.
- **A narrowing subschema must omit `additionalProperties`.** That keyword only sees `properties`
  declared in the *same* schema object, never through `$ref`; adding `false` to a two-line refinement
  would reject every field it did not itself restate.
- `format` and `contentEncoding` are **annotations, not assertions**, in 2020-12, and `DefaultOptions`
  does not enable format assertion. They document; they do not enforce.
- Constrain **`content`**, not `metadata.entryCount`. The array is the fact; the count is derived, and
  pinning the derived field would let a counting bug pass a schema the content fails.

**Registering the schema against the processor identity is a database row and a deploy step, not this
pass.** v1 runs with `OutputSchemaId` null until it is registered — and until then **nothing enforces
entry count**, because the schema is now its only home. That is the gap the §6 config change opens,
recorded here rather than discovered later.

**What the schema cannot assert:** anything about file content. `content` is a base64 string, so the
bytes are unconstrained by construction. The schema polices the envelope and nothing inside it.

**And a schema failure is destructive.** `TryValidate` returning false logs at Information, sends
`StepResult.Failed` with `EntryId: Guid.Empty`, and **acks** — no L2 write, and the step's input blob
was already reclaimed by the pre handler when the author returned. The file has been read, decoded and
expanded, and the result is discarded with no key to recover it and no `filePath` in the post
handler's log, which holds ids only. **So every check that can be made in `ProcessAsync` is made
there.** The schema is a backstop against a bug in the serializer, not a validation strategy.

## 9. Failures

Every failure is `FailedException` → `StepResult.Failed`, acknowledged, never requeued — **IO faults
included**. There is no transient class here: the requeue path in `ProcessDispatchHandler` is
`TransientSendException` and its subclass only, and both arise solely from `SendToPostAsync`, so
`PostSendException` propagates untouched and everything else is a terminal outcome.

Stable message templates, carried by the **`FailedException` itself**. Step failures log at
Information in this system, so the message is what an operator searches, not the level:

| Class | Template |
|---|---|
| bad locator | `input branch did not name a file path: {Reason}` |
| bad payload | `step payload rejected: {Reason}` — a malformed config, including a ceiling above the pod's |
| rejected | `file {FilePath} rejected: {Reason}` — extension, size floor, size ceiling |
| unreadable | `reading {FilePath} failed: {Reason}` — any IO exception, cause not classified |
| unextractable | `extracting {FilePath} failed: {Reason}` — corrupt or truncated archive |

The path is in every line that has one. That is the whole reason these checks live in `ProcessAsync`
rather than in the schema.

**The author does not log these itself, and an earlier draft of this document said it should.**
`ProcessDispatchHandler` catches `FailedException` and writes
`"the author reported the step failed: {Reason}"` with `ex.Message` **verbatim** — so the templates
above already reach the log store in full, and a pre-throw log line would emit every failure twice.
The draft's premise was that the thrown text does not survive; it does. `BaseImporter` and
`BaseExporter`, the only other authors that throw `FailedException`, both rely on that same catch and
log nothing themselves. FileReader matches them.

Corrected 2026-09-09 during implementation, after a task review found the duplication. The
**messages** are unchanged — they are the contract; only the second copy of them is gone.

**A `bad payload` class exists for the same reason.** The `rejected` template names a file, and a
malformed payload is diagnosed before any path has been read — a message naming a file that was
never named is worse than a fifth class.

## 10. Layout

```
src/Processor.FileReader/
  FileReaderProcessor.cs        stage 1 — dry
  FileContentBuilder.cs         stage 2 — structure
  FileNode.cs                   the document records
  FileLocator.cs                the input {filePath} contract
  FileReaderConfig.cs           step payload
  FileReaderOptions.cs          pod configuration
  Extractors/IArchiveExtractor.cs
  Extractors/ZipExtractor.cs
  Extractors/TarExtractor.cs
  Extractors/RarExtractor.cs
  schema/output.json
  ProcessorHost.cs  Program.cs  Dockerfile  appsettings.json
```

## 11. Two rejected shapes, and why

**A second processor doing the extraction.** `ProcessedData` carries
`(CorrelationId, ExecutionId, WorkflowId, StepId, ProcessorId, EntryId, Data)` and nothing else. A
downstream step receiving raw file bytes would have no name, extension or timestamps — those are
`FileInfo` facts only the step holding the path ever sees — so it could not build `metadata` at all.

**A framework hook in the post handler.** `ProcessedDataHandler` is `internal sealed` and does not even
receive the `BaseProcessor`; adding a `protected internal virtual byte[] OnBranch(byte[])` and
injecting the processor is about ten lines. It was still rejected, for the same reason plus one worse:
the hook sees no step payload, so it cannot know `ExpectedExtension` — the very thing the extraction
switches on. And the state cannot be smuggled in a field, because work and post are **two independent
consumers**: `BaseProcessor._dispatch` is safe only at prefetch 1 on one queue, and a post delivery can
be in flight while the next work dispatch runs. A field pairing one file's bytes with another file's
metadata is a live race with a silent wrong answer.

The seam remains cheap to add and is the right tool for something that works on `Data` alone —
compression, encryption at rest, a uniform envelope on every processor's output. It is the wrong tool
for this.

## 12. Tests

**Hermetic**, `src/tests/BaseApi.Tests/FileReader/`, xunit.v3 and NSubstitute, TDD. Real temp files and
real zip and tar archives built inside each test — no filesystem abstraction, because the thing under
test *is* the filesystem interaction. Coverage: each guard in stage 1 with its exact log template; leaf
and archive document shapes; depth-1 nesting; camelCase property names; a corrupt archive; a payload
ceiling exceeding the pod ceiling.

**RAR is the exception, because SharpCompress cannot write one.** Zip and tar fixtures are built
inside the test from bytes; a `.rar` cannot be, so `Fixtures/three-entries.rar` is a **committed
binary fixture**, generated once with the WinRAR CLI already on this machine:

```
"C:\Program Files\WinRAR\Rar.exe" a -ep three-entries.rar a.csv b.csv c.wav
```

That command goes in a README beside the fixture so it can be regenerated. It is the one test input
this repo cannot produce from source, and the reason is stated so nobody later assumes the file is
stale or accidental.

**Live**, `src/tests/BaseApi.Tests/Live/FileReader/`, under `Live/` so the hermetic gate skips them,
gated on `SKP_REALSTACK=1` with the offset-port recipe. The RabbitMQ forward is supervised across the
run rather than trusted to survive it.

The live test drives the real chain: seed the node, produce a record naming the path to the importer's
topic, then consume from the exporter's topic and assert the document. A rejection case — wrong
extension, and oversize — asserts a `Failed` outcome and the log line naming the path.

## 13. Deployment and the workflow

`k8s/37-processor-filereader.yaml`, modelled on `34-processor-kafkaimporter.yaml`, with a higher memory
limit (§6) and:

```yaml
volumeMounts:
  - name: skp-files
    mountPath: /mnt/skp-files/in
    readOnly: true
volumes:
  - name: skp-files
    hostPath: { path: /mnt/skp-files/in, type: DirectoryOrCreate }
```

### "Host" means the kind node, and that is a decision

The cluster is kind (`node/desktop-control-plane`, despite the context reading `docker-desktop`), and
its node container has **no `extraMounts`** — its only binds are `/etc/kind/hosts.toml`,
`/lib/modules`, and a docker volume at `/var`. So a pod's `hostPath` resolves against the node's
filesystem, never `C:\`. Docker cannot add a bind mount to a running container, so this is fixed at
node creation.

Reaching the Windows filesystem would mean recreating the cluster with
`extraMounts: hostPath: /run/desktop/mnt/host/c/...`. **Rejected**: the manifests re-apply but the data
does not, and recreating loses every processor identity row, schema definition, workflow and step in
Postgres along with Redis L2 — re-registering all of it to gain live fixture editing.

**Fixtures therefore live in the repo and are seeded onto the node as a test setup step:**

| | path |
|---|---|
| In the repo | `src/tests/BaseApi.Tests/Live/FileReader/Fixtures/` |
| Seeded with | `docker cp … desktop-control-plane:/mnt/skp-files/in/` |
| `hostPath` and `mountPath` | `/mnt/skp-files/in` |

Same path on both sides, so a log line means one thing. It survives pod restarts and the whole
`kind load` + SourceHash-repoint deploy loop; only a cluster recreate loses it, and the live test
reseeds anyway. The Kafka record carries `{"filePath": "/mnt/skp-files/in/orders.zip"}`.

### Workflow

`KafkaImporter → FileReader → KafkaExporter`, both edges
**`StepEntryCondition.PreviousCompleted = 1`**.

**Not `Always = 4`.** That is what the sample steps use, and it is the wiring that had the exporter
running on entry-shaped dispatches every time an import failed — the bug `BaseImporter`'s edge guard
exists to make impossible. `PreviousProcessing = 0` is rejected by `StepDtoValidator` and is also what
an omitted field binds to, so the value is stated explicitly rather than defaulted.

## 14. Not in scope

Unbounded recursion — expansion is recursive, but `MaxDepth` is a required number with a validated
range and no "unlimited" setting, because a self-reproducing archive expands to a copy of itself at
roughly constant size and would otherwise grind against the byte ceiling for thousands of levels
before stopping. Writing archives of any format — SharpCompress is referenced for RAR
reading only. Streaming: the file is fully in memory by design, which is what §6's ceiling bounds. A
filesystem abstraction. The framework post-hop seam. Windows-host mounts. `FileWriter`, which is the
next conversation.
