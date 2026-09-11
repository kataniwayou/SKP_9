# Processor.SKNormalizer — a provider-aware standardizing transform

**Date:** 2026-09-12
**Status:** Designed. Not implemented.
**Introduces:** `src/Processor.SKNormalizer/`, `k8s/41-processor-sknormalizer.yaml`.
**Amends:** nothing. `BaseProcessor.Core` is unchanged; `Processor.ArchiveExpander` and
`Processor.ArchiveCollapser` are unchanged.
**Depends on:** the `{metadata, content}` tree contract the expander emits and the collapser
consumes, and an `ffmpeg` binary present in the processor image.

**Scope note.** This document designs the **structure**: the pipeline, the handler seam, the shared
services, the failure boundary, the deployment consequences. It deliberately does **not** design any
provider's business. The XML element vocabulary, the per-provider field maps, the ffmpeg argument
sets and the Redis whitelist's backing store are named as seams and left open — §11 lists them. That
is the agreed shape of this phase, not an omission.

---

## 1. The decision

> **SKNormalizer takes the document the expander produces, hands it to one hardcoded provider
> handler chosen by name on the step payload, and emits a new document of the same contract.** The
> handler validates the provider's content, projects its metadata into a standardized XML file,
> converts its audio to a standard encoding, and states how the result should be laid out. The
> processor owns everything mechanical; the handler owns everything provider-specific.

It is a plain downstream transform — input and output, so neither `BaseImporter` nor `BaseExporter`
applies — and it **passes through the `executionId` it was dispatched with** rather than minting one.
A transform continues the lineage it was handed, exactly as the expander and collapser do.

The wired chain is:

```
FileFetcher → ArchiveExpander → SKNormalizer → ArchiveCollapser → FilePersister
```

### 1.1 What it is NOT coupled to

**The collapser is not coupled to any particular tree, and this design relies on that.**
`ArchiveBuilder.Build` recurses over whatever it is given: `FileContent.Bytes` is a leaf,
`FileContent.Entries` is packed, `null` is packed as the format's empty archive. It never pairs
entries, never inspects counts, never asks what a node *means*. A handler may therefore emit any
layout it likes — one flat archive of pairs, a folder per item, a single file — and the collapser
packs it.

**Four rules are the exception, and §6 makes them unbreakable rather than merely documented:**

1. **Every node carrying `Entries` needs an extension that names a writer** — `.zip` or `.tar`.
   That includes the root. `.rar` is readable but not writable and fails with its own message.
2. **A node name is a name, never a path.** `ArchiveBuilder.Pack` rejects `/` and `\` outright
   rather than stripping them, because stripping would hide a malformed document. Folder structure
   is expressed as a nested `Entries` node, never as `audio/track01.wav`.
3. **The root must carry a non-empty `Metadata.Name`.** Its `Name`, `Extension`, `CreatedUtc` and
   `ModifiedUtc` become the outbound envelope the collapser emits.
4. **Depth is capped at 4** (`ArchiveBuilder.MaxSupportedDepth`), and `JsonSerializerOptions.MaxDepth`
   refuses a deeper document before that bound is even reached.

`SizeBytes` and `EntryCount` on any node are advisory to the collapser — it recomputes both from what
it actually built — but they are part of the registered schema and §6 fills them honestly.

### 1.2 The schema row is the real structural coupling

The collapser's *code* is shape-agnostic. The **edge** between processors is not.
`SchemaEdgeValidator` compares schema **ids**, so a wireable edge requires both sides to point at one
row, and that row states depth structurally — the expander's own config documents that a document
deeper than its schema admits fails validation one hop later, reported with `EntryId Guid.Empty`, no
payload and no file name.

**This yields a decision rather than a problem.** Because SKNormalizer's input and output are both
the tree contract, it can reuse the existing tree row on both edges:

| edge | row |
|---|---|
| Expander out → Normalizer in | the tree row |
| Normalizer out → Collapser in | the same tree row |

**No new schema row is created.** The consequence is a hard constraint on every handler: the layout
returned from stage 8 must fit within the depth the existing tree row already admits. A handler that
wants deeper nesting is asking to re-register a frozen row that three other processors point at, and
that is a change to be made deliberately, once, not discovered by the first handler that needs it.

### 1.3 The division of labour, and where it is enforced

> **The workflow is built for the handler, not the handler for the workflow.** SKNormalizer is the
> only place provider behaviour is *code*. Every other processor in the chain is generic.

**But genericity lives in the code, not in the wiring.** FileFetcher's path, ArchiveExpander's
`MaxDepth`, FilePersister's folder are all provider-shaped *values*. A workflow is therefore a
provider-specific instantiation of generic parts, and **cannot be reused across providers by swapping
only the handler name** — every payload in the chain is part of that provider's configuration.

What the operator owns, and what checks it:

| operator decision | when a mistake surfaces |
|---|---|
| wiring the steps in order | **publish** — `SchemaEdgeValidator` compares row ids and refuses a mismatch |
| naming a handler that exists | **publish** — the config schema `enum` of §3.1 |
| naming the handler that matches the *feed* | **dispatch** — nothing can check it; stages 1–2 (§3.2) |
| the expander's `MaxDepth` | **dispatch** — stage 2, as an opaque leaf where entries were expected |

**`MaxDepth` deserves its own sentence because it is the subtlest of the four.** It decides whether a
nested archive reaches this processor as `FileContent.Entries` — openable, walkable by `Locate` — or
as a `FileContent.Bytes` leaf holding opaque base64. A handler that expects to look inside a nested
archive receives a blob when `MaxDepth` is set too low. That is a legible stage-2 failure rather than
a crash, but it is entirely the operator's doing, and the number lives in three places at once: the
expander's payload sets it, the tree row bounds it, and this processor's `LayoutFor` must stay inside
the same row on the way out.

---

## 2. File layout

```
src/Processor.SKNormalizer/
  Program.cs                      # identical to the expander's, verbatim
  ProcessorHost.cs                # boot + DI, mirrors the expander
  SKNormalizerProcessor.cs        # payload validation, handler resolution, envelope read
  SKNormalizerConfig.cs           # the step payload
  SKNormalizerOptions.cs          # pod-level operator numbers
  FileNode.cs                     # the tree contract + converter, copied as the siblings copy it
  Pipeline/
    NormalizationPipeline.cs      # the eight stages, in order
    NormalizationException.cs     # the one business-failure type
    SourceItem.cs
    StandardMetadata.cs
    AudioProfile.cs / NormalizedAudio.cs
    ItemNames.cs / NormalizedItem.cs
    OutputLayout.cs
  Handlers/
    IProviderHandler.cs
    ProviderHandlerRegistry.cs
    ProviderHandlerBase.cs        # defaults for the stages most providers won't vary
    <Provider>Handler.cs          # one file per provider, added over time
  Services/
    ITreeAssembler.cs / TreeAssembler.cs
    IAudioTranscoder.cs / FfmpegAudioTranscoder.cs
    IMetadataRenderer.cs / XmlMetadataRenderer.cs
    IFieldWhitelist.cs / PassThroughFieldWhitelist.cs
```

**`FileNode.cs` is copied, not shared.** The expander and collapser each carry their own byte-identical
copy of the contract and its converter. Extracting it to a shared package is a separate change
affecting three processors and is explicitly out of scope here; matching the existing convention keeps
this processor's diff to its own directory.

---

## 3. The step payload

```csharp
public sealed record SKNormalizerConfig(string Handler) : ProcessorConfig;
```

**Exactly one field, and it is the handler name.** Everything else a provider needs is *in* the
handler — that is the whole point of compiling them in. A payload that named field maps or ffmpeg
arguments would be a second, weaker place to express what the handler already states in code, and the
two would drift.

Validation, in order, mirroring `ArchiveExpanderProcessor.Validate`:

| condition | message |
|---|---|
| `config is null` | `step payload rejected: SKNormalizer needs Handler` |
| `Handler` blank | `step payload rejected: Handler is empty` |
| no such handler | `step payload rejected: no provider handler named '{name}'; this build carries {comma-separated names}` |

**The unknown-handler message names what the build does carry.** A handler name is chosen by an
operator wiring a workflow against a processor version, and the two drift on exactly one axis — a
step wired for a handler that this build predates. Listing the available names turns that from a
guess into a read. This is safe to log: handler names are author constants, never upstream content.

### 3.1 The config schema carries an enum, and that moves the check to publish time

**The three messages above are the backstop, not the primary defence.**
`PayloadConfigSchemaValidator` runs in BaseApi's `OrchestrationService` **at publish**, against each
processor's registered *config* schema. So SKNormalizer's config schema declares `handler` as a
string with an **`enum` of exactly the handler names this version carries**:

```json
{
  "type": "object",
  "properties": { "handler": { "type": "string", "enum": ["ProviderA", "ProviderB"] } },
  "required": ["handler"],
  "additionalProperties": false
}
```

A step naming a handler that does not exist is then **refused at publish**, rather than publishing
cleanly and failing at 3am on the first dispatch.

**Two consequences, both accepted deliberately.**

**Adding a handler now also means a new config schema row.** A referenced row's definition is frozen,
so a new provider is: POST a new config schema row, repoint the processor, restart — *on top of*
rebuild, `kind load` and the SourceHash repoint of §9. Adding a provider gets materially more
expensive, and in exchange every published workflow is proven to name a handler that exists.

**A startup check must compare the registry to the enum.** `ConfigSchemaConformance.Check` validates
property names, `required` and types — it does **not** look at `enum` values. A build whose
`IProviderHandler` registrations disagree with its registered config schema would therefore go ready
while lying about what it can do, in either direction: a handler present in code and absent from the
enum is unreachable by any workflow, and a name in the enum with no handler behind it publishes a
step that cannot run. `ProviderHandlerRegistry` therefore performs its own conformance check against
the resolved config schema definition and **refuses readiness on a mismatch**, naming both sets.

### 3.2 What no schema can check: right handler, wrong feed

**A data schema constrains structure, never provenance.** All three processors of the chain point at
the one tree row, and two different providers' workflows use byte-identical rows. Nothing in the
schema system knows which *feed* a step will carry, so a handler that is wrong-but-plausible for the
data publishes cleanly and fails only when real content arrives.

That failure lands in stage 1 or stage 2, which makes those two messages **the entire diagnostic for
the most likely operator mistake**. They are written for that reader: a `Locate` that finds nothing
reports that this handler recognized no items in this document, and a `Validate` failure reports
which expectation the content broke — never a bare parse error.

This is a residual risk, not a hole to be closed. Closing it would require the schema to express
provenance, which would mean one row per provider and would couple the generic processors on either
side to the provider list.

### 3.3 Pod-level options

```csharp
public sealed class SKNormalizerOptions
{
    public string FfmpegPath { get; set; } = "ffmpeg";
    public int ConversionTimeoutSeconds { get; set; } = 300;
    public long MaxItemBytes { get; set; } = 512L * 1024 * 1024;
}
```

Bound from `SKNormalizer__*` in the manifest, for the reason `ArchiveExpanderOptions.MaxExpandedBytes`
records: **these are numbers an operator sizes against a container limit, and a workflow author has no
way to know them.** A conversion timeout and a per-item ceiling are properties of the pod, not of the
business the step is doing.

---

## 4. Handler resolution

```csharp
public interface IProviderHandler { string Name { get; } /* stages, §5 */ }

internal sealed class ProviderHandlerRegistry
{
    public ProviderHandlerRegistry(IEnumerable<IProviderHandler> handlers);
    public IProviderHandler? Find(string name);   // OrdinalIgnoreCase
    public IReadOnlyList<string> Names { get; }
}
```

One `AddSingleton<IProviderHandler, XHandler>()` per provider in `ProcessorHost.Create`, exactly as
the expander registers one `IArchiveExtractor` per format. The registry builds a case-insensitive
dictionary at construction and **throws at startup on a duplicate name** — two handlers claiming one
key is a build-time mistake and must not be resolved by registration order at dispatch time.

Handlers are singletons and therefore **must be stateless**. Per-dispatch state lives in the pipeline's
locals. This is not merely a convention: the concrete processor is itself a singleton and is only safe
because prefetch is 1; a handler holding per-item fields would be the first thing to break if that
ever changed.

---

## 5. The pipeline

Eight stages, fixed order, one per dispatch. **The handler decides; the pipeline executes.** Stages 6
and 8 are the clearest expression of that split — the handler returns a *description* of what it wants
(a conversion profile, a layout) and shared code carries it out.

| # | stage | who | what |
|---|---|---|---|
| 1 | `Locate` | handler | finds the units of work in the incoming tree |
| 2 | `Validate` | handler | rejects content the provider got wrong |
| 3 | `Map` | handler | projects source fields into the standard metadata |
| 4 | `Augment` | handler | adds fields knowable **before** conversion |
| 5 | `NameFor` | handler | decides output file names |
| 6 | `ProfileFor` → transcode | handler decides, pipeline runs | ffmpeg |
| 7 | `Reconcile` | handler | folds what conversion **actually produced** back into the metadata |
| 8 | `LayoutFor` → assemble | handler decides, pipeline builds | the output tree |

### 5.1 Why stage 7 exists, and why it is not called `Enrich`

Duration, real output bitrate, the codec ffmpeg actually selected, the converted byte size and any
checksum of the result are **only knowable after ffmpeg has run**. A pipeline that renders XML before
conversion can describe the source file and nothing else. Stage 7 is where the output describes itself.

**It is `Reconcile`, not `Enrich`, because `Enrich` sitting next to `Augment` is a coin-flip for a
reader** — neither word says which runs when. The split is: `Augment` is what you know up front,
`Reconcile` is what only the output can tell you.

### 5.2 Why `NameFor` runs before conversion, and what that forbids

The transcoder needs a target name and the XML must reference the audio file it describes, so naming
precedes conversion. **The constraint that follows: a filename convention may use the requested
profile — the target extension, the bitrate asked for — but may not use measured output.** A provider
needing a measured duration in a filename forces `NameFor` to split into a pre-pass and a post-pass.
That is a known future move, recorded here so it is a decision rather than a surprise.

### 5.3 Types

```csharp
public sealed record SourceItem(string Key, IReadOnlyList<FileNode> Nodes);

public sealed class StandardMetadata { /* ordered element tree, mutable through stages 3,4,7 */ }

public sealed record AudioProfile(string TargetExtension, IReadOnlyList<string> Arguments);

public sealed record NormalizedAudio(
    byte[] Content, string Extension, long SizeBytes,
    TimeSpan? Duration, int? BitrateKbps, string? Codec);

public sealed record ItemNames(string MetadataFileName, string AudioFileName);

public sealed record NormalizedItem(
    SourceItem Source, StandardMetadata Metadata, ItemNames Names, NormalizedAudio? Audio);
```

`SourceItem.Key` is the handler's own identifier for the unit — a basename, a folder name, an index.
**It exists for failure messages**: a document of forty items whose ninth is malformed is useless to an
operator unless the message says which. It is derived from upstream content and so is reported in a
`FailedException` message but never logged from a template of ours; see §8.

### 5.4 The interface

```csharp
public interface IProviderHandler
{
    string Name { get; }

    IReadOnlyList<SourceItem> Locate(FileNode root);
    void Validate(SourceItem item);
    StandardMetadata Map(SourceItem item);
    void Augment(StandardMetadata metadata, SourceItem item);
    ItemNames NameFor(StandardMetadata metadata, SourceItem item);
    AudioProfile? ProfileFor(SourceItem item);
    void Reconcile(StandardMetadata metadata, NormalizedAudio? audio, ItemNames names);
    OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items);
}
```

`ProfileFor` returning **`null` means this item has no audio** — a metadata-only item is a legitimate
shape, not a failure, and the pipeline skips the transcode and passes `null` to `Reconcile`. An item
that *should* have audio and doesn't is stage 2's business, where it can be reported properly.

`ProviderHandlerBase` supplies defaults for the stages most providers won't vary — a `LayoutFor` that
puts every item's XML and audio flat in a `.zip` root, a no-op `Augment`, a `Reconcile` that writes
duration/codec/bitrate/size into fixed elements. A provider overrides what it needs. **The interface
stays the contract; the base class is a convenience and nothing may bind to it.**

### 5.5 Grouping is the handler's job, and that is the point

Pairing an audio file with its metadata sidecar differs per provider — `track01.wav` + `track01.xml`,
one metadata file describing a folder, structure carried in directory names. Putting it in `Locate`
means the processor never needs to know, and the operator's responsibility is to wire the step to the
handler that matches the feed. A mismatched handler produces a failed step with a message from stage 1
or 2, which is the correct outcome.

---

## 6. The assembler owns collapser-legality

A handler returns a **description** of the output tree; it never constructs a `FileNode`:

```csharp
public abstract record OutputNode
{
    public sealed record File(string Name, byte[] Content, DateTime? ModifiedUtc) : OutputNode;
    public sealed record Folder(string Name, string ArchiveExtension,
                                IReadOnlyList<OutputNode> Children) : OutputNode;
}

public sealed record OutputLayout(
    string RootName, string RootExtension, IReadOnlyList<OutputNode> Children);
```

`TreeAssembler` turns that into a `FileNode` and is **the only code in this processor that sets a node
name, sets an extension on an entries-bearing node, or computes `SizeBytes`/`EntryCount`.** It
enforces, in one place:

- no `/` or `\` in any name — rejected, never stripped, matching `ArchiveBuilder.Pack`;
- a writable archive extension on the root and on every `Folder`;
- the depth cap, checked against the tree schema row's depth (§1.2) rather than only against
  `ArchiveBuilder.MaxSupportedDepth`, because the row is the tighter bound and fails one hop later
  with far less diagnostic information;
- honest `SizeBytes` and `EntryCount`, counted from what was built.

**Because `Folder` *requires* an archive extension as a constructor argument and the assembler checks
it, a handler cannot express an uncollapsible container.** The rule is enforced by the type plus one
validator rather than by six handlers each remembering it.

**The writable-extension list is duplicated** — here and in the collapser's `IArchiveWriter`
registrations. That is a knowing duplication across process boundaries, pinned by a test that asserts
the two lists agree (§10).

---

## 7. The shared services

**`IAudioTranscoder` → `FfmpegAudioTranscoder`.** Takes source bytes, a source extension and an
`AudioProfile`; returns `NormalizedAudio`. Writes the input to a temp file, runs `FfmpegPath` with the
profile's arguments, reads the output, deletes both, and probes the result for duration, bitrate and
codec so stage 7 has something to fold. A non-zero exit, a timeout past
`ConversionTimeoutSeconds`, or an absent output file becomes a `NormalizationException`.

**No handler shells out.** One place composes a command line, one place has a timeout, one place
cleans up temp files, and one place is what a test replaces. The ffmpeg *arguments* are a handler's
business; *running* a process is not.

**`IMetadataRenderer` → `XmlMetadataRenderer`.** `StandardMetadata` → UTF-8 XML bytes. Purely
mechanical: encoding, declaration, indentation, escaping. A handler describes the document; it never
writes angle brackets.

**`IFieldWhitelist` → `PassThroughFieldWhitelist`.** The seam for the deferred Redis whitelist,
registered now as a no-op that admits everything and injected into handlers that will need it. It
exists now so that turning it on later is a registration swap rather than a reshaping of stages 3
and 4.

---

## 8. Failure, and the absence of partial output

**Every business rejection is a failed step. There is no partial output.** Nine good items and one bad
one produce a failed step, not nine standardized items — confirmed explicitly during design. A
downstream consumer must never have to ask whether the document it received is all of it.

The house pattern is followed exactly: **one exception type**, `NormalizationException`, thrown by
handlers and by the shared services, caught once in the processor and rethrown as a `FailedException`.
Bare `Exception` is **not** caught — a `NullReferenceException` in a handler is a programming error,
and reporting it to an operator as a bad provider document buries a bug under a plausible business
failure.

| class | message |
|---|---|
| payload | `step payload rejected: …` (§3) |
| envelope | `input branch did not carry a file document: {the branch is not JSON \| the branch is empty \| the root node carries no name}` |
| business | `normalizing {fileName} failed: item '{key}': {reason}` |

**Nothing logs before throwing.** `ProcessDispatchHandler` catches `FailedException` and writes the
message verbatim at Warning (since 614e688); a `logger.LogWarning` here would emit every failure
twice. **The message text is the contract an operator searches** — which is why the templates above
are fixed strings with the variable part last.

The envelope reader swallows `JsonException` without including its text, for the reason the collapser
records: the exception quotes the fragment that failed to parse, and that fragment is upstream content
that must not reach a log store.

### 8.1 The one success log line

```
normalized {FileName} with {Handler} into {ItemCount} items, {ConvertedCount} converted,
{OutputBytes} bytes
```

**Shape, never content.** A count, a size and an author-constant handler name are safe; item keys,
field values and metadata are upstream data and stay out of every template in this system. Item keys
appear only in a `FailedException` message, where the diagnostic need is acute and the volume is one
line per failed dispatch.

---

## 9. Deployment consequences

**A new provider handler is a new processor version, and it is a six-step loop.** It is a source
change in this project, so the project's `SourceHash` moves — and since the fold is project-only, a
framework edit would *not* move it but this does. Adding a provider means:

1. add the handler file and register it in `ProcessorHost.Create`;
2. **POST a new config schema row** whose `handler` enum includes the new name — the existing row's
   definition is frozen because it is referenced (§3.1);
3. rebuild;
4. `kind load`;
5. **repoint the SourceHash**;
6. repoint `ConfigSchemaId` and restart, so the startup conformance check of §3.1 sees the new pair.

**Steps 2 and 6 are the price of the publish-time check, and steps 5 and 6 are the ones most likely
to be skipped.** A skipped SourceHash repoint produces a pod running the old handler set while
registration claims otherwise; a skipped `ConfigSchemaId` repoint is caught, because the registry
refuses readiness when its handler names and the enum disagree.

**The image needs `ffmpeg`.** A Dockerfile change, and the first thing to verify on the first deploy —
a missing binary surfaces as every item failing conversion, which reads like a content problem.

**The manifest** is `k8s/41-processor-sknormalizer.yaml`, carrying `SKNormalizer__FfmpegPath`,
`SKNormalizer__ConversionTimeoutSeconds` and `SKNormalizer__MaxItemBytes`.

**Registration:** one processor row, with input and output schema both pointed at the existing tree
row (§1.2) and `ConfigSchemaId` pointed at this processor's own config row (§3.1). Wiring the step
into a published workflow is a separate act, and the edge check will refuse it if either data id
disagrees while `PayloadConfigSchemaValidator` will refuse it if the handler name is not in the enum.

---

## 10. Testing

**Pipeline, with a fake handler.** Stage order, that stage 7 sees the transcoder's output, that
`ProfileFor` returning null skips conversion, that a throw from any stage becomes one
`FailedException` naming the item key, that a second item is never processed after the first fails.

**`TreeAssembler` legality.** A path separator in a name, a `Folder` with a non-writable extension, a
root with a non-writable extension, a layout past the depth cap, and honest `SizeBytes`/`EntryCount`.

**The writer-list agreement test.** Asserts the assembler's writable-extension list matches the
collapser's registered `IArchiveWriter` extensions, pinning the §6 duplication.

**Payload tests.** Null, blank handler, unknown handler — the last asserting the message names the
available handlers, since that text is the whole diagnostic at dispatch.

**Registry/enum conformance.** A registered handler missing from the config schema enum, and an enum
name with no handler behind it, each refusing readiness and naming both sets. Plus the ordinary
`ConfigSchemaConformance` case: the config schema declares `handler`, requires it, and types it as a
string — which that check already covers and which this test pins against a future field.

**A publish-time test** asserting that a workflow naming an absent handler is rejected by
`PayloadConfigSchemaValidator`, since §3.1 makes that the primary defence and a silently-permissive
enum would demote it without any other test noticing.

**Envelope tests.** Not JSON, JSON `null`, a root with no name — each mapping to its own reason string.

**`FfmpegAudioTranscoder`** needs the binary and so is a `Category=RealStack` test, not part of the
hermetic suite.

**A chain test:** expander → normalizer (with a pass-through handler that renames and re-lays-out but
converts nothing) → collapser, asserting the collapser accepts what the normalizer emits. This is the
test that would catch a `TreeAssembler` rule drifting away from `ArchiveBuilder`.

---

## 11. Deliberately deferred

Each has a seam in this design and no implementation:

1. **The standard XML vocabulary** — what elements the standardized file actually contains.
   `StandardMetadata` and `XmlMetadataRenderer` hold the shape; the vocabulary is a handler's to
   state and a later decision to standardize.
2. **The ffmpeg argument sets** — `AudioProfile.Arguments` is the seam; no profile is designed here.
3. **The Redis field whitelist** — `IFieldWhitelist` is registered as a pass-through. Backing it with
   Redis, and deciding which fields it governs, is later work behind an unchanged interface.
4. **The provider list itself** — no `<Provider>Handler` is designed. The first real one will test
   whether the eight stages fit, and §5.2 records the most likely place they won't.

---

## 12. Open questions for review

- **Does the existing tree schema row admit the depth handlers will want?** §1.2 assumes reuse. If the
  first realistic layout needs more nesting than the row states, that is a re-registration touching
  three processors and should be decided before implementation rather than during.
- **Is the publish-time enum worth its cost?** §3.1 buys a publish-time rejection of an absent
  handler at the price of a new config schema row, a repoint and a restart per provider. The
  alternative is a plain `{"type":"string"}` and relying on the dispatch-time message of §3. The
  enum is recommended because the failure it prevents is silent until data flows — but it is the one
  decision here that adds recurring operational work, so it should be taken knowingly.
- **Is `MaxItemBytes` the right pod-level bound**, or should the ceiling be on the whole document the
  way the expander bounds total expanded bytes? A document of many small items and a document of one
  huge item fail differently under each.
