# FileReader — Design

**Date:** 2026-09-09
**Status:** Decided. Not yet implemented.
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

6. Resolve an `IArchiveExtractor` by `ExpectedExtension`. None registered → the file is a leaf.
7. Expand **one level**; each entry becomes a node with its own metadata and content.
8. Build the document.

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
  "content": null,
  "entries": [
    { "metadata": { "name": "a.csv", "extension": ".csv", "sizeBytes": 118,
                    "createdUtc": null, "modifiedUtc": "2026-09-08T10:58:00Z", "entryCount": 0 },
      "content": "aWQsbmFtZQo...", "entries": [] }
  ]
}
```

- **Identical node shape at every level**, so the schema is one self-referencing definition.
- `content` is base64 for a leaf and **`null` for an archive** — carrying the zip bytes *and* its
  expansion doubles the blob for no consumer.
- A non-archive file is a root leaf: `content` set, `entries` empty.
- **Depth 1.** A zip inside a zip is a leaf: recorded with its bytes and metadata, not expanded.
  Recursion is the one dimension here with no natural bound, and nothing has asked for it.
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
    long   MaximumSizeBytes     // read-time ceiling, per step
) : ProcessorConfig;
```

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

**Memory is why this is a manifest value.** A 32 MB file does not cost 32 MB in flight: the raw
`byte[]`, the base64 string during serialization, the document bytes, the broker message body, and a
full `JsonDocument` DOM at validation can coexist — and the work and post consumers are the *same
process*, so a dispatch and a branch overlap. That is comfortably over 200 MB transient against the
`384Mi` limit the other processors carry. **FileReader's manifest gets a higher limit, or its ceiling
is set well under 32 MB.** Being a manifest value is what lets that be tuned per environment without a
rebuild.

## 7. Extractors

```csharp
public interface IArchiveExtractor
{
    bool CanHandle(string extension);
    IReadOnlyList<ExtractedEntry> Extract(Stream archive);
}
```

Resolved by extension, registered in the container. **ZIP, TAR and RAR.** ZIP and TAR run on in-box
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

## 8. The output schema

Authored as `src/Processor.FileReader/schema/output.json`: recursive `$ref`, required keys,
`additionalProperties: false`, and `entries` cardinality via `minItems`/`maxItems`.

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
- Constrain **`entries`**, not `metadata.entryCount`. The array is the fact; the count is derived, and
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

Recursive archive expansion. Writing archives of any format — SharpCompress is referenced for RAR
reading only. Streaming: the file is fully in memory by design, which is what §6's ceiling bounds. A
filesystem abstraction. The framework post-hop seam. Windows-host mounts. `FileWriter`, which is the
next conversation.
