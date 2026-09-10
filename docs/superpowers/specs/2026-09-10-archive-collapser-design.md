# Processor.ArchiveCollapser — the inverse of ArchiveExpander

**Date:** 2026-09-10
**Status:** Designed. Not implemented.
**Introduces:** `src/Processor.ArchiveCollapser/`, `k8s/39-processor-archivecollapser.yaml`.
**Amends:** `src/Processor.ArchiveExpander/schema/output.json` — re-rooted from `depth1` to `depth2`
(§7), and its `schema/README.md`, whose worked example of "how to extend the depth" becomes the
baseline and must shift up a level.
**Depends on:** `BaseProcessor.Core` unchanged. Every decision below lands in author code, a
manifest, a schema file, or a test.

## 1. The decision

> **ArchiveCollapser is ArchiveExpander with the arrows reversed.** It takes the
> `{metadata, content}` document the expander produces, packs it back into a real archive, and emits
> the flat raw-file envelope the expander consumes — `{fileName, extension, sizeBytes, createdUtc,
> modifiedUtc, content}`, with `content` the base64 of the archive it just built.

The two contracts are shared, so the pair is a closed loop:

| | ArchiveExpander | ArchiveCollapser |
|---|---|---|
| input schema | raw file envelope | `{metadata, content}` tree |
| output schema | `{metadata, content}` tree | raw file envelope |

**"Shared" means the same schema ROW, not merely the same bytes.** `SchemaEdgeValidator.cs:51`
compares `parentOut.Value != childIn.Value` — schema **ids**, not definitions — and refuses to publish
a workflow whose parent output id differs from its child input id. So Expander → Collapser is only a
wireable edge if both point at one row. Registration therefore creates **two** schema rows for the
pair, not four: one for the envelope shape (FileFetcher output = Expander input = Collapser output)
and one for the tree shape (Expander output = Collapser input).

The byte-identical files of §7 are what make registering one row *safe* — they do not achieve it.
The files exist so each image can carry its own contract for registration and so the tests can pin
the duplicates against each other; the identity that the orchestrator enforces is the GUID.

It is a plain downstream transform. It has an input and it produces output, so it is **not an edge** —
neither `BaseImporter` nor `BaseExporter` applies — and it passes through the `executionId` it was
dispatched with rather than minting one. A transform continues the lineage it was handed.

## 2. The file layout, and what is NOT mirrored

Most of the processor mirrors the expander file for file:

| ArchiveExpander | ArchiveCollapser |
|---|---|
| `ArchiveExpanderConfig.cs` (`MaxDepth`) | `ArchiveCollapserConfig.cs` — fieldless marker (§3) |
| `ArchiveExpanderOptions.cs` | *(gone — §4)* |
| `ArchiveExpanderProcessor.cs` | `ArchiveCollapserProcessor.cs` (§5) |
| `FileContentBuilder.cs` | `ArchiveBuilder.cs` (§7) |
| `FileNode.cs` (+ `FileNodeConverter`) | `FileNode.cs` — same file, reading rather than writing |
| `FetchedFile.cs` / `SourceFile` | `CollapsedFile.cs` — the outbound envelope (§6) |
| `Extractors/` × 3 + `ArchiveExtractionException` | `Writers/` × 2 + `ArchiveWritingException` (§8) |
| `Program.cs`, `ProcessorHost.cs` | unchanged but for names and the dropped `Configure<TOptions>` |
| `schema/input.json`, `schema/output.json` | the two swapped, byte-for-byte (§7) |

`FileNode.cs` is duplicated across two assemblies that must not reference each other — exactly as
`FetchedFile` already is between FileFetcher and ArchiveExpander — so it gets the same treatment: a
copy carrying a comment that names its twin, pinned by a contract test rather than shared through a
project reference.

The exceptions below are where a reader coming from the expander will trip, so they are listed
rather than buried.

**No `CanHandle(ReadOnlySpan<byte>)`.** On the way in the bytes exist, and they are the only honest
evidence: an entry's name is a string written by whoever built the archive, and below the top level
there is nothing to check it against. On the way out there are no bytes yet. The only thing a node
carries about what it should *become* is its declared name. So `metadata.extension` selects the
writer, at every level, and the seam has two members where the extractor's has three.

**No `Validate`, no `BadPayload`, no `config is null` rejection.** See §3.

**No options, no byte ceiling, no `ArchiveCollapser__*` env var.** See §4.

**No `SharpCompress` package reference.** It was in the expander for RAR alone, and RAR is a
proprietary format SharpCompress can only read. `RarArchive` has no writer. The collapser can consume
a document that came from a RAR and re-pack it — just never as a RAR.

**The cross-check inverts.** The expander guards *named as an archive, bytes are not one* → treat as
corrupt rather than record a plain file. The collapser guards *content is entries, extension names no
writer* → an unpackable node. Same false-HEALTHY instinct, opposite evidence.

**The empty-archive guards have no mirror.** `ZipExtractor.IsCanonicalEmptyArchive` and
`TarExtractor`'s all-zero check exist because a library will open damaged input, report success and
enumerate nothing. Writing has no equivalent lie to catch.

**`FileNodeConverter` flips.** `Read` becomes the production path and `Write` the test convenience —
the exact reverse of what its current doc comment says. Both comments are rewritten, not copied.

## 3. The step payload holds nothing

`ArchiveCollapserConfig : ProcessorConfig` is a **fieldless marker record**, and it exists only
because the type system demands one: `BaseProcessor.ExecuteAsync` is `internal abstract`, so nothing
outside `BaseProcessor.Core` can derive from the non-generic base, and `BaseProcessor<TConfig>` is
the only door.

**There is no `MaxDepth`, and that is the decision.** On the expander `MaxDepth` is a genuine choice —
how far to go. On the collapser there is nothing to choose: the depth is a property of the document
that arrived, and the document is the source of truth. A payload field could only ever contradict it.

This costs nothing at either end, verified rather than assumed:

- **No parsing at consuming.** `BaseProcessorOfT.cs:13` short-circuits on
  `string.IsNullOrWhiteSpace(payload)` and hands `ProcessAsync` a null *without* calling
  `Deserialize`. A non-empty payload does deserialize, but into a record with no fields, and
  `ProcessorConfig.SerializerOptions` ignores unknown properties — so it succeeds and yields nothing
  either way.
- **No validation at publish.** `ConfigSchemaId` is nullable on the processor row and
  `PayloadConfigSchemaValidator.cs:38` `continue`s past any processor that has none. The gate is not
  skipped by accident; it has nothing to run.

This is already the house norm, not a new posture: no processor in this repo ships a
`schema/config.json`, and the expander's own `MaxDepth` is validated in `ProcessAsync`, in code.

**The one line that must not be mirrored** is the expander's
`if (config is null) throw BadPayload("ArchiveExpander needs MaxDepth")`. Null is fine, `{}` is fine,
a payload left over from another step is fine. `config` is never read. §10 pins this so nobody
"fixes" it back later.

## 4. There is no byte ceiling, and why that is not an oversight

`MaxExpandedBytes` on the expander is **predictive**: nobody can know what a zip expands to until it
is opened, so an operator's ceiling guards a genuine unknown and fires *before* that unknown is
materialised.

On the collapser there is no unknown. The size is the document, and the document is already resident
in `data` before `ProcessAsync` is entered. A ceiling could only refuse work whose memory had already
been spent, and the allocations it would prevent are a small multiple of a term it cannot refuse.

So there is **no `ArchiveCollapserOptions` class, no env var, and no `Configure<TOptions>` line** in
`ProcessorHost.Create`. What replaces it is honesty in the manifest: the sizing input arrives from
upstream, and the only knob is the memory limit. See §9.

## 5. The processor

Four steps:

```
read the document  ->  build the archive  ->  log the shape  ->  send one branch
```

**Reading.** `ReadDocument(data)` mirrors `ReadEnvelope`, including the part that matters most: the
`JsonException` is caught and **its message is discarded, never surfaced**, because System.Text.Json
quotes the fragment that failed to parse and that fragment is upstream content. The class of fault is
reported; the ids in the open scope are how it is traced.

One check the expander does not need: the envelope schema declares `fileName` with `minLength: 1`, so
a root node with no name cannot produce a valid envelope and is rejected here — rather than one hop
later, where the post handler reports `Failed` with `EntryId: Guid.Empty`, no payload and no name.

**Failure templates**, chosen to sit beside the expander's so an operator's existing queries
generalise:

| expander | collapser |
|---|---|
| `input branch did not carry a fetched file: {reason}` | `input branch did not carry a file document: {reason}` |
| `extracting {FileName} failed: {reason}` | `collapsing {FileName} failed: {reason}` |
| `step payload rejected: {reason}` | *(gone)* |

Neither logs. `ProcessDispatchHandler` writes the author's message verbatim, so a line here would
emit every failure twice. The message text IS the contract an operator searches.

**Logging** keeps the expander's rule — the shape of the result, never its content — and keeps the
depth for the same reason it is there now: the outbound envelope schema says nothing about depth, so
if the input schema row is not registered, the depth the document actually reached survives nowhere
else.

## 6. The outbound envelope

`CollapsedFile`, serialized with a third copy of the camelCase + `JsonIgnoreCondition.Never` options
object that `FetchedFileJson` and `FileDocument` each already carry. `Never` because `createdUtc` and
`modifiedUtc` may be null and the schema requires the keys to be **present**, not merely valid.

| field | source |
|---|---|
| `fileName` | root `metadata.name` |
| `extension` | root `metadata.extension` |
| `createdUtc` / `modifiedUtc` | root metadata, passed through, null allowed |
| `content` | base64 of the archive produced |
| `sizeBytes` | **the produced archive's length** |

The last row is the one to notice. The root's declared `sizeBytes` is decoration and loses to the
content, exactly as `entryCount` does — the expander's root `sizeBytes` was what `FileInfo.Length`
reported, and the honest equivalent here is what was actually built. This is also what makes §10's
tier-1 byte identity hold *for real* rather than by copying a number that might be wrong.

## 7. The four node cases, and the depth bound

Applied at every level, selected on `metadata.extension`:

1. **`content` is a string** -> a leaf. Its bytes become the entry's content, whatever the extension
   claims — the mirror of "an unexpanded archive is a file". At the **root**, this means the document
   describes a plain file and the collapser emits its bytes unchanged: a pass-through, and the exact
   inverse of the expander leaving a CSV as a leaf.
2. **`content` is an array** -> an archive. Recurse for each child's bytes, then
   `writer.Write(entries)`.
3. **`content` is null** -> an **empty archive of that format**. For zip that is precisely the
   canonical 22 bytes `ZipExtractor.IsCanonicalEmptyArchive` exists to recognise; for tar, the
   all-zero blocks `IsAllZeroBytes` accepts. This closes the loop those guards open: the expander
   turns an empty archive into null, and null turns back into the one archive each guard will still
   call healthy.
4. **an array or null whose extension names no writer** -> `ArchiveWritingException`. `.rar` gets its
   own message rather than falling into the generic one, because "RAR cannot be written" is a
   permanent property of the format, not a typo in the document, and an operator who hits it must not
   spend an afternoon fixing a name.

**Duplicate sibling names are allowed.** Zip and tar both permit them and the expander reads both
back, so the round trip survives. No check.

**A path separator in a node name is rejected.** The expander deliberately strips directories —
`entry.Name` in zip, `Path.GetFileName` in tar — so a name is a name, never a path. Writing real
directory structure that the expander then flattens straight back would quietly break the fixed point
§10 rests on. Silently stripping it would hide a malformed document.

### The depth bound does not mirror

On the expander, `MaxDepth` is validated before a single file is opened, so the stack bound is fixed
up front. Here the depth arrives *with the document*, so the guard lives inside the walk:
`MaxSupportedDepth`, tripping at the node that crosses it.

The builder is the **second** guard, not the first. `FileNodeConverter.Read` recurses while
deserializing, so a pathologically deep document overflows the stack in the converter before the
builder sees a tree. What prevents that is `JsonSerializerOptions.MaxDepth`, which
`FileDocument.Options` leaves at its default of 64 — and since each node costs two levels of JSON,
that caps the tree at roughly 32 node levels and throws a `JsonException` already caught in §5.
**This reading is load-bearing and is pinned by a test rather than trusted to this paragraph**,
following the precedent of `ZipExtractor`'s "what was measured, on .NET 8.0.31" block.

### The schema moves to depth 2

The identity test in §10 runs at depth 2 — a zip inside a zip, both expanded — which is a three-level
tree: root -> inner archive -> leaves. The shared schema currently roots at `depth1`, which admits
root -> leaves and nothing more. So `Processor.ArchiveExpander/schema/output.json` is re-rooted using
the recipe its own README already gives:

    "$ref": "#/$defs/depth2",

    "depth2": {
      "type": "object", "additionalProperties": false,
      "required": ["metadata", "content"],
      "properties": {
        "metadata": { "$ref": "#/$defs/metadata" },
        "content": { "type": ["string", "array", "null"],
                     "items": { "$ref": "#/$defs/depth1" } }
      }
    },

leaving `depth1` and `depth0` unchanged.

**The widening is backward compatible** — a depth-1 document still validates, since `depth1` admits
string content — so no existing expander test breaks. **It is nonetheless a genuine loosening in the
README's own terms:** after this, a `MaxDepth: 1` step producing a shallow document is no longer
distinguishable by the schema from one that should have gone deeper. Accepted, and stated rather than
glossed.

The expander's `schema/README.md` needs a real edit, not a copy: it currently documents depth 1 as the
baseline and uses depth 2 as its worked example of how to extend. Once depth 2 is the baseline, that
example shifts up a level so the file still teaches the rule.

**Depth 2 is what makes both recursions real.** At depth 1 the collapser's `BuildNode` would only ever
be entered once below the root, and the expander's own recursion is barely exercised by the contract
tests. A zip inside a zip drives a genuine recursive descent in `FileContentBuilder`, in
`ArchiveBuilder`, and in `FileNodeConverter` in both directions — which is why the identity test is
specified at depth 2 rather than depth 1 with a unit test reaching past the contract.

## 8. The writers

    public sealed record ArchiveEntry(string Name, byte[] Content, DateTime? ModifiedUtc);

    public interface IArchiveWriter
    {
        string Extension { get; }                       // ".zip" — the SELECTOR, not a label
        byte[] Write(IReadOnlyList<ArchiveEntry> entries);
    }

`ArchiveWritingException` mirrors `ArchiveExtractionException` exactly, and for the same stated
reason: each writer wraps its own library's faults into the one type the processor catches, never
bare `Exception`, so a `NullReferenceException` in the builder reaches the framework's general catch
with its stack trace instead of being reported to an operator as a bad document.

### ZipWriter — `System.IO.Compression`, in-box

**The `using` must be scoped and `ToArray()` must come after it.** `ZipArchive` writes the central
directory on `Dispose`. Grab the buffer before that and the result is a zip with no EOCD — which
`ZipExtractor` would correctly reject as corrupt one hop later, with no file name in the failure. So:
`leaveOpen: true`, braces around the archive's lifetime, `ToArray()` outside them. The `Zip()` helper
in `EnvelopeContractTests` already uses exactly this shape.

**The empty case needs no special code.** A `ZipArchive` opened in `Create` mode and disposed without
a single entry writes precisely the canonical 22-byte EOCD — recorded as verified on .NET 8.0.31 in
`ZipExtractor.IsCanonicalEmptyArchive`. So node case 3 is `Write([])`.

**The timestamp clamp is two-sided.** `LastWriteTime` rejects years below 1980 and above 2107 — both
ends of the DOS range. Per §11 both ends clamp to their respective bounds and null takes the floor.
`ArgumentOutOfRangeException` derives from `ArgumentException`, already on the wrapped catch list, so
a bug in the clamp degrades to a clean `ArchiveWritingException` rather than escaping.

Compression stays at `Optimal`, which is `CreateEntry`'s own default. No option, per §4.

### TarWriter — `System.Formats.Tar`, in-box

**Format: `TarEntryFormat.Pax`, and that is forced rather than aesthetic.** `TarExtractor.CanHandle`
looks for the `ustar` magic at byte 257 and explicitly refuses pre-POSIX V7, so writing V7 would
produce a tar our own expander cannot recognise — silently breaking the round trip. Pax additionally
is the BCL default, handles long names, stores mtime at full precision where Ustar is limited to 11
octal digits of seconds, and writes `TarEntryType.RegularFile`, one of the two types `TarExtractor`
admits.

**Naming.** `System.Formats.Tar.TarWriter` is the BCL type this builds on. Our class keeps the name
`TarWriter` for symmetry with `ZipExtractor`/`TarExtractor`, with a one-line
`using BclTarWriter = System.Formats.Tar.TarWriter;` alias in that single file.

**Two things to measure rather than assert**, mirroring how `ZipExtractor` documents what was verified
on this runtime: whether a `TarWriter` disposed with no entries writes the trailing zero blocks or
nothing at all (either satisfies `IsAllZeroBytes`, so case 3 holds regardless — but the byte count
should be known), and the exact range `TarEntry.ModificationTime` accepts, since §11 sends nulls to
the Unix epoch and tar-sourced documents can carry pre-epoch values.

## 9. Deployment

| artefact | note |
|---|---|
| `Processor.ArchiveCollapser.csproj` | the expander's **minus `SharpCompress`**. Keeps `InternalsVisibleTo("BaseApi.Tests")` and the pinned `BaseProcessor.Core [1.0.0]` **package** reference — not a `ProjectReference`, because `SourceHash.targets` ships in the package's `build/` folder and only a package flows build targets |
| `packages.lock.json` | generated by restore, committed |
| `Dockerfile` | the expander's with names changed. All five nuget feeds still copied even though fewer are consumed — NuGet fails `NU1301` on a source in `NuGet.config` that is absent, whether or not anything resolves from it |
| `SK_P.sln` | new project added |
| `BaseApi.Tests.csproj` | `ProjectReference`, plus the schema `Link` renames of §10 |
| `k8s/39-processor-archivecollapser.yaml` | next in sequence after `38-processor-filefetcher` |
| `k8s/kustomization.yaml` | one line — the exact line `ffc4f9c` found stale in reverse |

**The memory limit is 768Mi, matching the expander, and the argument is tighter than "match the
neighbour".** The collapser's input schema *is* the expander's output schema, so whatever the
expander is provisioned to produce, the collapser is obliged to hold. Sizing it lower would mean a
document the upstream pod may emit is one the downstream pod cannot receive — and the failure would
be an OOM, which is a **poison message, not a failed step**: the author never returns, the input key
is never reclaimed, RabbitMQ requeues the unacked dispatch, and the replacement pod dies the same way,
taking down every workflow on that queue. The limits are coupled by the contract, and the manifest
comment says so in those terms since there is no ceiling pair to point at instead.

`maxSurge: 0`, for the same node-memory reason the expander gives: two 768Mi pods briefly overlapping
want ~1.5Gi on a single-node kind cluster already running Postgres, Redis, RabbitMQ, Prometheus,
Grafana, an OTel collector, BaseApi, the orchestrator and five other processors.

Two operational notes for the manifest header, both inherited: expect the pod to sit **NotReady with
0 restarts** until a processor row exists — readiness by design, and a `kubectl rollout status`
timeout is the expected signal, not a fault; and the row must carry this assembly's **SourceHash**, so
a rebuild means a repoint.

## 10. Tests

### The identity test — three tiers

The primary assertion is that **ArchiveExpander's input data and ArchiveCollapser's output data are
identical**, run at depth 2. It splits into three tiers, because byte identity is fully achievable in
two of them and impossible in the third for reasons that have nothing to do with this design.

**Tier 1 — a plain file: the envelope is byte-identical, every field.** `fetch -> expand -> collapse`
over `orders.csv` returns exactly the bytes the fetcher sent. Name, extension and both timestamps pass
through untouched; `content` is carried verbatim as `FileContent.Bytes`; `sizeBytes` matches because
for a pass-through the produced length *is* the content length. A flat `Assert.Equal` on the raw
bytes. Depth does not apply.

**Tier 2 — a nested archive this system built: byte-identical, and this is the real proof.** Take a
collapser-produced zip containing a collapser-produced inner zip, expand it at `MaxDepth: 2`, collapse
it again — the result equals the original byte for byte. Same writer, same `Optimal` level, same entry
order (the document's array preserves it, and `ZipArchive.Entries` enumerates in write order),
timestamps already clamped so the second pass moves nothing, all headers written by the same code. The
envelope matches too, `sizeBytes` included. This is also the case that exercises the recursive descent
on both sides — see §7.

**Tier 3 — a nested archive from outside: identical in everything the document records, and *not*
byte-identical.** A zip made by 7-Zip, `zip(1)` or Python re-encodes differently no matter what we do:
the deflate stream itself differs between implementations, and the source may have used Stored or
BZip2 per entry, carried extra fields and Unix timestamp records, set different version-made-by and
general-purpose flags, or held directory entries the expander drops by design. What survives is
exactly what the document ever claimed to carry — names, content, entry count, and timestamps within
each format's range.

**Tier 3 is a property of round-tripping through a lossy intermediate, not something a different
implementation would fix.** It is stated here so nobody reads tier 2 passing and files a bug that tier
3 does not have.

### Contract — `EnvelopeContractTests` grows

- **three-way** byte identity on the envelope shape (fetcher output / expander input / collapser
  output), extending the existing two-way assertion
- **two-way** byte identity on the tree shape (expander output / collapser input)
- a `Collapse` helper beside the existing `Fetch` and `Expand`, running the real processor
- the three tiers above
- **the fixed point**: expand -> collapse -> expand -> collapse, timestamps stationary after the first
  hop. This is what makes §11's "consistent with ArchiveExpander" an assertion instead of a claim
- **the known losses pinned as expected**: directories flattened, `createdUtc` null on nested nodes, a
  tar-sourced pre-1980 timestamp landing on the floor when it becomes a zip

The existing `APlainFileSurvivesBothHops` carries a comment warning against collapsing its two
distinct timestamps into one shared constant, because null-checks alone cannot see a transposition.
The round-trip tests need the same discipline and the same comment.

**The schema `Link` renames.** `BaseApi.Tests.csproj:71-82` links schema files into a single flat
`schema/` folder in the test output, renaming FileFetcher's to `fetcher-output.json` because the
expander's already claimed `output.json`. Two more files land in that folder, and at four the
unqualified `input.json`/`output.json` (silently the expander's) stop being readable. All of them move
to `<processor>-input.json` / `<processor>-output.json`, touching those three lines and the three
helper methods that read them.

### Unit — `src/tests/BaseApi.Tests/ArchiveCollapser/`

Mirroring the expander's six files:

- `ZipWriterTests` / `TarWriterTests` — the empty archive's exact bytes, the two-sided timestamp
  clamp, library faults wrapping into `ArchiveWritingException`, and a `NullReferenceException`
  deliberately **not** caught
- `ArchiveCollapserDocumentTests` — the four node cases, `.rar` getting its own message, a path
  separator rejected
- `ArchiveCollapserEnvelopeTests` — field derivation, and specifically `sizeBytes` being the archive
  produced rather than anything the document declared
- `ProcessorArchiveCollapserTests` — failure templates, one branch, `executionId` reused unchanged,
  and **`config` null / `{}` / a stale payload all succeeding**, the explicit inverse of the
  expander's rejection
- `ArchiveCollapserSchemaTests` — mirroring `ArchiveExpanderSchemaTests`
- `ArchiveCollapserDepthTests` — the converter's `MaxDepth` measurement and the builder's
  `MaxSupportedDepth`

### Live — `src/tests/BaseApi.Tests/Live/ArchiveCollapser/`

Mirrors the expander's suite against the real cluster, inheriting the single five-minute window per
suite that `f084bfc` established rather than reintroducing per-assertion literals. These skip outside
`Live/`, so the hermetic gate stays clean.

**Verification note:** `--filter "Category!=RealStack"` is silently ignored under MTP, so any run is
the full suite regardless of the command line; and `dotnet test` reports counts without names, so a
failure means running `BaseApi.Tests.exe` directly to find out which.

## 11. Timestamps — the rule

"Consistent with ArchiveExpander" resolves to a precise, testable rule rather than a blanket clamp.
What the three extractors produce today:

| source | `modifiedUtc` in the document |
|---|---|
| `ZipExtractor` | always non-null, and **never below 1980** — `entry.LastWriteTime` is a DOS timestamp and the format cannot represent less |
| `TarExtractor` | always non-null, and **may be pre-1980** — `entry.ModificationTime` is a full `DateTimeOffset` |
| `RarExtractor` | **may be null** — `entry.LastModifiedTime?.ToUniversalTime()`, the only nullable of the three |

So the clamp never fires on the path one would expect. A zip-sourced document collapsed back to a zip
round-trips exactly, because the expander could not have read a value the writer cannot write. The
clamp fires on two real paths: a **tar-sourced** document collapsed to zip, and a **rar-sourced** one,
where `modifiedUtc` is null and RAR cannot be written so it must land in a zip or tar regardless.

> **Write the value the expander would read back.**

- zip, outside 1980–2107 -> clamp to that bound, which is exactly what `ZipExtractor` reports
  afterwards
- zip, null -> the floor, for the same reason
- tar -> represents both cases natively, so nothing is clamped; null becomes the Unix epoch, tar's own
  conventional zero and what `TarExtractor` reads back

The property that falls out is that **collapse -> expand is a fixed point**: timestamps stop moving
after the first hop. Silent, with the loss recorded in each writer's doc comment rather than a log
line per entry.

## 12. What this design does not do

Stated so nothing here reads as a promise:

- **No RAR writing.** Impossible — the format is proprietary and SharpCompress reads only.
- **No `.tar.gz`.** A different extension, its own writer, and its own question about whether a double
  extension is one format or two. The expander does not do it either.
- **No directory structure.** The document has never carried it; the expander strips it on read.
- **No schema registration.** It stays a deploy step against the processor identity. Until those rows
  exist, `TryValidate` returns true without decoding anything and **none of the schema constraints in
  this document are enforced anywhere** — and `SchemaEdgeValidator` passes on a null on either side,
  so an unregistered pair is also freely miswireable at publish. Registering the two rows of §1 is
  what turns this design's contracts on; skipping it leaves the processors working and the contracts
  inert.
