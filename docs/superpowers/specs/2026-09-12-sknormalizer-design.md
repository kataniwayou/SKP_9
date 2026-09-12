# Processor.SKNormalizer — a provider-aware standardizing transform

**Date:** 2026-09-12
**Status:** Designed, all decisions resolved. Not implemented.
**Introduces:** `src/Processor.SKNormalizer/`, `k8s/41-processor-sknormalizer.yaml`.
**Amends:** nothing. `BaseProcessor.Core` is unchanged; `Processor.ArchiveExpander` and
`Processor.ArchiveCollapser` are unchanged.
**Depends on:** the `{metadata, content}` tree contract the expander emits and the collapser
consumes, and an `ffmpeg` binary present in the processor image.

**Scope note.** This document designs the **structure**: the pipeline, the handler seam, the shared
services, the failure boundary, the deployment consequences. It deliberately does **not** design any
provider's business. The XML element vocabulary, the per-provider field maps, the ffmpeg argument
sets and the Redis whitelist's backing store are named as seams and left open — §12 lists them. That
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
packs it. **That freedom is deliberately not exercised by default**: §6.1 preserves the input
topology, and this section records what the contract permits, not what handlers do.

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

**No new schema row is created by default.** The consequence is a constraint on every handler: the
layout returned from stage 8 must fit within the depth the existing tree row already admits. **§6.1
satisfies this by construction** — preserving the input topology means the output depth equals the
input depth, and the input arrived through that same row. A handler that overrode the default to nest
deeper would be asking to re-register a frozen row that three other processors point at, and that is
a change to be made deliberately, once, not discovered by the first handler that needs it.

**The operator may still choose a per-feed input row, and §3.2 is why they would.** Pointing this
processor's `InputSchemaId` at a tighter variant — one stating entry counts and layout — turns a
wrong-feed document into a dispatch-time rejection. It costs a new row and a repoint on **both** sides
of that edge, since the edge check compares ids; it is a deliberate per-feed act, not the default.

### 1.3 The division of labour, and where it is enforced

> **The workflow is shaped for a file structure; the handler is the provider-specific piece within
> that shape.** SKNormalizer is the only place provider behaviour is *code*. Every other processor in
> the chain is generic, and so is every other payload in it.

**One workflow design therefore serves every provider that shares a structure.** The behavioural
payloads in the chain are functions of **file structure, not of provider identity**:
ArchiveExpander's `MaxDepth` is how deeply the archive nests, and ArchiveCollapser takes no payload
at all. Two providers whose files nest the same way share every one of those numbers. What remains
varying — FileFetcher's path, FilePersister's folder — is a **deployment coordinate**, where files
arrive and where they go, not behaviour. Providers dropping into the same watched location differ in
nothing but the handler name.

The only pedantic residue: a step payload is fixed at publish, so "swapping the handler" means
publishing another workflow of the same shape naming a different handler. It is reuse of the design,
not one running workflow serving many providers.

What the operator owns, and what checks it:

| operator decision | when a mistake surfaces |
|---|---|
| wiring the steps in order | **publish** — `SchemaEdgeValidator` compares row ids and refuses a mismatch |
| naming a handler that exists | **publish** — the config schema `enum` of §3.1 |
| authoring a per-feed input row | **dispatch** — `ProcessDispatchHandler` validates before the processor is entered (§3.2) |
| naming the handler that matches the *feed* | **never** — a wrong handler over structurally valid data is a silent success (§3.2.1) |
| the expander's `MaxDepth` | **dispatch** — stage 2, as an opaque leaf where entries were expected |

**The fourth row is the dangerous one, and §3.2.1 is why.** Every other mistake in this table is
refused by something. That one completes successfully and emits wrong output.

**`MaxDepth` deserves its own sentence because it is the subtlest of the five.** It decides whether a
nested archive reaches this processor as `FileContent.Entries` — openable, walkable by `Locate` — or
as a `FileContent.Bytes` leaf holding opaque base64. A handler that expects to look inside a nested
archive receives a blob when `MaxDepth` is set too low. That is a legible stage-2 failure rather than
a crash, but it is entirely the operator's doing, and the number lives in three places at once: the
expander's payload sets it, the tree row bounds it, and this processor's `LayoutFor` must stay inside
the same row on the way out.

### 1.4 Two layers: the contract is the processor's, the behaviour is the payload's

> **A schema states what a document must look like. A handler states how to interpret it.** They are
> different layers, owned by different things, set at different times.

| | belongs to | scope | set at |
|---|---|---|---|
| input / output schema | the **processor**, as part of its registered identity | one per processor edge | registration |
| provider handler | the **payload**, i.e. step configuration | per workflow step | publish |

**This is why a schema not distinguishing providers is correct rather than deficient.** Asking the
data contract to constrain which handler is appropriate would be asking it to encode a behavioural
choice that lives one layer up. The schema does not care where a document came from; provenance is
the payload's concern and the handler's, never the contract's.

**The processor's contract is exactly three things**, and nothing in it concerns provenance:

1. **Schema-valid data arrives** — enforced by `ProcessDispatchHandler` before the processor is
   entered. Not the handler's concern, and not the provider's.
2. **The named handler's tools are applied** to that data.
3. **Schema-valid data leaves** — enforced by `ProcessedDataHandler` after the send.

**Two providers whose data is identical but whose work differs are indistinguishable here, and
correctly so.** The processor did what the payload named, on data that validated, producing data that
validated. There is nothing left for it to be right or wrong about. Whether the named handler is the
*intended* business is an assertion made in the payload, and the processor has no standing to
second-guess it — see §3.2.1 for what that means operationally.

**One processor serves many workflows.** The processor row is registered once; any number of workflow
steps point at it carrying different handler names — exactly as ArchiveExpander serves many steps
with different `MaxDepth` values today. **The handler set is a property of the build; which handler
runs is a property of the dispatch.**

**The processor is stateless across dispatches, and §4 is what makes that true.** Nothing about
handler A survives into a dispatch naming handler B, because the handler is resolved fresh from the
payload every time. That is not inherited: the concrete processor is a **singleton**, and the
framework's own note records that per-dispatch state in a field on that instance is safe only because
prefetch is 1. Hence the rule in §4 that handlers hold no per-item state and that per-dispatch state
lives in the pipeline's locals — a stateful handler would break this silently.

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

**The registry and the enum must be kept in agreement, and the check is a test, not a startup
hook.** `ConfigSchemaConformance.Check` validates property names, `required` and types — it does
**not** look at `enum` values. A build whose `IProviderHandler` registrations disagree with its
registered config schema is wrong in either direction: a handler present in code and absent from the
enum is unreachable by any workflow, and a name in the enum with no handler behind it publishes a
step that cannot run.

**A runtime check is not available without amending the framework.**
`ProcessorStartupOrchestrator.ResolveDefinitionsAsync` fetches the config definition, hands it to
`ConfigSchemaConformance.Check(_processor.ConfigType, …)` and **never stores it** — there is no seam
a processor can hook. Adding one would amend `BaseProcessor.Core`, which this design does not.

**So the check lives where every other schema check in this repo lives: the test suite.** The
definition's source text is `src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json`, beside
`envelope.json`, `tree.json` and `locator.json`, and a test asserts that the registry's handler names
and that file's `enum` are the same set. Adding a handler and forgetting the enum fails the build,
which is the realistic drift. What remains uncovered is a *registered row* whose definition differs
from the checked-in file — the same exposure every schema row in this system already carries, and not
one this processor can close.

### 3.2 Per-feed input rows, and what stays in the payload layer

**The operator authors the schemas, and that is the right place for this knowledge.** The operator
knows what a provider ships and what the customer expects; nothing in this processor does. A per-feed
tree variant — one that states entry counts and layout rather than merely the generic
`{metadata, content}` shape — is an anticipated mechanism, not an abuse of one, and pointing this
processor's `InputSchemaId` at it is how feed expectations become enforceable.

**It fires at dispatch, before any handler runs.** `ProcessDispatchHandler` validates `data` against
`identity.InputDefinition` ahead of entering the processor, fails the step, and logs the validator's
own error text at Warning. A document from the wrong feed is therefore rejected with a structural
diagnosis rather than reaching stage 1 and producing a handler's guess at what went wrong.

**A per-feed row catches wrong data for this workflow. It does not catch a wrong handler, and it is
not supposed to.** Per §1.4 those are different layers: the schema constrains the document, the
payload names the interpretation. When two providers are structurally identical and differ only in
what their fields *mean*, no schema describing that structure can tell them apart — and asking one to
would be asking the contract to encode a payload-layer choice.

### 3.2.1 The residual failure is a silent success, not a failed step

**This must not be read as "stage 2 catches it."** Sometimes it does. Often it cannot, and the case
where it cannot is the one this chain is built to serve.

Consider the population §1.3 describes: several providers sharing a file structure, served by one
workflow design, distinguished only by the handler named in the payload. Substitute one of their
handlers for another and follow what happens. The input schema passes — the data is structurally what
it claims to be. `Locate` finds its items, because the layout is the shared one. `ValidateContent` objects to
nothing, because there is nothing structurally wrong. Stages 3 through 8 run to completion. The output
schema passes, because the output is structurally a valid tree.

**The step succeeds.** It emits a document standardized under the wrong provider's rules — wrong field
mapping, wrong constant fields, wrong naming — and every check in the system is satisfied.

**No layer detects this, and none is positioned to.** Not the edge check, which compares row ids. Not
the input or output schema, which constrain structure and, per §1.4, have no business encoding
provenance. Not stage 2, whose validation is about content correctness for the provider the handler
*believes* it is reading. Stage 2 only fires when the two providers' content happens to differ in a
way the substituted handler notices — which is precisely what structural similarity makes unlikely.

**The observable consequence is a completed workflow with bad output, not an alert.** There is no
failed step to search for, no Warning line, nothing in the projections that looks wrong. It surfaces
downstream, from whoever consumes the standardized files.

**This is not a defect in the processor, and it is important not to file it as one.** Per §1.4 the
processor's contract was satisfied completely: valid data in, the named handler's tools applied, valid
data out. It has no standing to second-guess which handler was named, and nothing it could check
would help. The unverifiable assertion lives in the payload, which is the operator's layer.

**So the only control is operator discipline**, and that is the honest statement of it. The risk is
recorded here not because this processor could reduce it, but because someone reading this design
should know the failure presents as a completed workflow rather than an alert.

Pushing provenance into the schema is the alternative, and it is worse: one row per provider,
coupling the generic processors on either side to the provider list, dissolving exactly the reuse
§1.3 describes. The trade is deliberate — cheap reuse across structurally identical providers, paid
for with an unverifiable assertion in the payload.



### 3.3 Pod-level options

```csharp
public sealed class SKNormalizerOptions
{
    public string FfmpegPath { get; set; } = "ffmpeg";
    public int ConversionTimeoutSeconds { get; set; } = 300;
}
```

Bound from `SKNormalizer__*` in the manifest, for the reason `ArchiveExpanderOptions.MaxExpandedBytes`
records: **these are numbers an operator sizes against a container limit, and a workflow author has no
way to know them.**

**There is deliberately no size ceiling here.** The input document already passed ArchiveExpander,
whose `MaxExpandedBytes` bounds total expanded content, so a second input ceiling in this processor
would restate an upstream guarantee. A per-item ceiling was considered and dropped: it bounds a peak
this chain does not produce, and it is one more number an operator has to keep consistent with
another.

**The consequence, stated so it is accepted rather than discovered: `MaxExpandedBytes` now sizes two
consumers, not one.** It bounds what the expander produces and, transitively, the working set every
conversion here operates on — and conversion can *grow* data, since transcoding to a less compressed
target produces more bytes than it consumed. Nothing bounds output size.

**If a pod does exhaust memory, prefetch 1 makes it a poison loop:** the unacked message is
redelivered and exhausts memory again. The mitigation is not code, it is sizing — `MaxExpandedBytes`
must be chosen with conversion headroom in mind, and that note belongs in
`k8s/37-processor-archiveexpander.yaml` beside the value, not only here.

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
| 2 | `ValidateContent` | handler | rejects content the provider got wrong |
| 3 | `Map` | handler | projects source fields into the standard metadata |
| 4 | `Augment` | handler | adds fields knowable **before** conversion |
| 5 | `NameFor` | handler | decides output file names |
| 6 | `ProfileFor` → transcode | handler decides, pipeline runs | ffmpeg |
| 7 | `Reconcile` | handler | folds what conversion **actually produced** back into the metadata |
| 8 | `LayoutFor` → assemble | handler decides, pipeline builds | the output tree |

### 5.0 Every stage is about content. None of them touches a schema.

**No stage validates a schema, and none needs to.** Schema validation happens at exactly two points,
both in the framework and neither reachable from a handler: `ProcessDispatchHandler` validates the
input against `identity.InputDefinition` **before** the processor is entered, and
`ProcessedDataHandler` validates the output **after** the send. A handler is handed data that has
already been proven to fit its contract, and its result is proven again on the way out.

**`ValidateContent` is named that way for this reason.** It checks that the *content* is correct for
the provider the handler believes it is reading — a missing required field, an audio stream that is
not what the metadata claims. Plain `Validate` next to a system with two schema-validation points is
the one name in the interface that could be misread as schema work, and one word removes the
ambiguity.

**`LayoutFor` is the only stage whose result is schema-relevant**, since a layout that nested too
deep would fail output validation. That is exactly why §6 puts legality in `TreeAssembler` and §6.1
preserves topology: **the handler makes a content decision and shared code guarantees the schema
consequence.** A handler never validates a schema, and it also never has to think about one.

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
`FailedException` message but never logged from a template of ours; see §9.

### 5.4 The interface

```csharp
public interface IProviderHandler
{
    string Name { get; }

    IReadOnlyList<SourceItem> Locate(FileNode root);
    void ValidateContent(SourceItem item);
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
name or sets an extension on an entries-bearing node.** It enforces, in one place:

- no `/` or `\` in any name — rejected, never stripped, matching `ArchiveBuilder.Pack`;
- a writable archive extension on the root and on every `Folder`;
- the depth cap, checked against the tree schema row's depth (§1.2) rather than only against
  `ArchiveBuilder.MaxSupportedDepth`, because the row is the tighter bound and fails one hop later
  with far less diagnostic information;
- a **computed** `SizeBytes` on every leaf (its content length) and a **computed** `EntryCount` on
  every node (its child count), while **carrying** a container's `SizeBytes` and every node's
  `CreatedUtc`/`ModifiedUtc` through unchanged — see §6.3.

**Because `Folder` *requires* an archive extension as a constructor argument and the assembler checks
it, a handler cannot express an uncollapsible container.** The rule is enforced by the type plus one
validator rather than by six handlers each remembering it.

**The writable-extension list is duplicated** — here and in the collapser's `IArchiveWriter`
registrations. That is a knowing duplication across process boundaries, pinned by a test that asserts
the two lists agree (§11).

### 6.3 What the assembler computes, and what it must carry

**An earlier draft of this section said the assembler computes "honest `SizeBytes` and `EntryCount`,
counted from what was built". That was wrong for containers, and it made this design's own acceptance
test unpassable.** Corrected here rather than left for an implementer to discover.

**Nothing is packed in this processor.** `ArchiveCollapser` builds the archives; this one emits a
document. So a container node has no built size to be honest about — and `ArchiveExpander` writes the
**source archive's byte length** there (`FileContentBuilder.cs:131`), along with `createdUtc` and
`modifiedUtc` on **every** node it emits (`:98`, `:131`).

| field | container | leaf |
|---|---|---|
| `SizeBytes` | **carried** from the layout | **computed** — content length |
| `EntryCount` | **computed** — child count | **computed** — zero |
| `CreatedUtc` / `ModifiedUtc` | **carried** | **carried** |

**Two shapes the first draft of this section did not admit, both found by the whole-branch review:**

**The root may be a leaf, and its bytes must survive.** `ArchiveExpander` emits a `Bytes` root for
any fetched file that is not a recognised archive — a CSV, an MP3, a PDF. The original `OutputLayout`
could not express that shape at all, so the mirror produced a container with no children and the
assembler turned it into an empty archive: **the document's content was silently destroyed, with no
failed step**. `OutputLayout` therefore carries a root `OutputNode` rather than a name and a child
list, which makes the shape expressible and the invalid state unrepresentable.

**"Expanded to nothing" is `null` at every depth, not just at the root.** The expander writes
`content: null` for an archive with no entries. A container whose children are null *or empty* must
therefore emit `null`, or a document containing a nested empty archive changes representation on the
way through and byte identity quietly stops holding.

**Computing a container's size as the sum of its children would break byte identity (§7.1), which is
the strongest statement this phase makes.** It would also be an invented number: the sum of decoded
entry sizes is not the size of any archive that exists. Carrying the upstream value misleads nobody —
`ArchiveCollapser` recomputes it from what it actually packs, and `CollapsedFile` records why.

**Dropping timestamps would lose provenance**, not merely fail a test. A downstream consumer reading
`modifiedUtc` off a standardized file is the reason the envelope carries it at all.

### 6.1 The default layout preserves the input topology

**A handler does not reshape the document. Same nesting, same entry count; only contents, names and
extensions change.** A metadata entry becomes an XML file, an audio entry becomes a converted audio
file, and both keep their position in the tree.

`ProviderHandlerBase.LayoutFor` therefore **mirrors the input tree** and most handlers will never
override it. That is the default because it is what the business actually does, and it has a useful
property: **the output depth equals the input depth**, and the input arrived through the tree row, so
the row admits the output by construction. §1.2's depth constraint is satisfied without a handler
having to think about it.

### 6.2 Artifacts are optional, and substitution belongs to the handler

**The pipeline does not force an XML file into the output.** Stages 3, 4 and 7 build a metadata
model, and the pipeline renders it after stage 7 — but whether it *enters the tree* is stage 8's
decision, and stage 8 belongs to the handler.

**The default mirror substitutes nothing. It reproduces the input document exactly** — topology,
names, extensions, sizes and both timestamps. That is what an identity handler needs, and it is what
makes §6.1's "output depth equals input depth" true by construction.

**A handler that emits artifacts overrides `LayoutFor` and builds its own layout.** It has
everything it needs: `LayoutFor` receives `IReadOnlyList<NormalizedItem>`, and each item carries its
rendered `MetadataDocument`, its converted `Audio` and the `Names` chosen at stage 5.

> **An earlier draft of this section said the default mirror substitutes artifacts per leaf. It did
> not, and the code that claimed to — a `replacements` dictionary threaded through the recursion and
> never read — was deleted rather than completed.** Completing it would have required the base class
> to decide which source node corresponds to which artifact, and that correspondence is exactly the
> open question §14 records: the pipeline currently picks the audio node by "first node carrying
> bytes", which a real provider layout may not satisfy. Baking that guess into the shared mirror
> would have made it a rule every handler inherits. The first real handler should settle it.

**Optionality is still real and still load-bearing.** `NormalizedItem.MetadataDocument` is null when
the handler produced no metadata, so a handler's own `LayoutFor` can pass a leaf through rather than
replace it — which is how a metadata-only item, and a deliberate pass-through, are expressed.

**One exception, and it is a production surprise if it is not written down: `.rar`.** The expander
*reads* rar; the collapser cannot *write* it — the format is proprietary and readable-only. A
provider shipping `.rar` archives therefore produces an input tree whose root is named `.rar`, and a
faithful mirror keeps that name straight into a collapser refusal.

**Why rar cannot simply be written.** RAR is proprietary: RarLab's `unrar` licence permits
decompression only and explicitly forbids using that source to build a compressor, so no open library
implements rar writing. SharpCompress reads rar and does not write it, and `RarExtractor`'s own
comment records it — *"Read-only, and that is the format's limit rather than this class's."* The
asymmetry is visible in the file layout: the expander has three extractors, the collapser has two
writers. It is permanent, and no change in this processor can close it.

**So the mirror preserves *topology*, not extensions.** `TreeAssembler` re-targets any container node
whose extension names no writer to a configured default — `.zip` — and does so in the one place that
already owns extension rules. A leaf keeps whatever extension its handler gave it; only
entries-bearing nodes are re-targeted, and only when the source format cannot be written.

**A rar-sourced document therefore cannot round-trip byte-identically**, and that is a property of the
format rather than a defect here. The output archive is a different container holding the same
entries.

---

## 7. The shipped handler

### 7.1 `SampleHandler` — identity, and the whole seam proven

**This phase ships exactly one handler, and it does the minimum: it returns the input tree
unchanged.** No XML, no conversion, no renaming. `Locate` returns the items, `ValidateContent` objects to
nothing, `Map` builds an empty model, `Augment` and `Reconcile` are no-ops, `ProfileFor` returns
`null` for every item, and `LayoutFor` takes the mirror default — which, by §6.2, carries every leaf
through untouched.

**It is not a placeholder. It exercises everything structural in one dispatch:** payload validation,
the config schema enum, handler resolution through the registry, the envelope read, all eight stages
in order, the assembler's legality rules, serialization through `FileNodeConverter`, and the send on
the inbound `executionId`. The only things it does not touch are `XmlMetadataRenderer` and
`FfmpegAudioTranscoder` — the two pieces that are pure provider business and have no design here.

**And it gives the phase a strong acceptance test almost free.** The collapser design already proves
**byte identity**: ArchiveExpander's input equals ArchiveCollapser's output. Inserting an identity
normalizer into that chain must leave the property holding. If FileFetcher → Expander → SKNormalizer
→ Collapser still round-trips byte-identically, the seam is proven end to end — a stronger statement
than any schema check, for the reason the collapser design gives: a schema asserts a document has the
right shape, identity asserts it round-tripped losslessly.

**The identity test must use a `.zip` or `.tar` source.** A rar-sourced document cannot round-trip
byte-identically (§6.1), so using one would fail the test for a reason that is not this processor's
doing.

**It stays shipped after real handlers arrive.** It is the regression test for the pipeline itself:
any change to the stages, the assembler or the serialization that breaks identity breaks this first,
with nothing provider-specific in the way to obscure it.

---

### 7.2 `AcmeHandler` — the first mapping handler

**One item, two entries: an audio file and its metadata sidecar.** `AcmeHandler` is the shape §5.5
describes, made concrete. It pairs a `.wav` with the `.json` beside it, maps the JSON into the
standard metadata of §7.3, passes the audio through **byte-for-byte**, and emits a `.zip` root with
two entries at depth 1 — the same topology it received, with the `.json` replaced by an `.xml`.

**It converts no audio, and that is deliberate for a first handler.** `ProfileFor` returns null, so
nothing transcodes. That keeps the open question of §14 — which node in an item is the audio — from
being answered by accident: with no conversion, the pipeline's "first node carrying bytes" guess
never fires, and `AcmeHandler` selects nodes by extension in its own code, where a handler's
knowledge belongs.

**It is the first handler to override `LayoutFor`**, which is exactly the path §6.2 describes: the
default mirror substitutes nothing, so a handler that emits an artifact builds its own layout from
the `MetadataDocument`, `Audio` and `Names` its items carry.

**`SampleHandler` stays shipped beside it.** §7.1 makes it the pipeline's own regression test, and
identity is a property no mapping handler can prove. Two handlers also exercise the registry and the
config schema `enum` with more than one entry, which is a better test of that machinery than one.

### 7.3 The standardized XML, and why its shape is fixed

> **Every handler emits the same document. Only the values differ — never the element names, never
> the structure.** The vocabulary below is hardcoded and shared; a provider's peculiarity is
> expressed by what a handler *puts in* these elements, never by adding its own.

```xml
<?xml version="1.0" encoding="utf-8"?>
<metadata>
  <source>
    <provider>Acme</provider>
    <originalName>track01.json</originalName>
    <ingestedUtc>2026-09-12T04:31:00Z</ingestedUtc>
  </source>
  <descriptive>
    <title>Nocturne in E-flat</title>
    <artist>Unknown</artist>
    <album>Field Recordings</album>
    <recordedUtc>2026-03-04T05:06:07Z</recordedUtc>
  </descriptive>
  <audio>
    <fileName>track01.wav</fileName>
    <codec>pcm_s16le</codec>
    <durationSeconds>184.2</durationSeconds>
    <sampleRateHz>44100</sampleRateHz>
    <channels>2</channels>
    <bitrateKbps>1411</bitrateKbps>
  </audio>
</metadata>
```

**The three groups map onto the pipeline's stages, which is what makes the shape defensible for
handlers that do not exist yet:**

| group | what it holds | which stage fills it |
|---|---|---|
| `<source>` | provenance — who sent it, what it was called, when it arrived | `Map` (originalName) and `Augment` (provider, ingestedUtc) |
| `<descriptive>` | the provider's own metadata | `Map` — this is where per-provider mapping work lives |
| `<audio>` | per-file fact | `Map` when the provider states it, **corrected by `Reconcile`** when a conversion actually produces it |

**`<audio>` exists as its own group because of stage 7.** Duration, codec and bitrate are knowable
nowhere before a conversion runs (§5.1); grouping them separately is what lets `Reconcile` overwrite
provider claims with measured fact without touching anything else.

**Required, and always present:** `source/provider`, `source/originalName`, `source/ingestedUtc`,
`descriptive/title`, `audio/fileName`. The system always knows these.

**Optional, and OMITTED ENTIRELY when unknown — never emitted empty.** That follows the rule
`NormalizedAudio` already sets: a probe that could not determine a value must not have one invented
(§5.3). An empty `<durationSeconds/>` is a claim that the duration is nothing; an absent element is
the truth.

**Every value is formatted with `CultureInfo.InvariantCulture`, and timestamps as
`yyyy-MM-ddTHH:mm:ssZ`.** Not cosmetic: a machine whose locale uses a comma decimal separator would
otherwise render `184,2`, and the same handler would produce different documents on different nodes.

---

## 8. The shared services

**`IAudioTranscoder` → `FfmpegAudioTranscoder`.** Takes source bytes, a source extension and an
`AudioProfile`; returns `NormalizedAudio`. Writes the input to a temp file, runs `FfmpegPath` with the
profile's arguments, reads the output, deletes both, and probes the result for duration, bitrate and
codec so stage 7 has something to fold. A non-zero exit, a timeout past
`ConversionTimeoutSeconds`, or an absent output file becomes a `NormalizationException`.

**No handler shells out.** One place composes a command line, one place has a timeout, one place
cleans up temp files, and one place is what a test replaces. The ffmpeg *arguments* are a handler's
business; *running* a process is not.

**`IMetadataRenderer` → `XmlMetadataRenderer`.** `StandardMetadata` → UTF-8 XML bytes. A handler
describes the document; it never writes angle brackets.

**It is the single definition of the document's structure and element order** (§7.3). Because the
vocabulary is fixed and this is the only code that writes it, "every handler emits the same document"
is true by construction rather than by discipline — there is no code path by which a handler could
emit a different shape.

**`StandardMetadata` is therefore a fixed-shape type, not a key/value bag.** An earlier draft gave it
`Set(string, string)` and an ordered element list, which let any handler invent a key, misspell one,
or omit one with nothing noticing — the document would still render, just differently from every
other handler's. Named properties make an invented key impossible and a misspelled one a compile
error.

**It stays mutable rather than becoming a record**, because its values arrive across three stages
(`Map`, `Augment`, `Reconcile`) and the handler interface hands the same instance to each. Required
fields are therefore checked rather than compiler-enforced, once, in the pipeline:

| state after stage 7 | outcome |
|---|---|
| every property unset | **no document** — the leaf passes through. This is what keeps `SampleHandler` identity. |
| some set, a required one missing | `NormalizationException` **naming the missing elements** |
| complete | rendered |

That tri-state is what replaces the old `IsEmpty` check, and it preserves optional emission (§6.2)
while making an incomplete document a legible failure instead of a quietly different file.

**`IFieldWhitelist` → `PassThroughFieldWhitelist`.** The seam for the deferred Redis whitelist,
registered now as a no-op that admits everything and injected into handlers that will need it. It
exists now so that turning it on later is a registration swap rather than a reshaping of stages 3
and 4.

---

## 9. Failure, and the absence of partial output

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

### 9.1 The one success log line

```
normalized {FileName} with {Handler} into {ItemCount} items, {ConvertedCount} converted,
{OutputBytes} bytes
```

**Shape, never content.** A count, a size and an author-constant handler name are safe; item keys,
field values and metadata are upstream data and stay out of every template in this system. Item keys
appear only in a `FailedException` message, where the diagnostic need is acute and the volume is one
line per failed dispatch.

---

## 10. Deployment consequences

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
registration claims otherwise; a skipped `ConfigSchemaId` repoint leaves the pod
validating payloads against the old enum, and the new handler is unreachable until it is done.

**The image needs `ffmpeg`.** A Dockerfile change, and the first thing to verify on the first deploy —
a missing binary surfaces as every item failing conversion, which reads like a content problem.

**The manifest** is `k8s/41-processor-sknormalizer.yaml`, carrying `SKNormalizer__FfmpegPath`,
`SKNormalizer__ConversionTimeoutSeconds` — and no size ceiling, for the reason §3.3 records.

**Registration:** one processor row, with input and output schema both pointed at the existing tree
row (§1.2) and `ConfigSchemaId` pointed at this processor's own config row (§3.1). Wiring the step
into a published workflow is a separate act, and the edge check will refuse it if either data id
disagrees while `PayloadConfigSchemaValidator` will refuse it if the handler name is not in the enum.

---

## 11. Testing

**Pipeline, with a fake handler.** Stage order, that stage 7 sees the transcoder's output, that
`ProfileFor` returning null skips conversion, that a throw from any stage becomes one
`FailedException` naming the item key, that a second item is never processed after the first fails.

**`TreeAssembler` legality.** A path separator in a name, a `Folder` with a non-writable extension, a
root with a non-writable extension, a layout past the depth cap, and honest `SizeBytes`/`EntryCount`.

**The writer-list agreement test.** Asserts the assembler's writable-extension list matches the
collapser's registered `IArchiveWriter` extensions, pinning the §6 duplication.

**Topology preservation (§6.1).** The default `LayoutFor` returns a layout whose nesting and entry
counts match the input for a two-level document; and a `.rar`-rooted input produces a `.zip`-rooted
output while every other name and position is unchanged. The second is the test that would have
caught the rar trap in production instead of in review.

**Metadata preservation (§6.3).** Both timestamps survive on the root, on an interior container and
on a leaf — pinned to distinct values, since two not-null checks would pass just as happily on a
transposition. And a container's `SizeBytes` is the one it was given rather than the sum of its
children.

**Payload tests.** Null, blank handler, unknown handler — the last asserting the message names the
available handlers, since that text is the whole diagnostic at dispatch.

**Registry/enum conformance.** The registry's handler names and the `enum` in
`Schemas/sknormalizer-config.json` are the same set — failing when a handler is added without the
enum, or an enum name has no handler. Plus the ordinary
`ConfigSchemaConformance` case: the config schema declares `handler`, requires it, and types it as a
string — which that check already covers and which this test pins against a future field.

**A publish-time test** asserting that a workflow naming an absent handler is rejected by
`PayloadConfigSchemaValidator`, since §3.1 makes that the primary defence and a silently-permissive
enum would demote it without any other test noticing.

**Envelope tests.** Not JSON, JSON `null`, a root with no name — each mapping to its own reason string.

**`FfmpegAudioTranscoder`** needs the binary and so is a `Category=RealStack` test, not part of the
hermetic suite.

**The identity chain test, and it is the acceptance test for this phase.** FileFetcher → Expander →
SKNormalizer with `SampleHandler` → Collapser, asserting the byte identity the collapser design
already proves still holds with this processor inserted. It is the strongest available statement
about the seam — a schema asserts shape, identity asserts lossless round-trip — and it is what would
catch a `TreeAssembler` rule drifting away from `ArchiveBuilder`. **Source must be `.zip` or `.tar`:**
a rar-sourced document cannot round-trip byte-identically (§6.1), for reasons outside this processor.

**A re-targeting chain test:** the same chain with a `.rar` source, asserting the collapser accepts
the output and the root arrives as `.zip` — identity deliberately not asserted.

---

## 12. Deliberately deferred

Each has a seam in this design and no implementation:

1. ~~**The standard XML vocabulary**~~ — **CLOSED.** Defined in §7.3 and hardcoded into
   `StandardMetadata` and `XmlMetadataRenderer`. It is shared by every handler: values differ,
   element names and structure never do.
2. **The ffmpeg argument sets** — `AudioProfile.Arguments` is the seam; no profile is designed here.
3. **The Redis field whitelist** — `IFieldWhitelist` is registered as a pass-through. Backing it with
   Redis, and deciding which fields it governs, is later work behind an unchanged interface.
4. **The provider list itself** — `SampleHandler` (§7.1, identity) and `AcmeHandler` (§7.2, the
   first mapping handler) ship. No handler converts audio yet, so `AudioProfile` and the transcoder
   remain unexercised by any shipped handler, and §5.2's warning about `NameFor` preceding conversion
   is still untested in anger.

---

## 13. Resolved decisions

All three questions raised at design time are closed. They are recorded here with what was chosen and
what was accepted along with it.

**The config schema carries an `enum` of handler names (§3.1).** Chosen for the publish-time
rejection: an operator naming a handler that does not exist is refused while they are still at the
screen, rather than at the first dispatch after data arrives. **Accepted cost:** every new provider
needs a new config schema row, a `ConfigSchemaId` repoint and a restart on top of the rebuild and
SourceHash repoint, and the registry carries its own startup conformance check because
`ConfigSchemaConformance` does not read enum values.

**Handlers preserve the input topology (§6.1).** A handler does not reshape the document — same
nesting, same entry count, changed contents, names and extensions. This closes the depth question
entirely: output depth equals input depth, and the input reached this processor through the tree row,
so the row admits the output by construction. **Accepted alongside it:** the `.rar` re-targeting rule,
because the expander reads a format the collapser cannot write, and a faithful mirror would walk a rar
document straight into a collapser refusal.

**There is no size ceiling in this processor (§3.3).** `ArchiveExpander`'s `MaxExpandedBytes` is the
single bound, and `MaxItemBytes` is dropped rather than restating an upstream guarantee with a second
number to keep consistent. **Accepted risk:** that number now sizes two consumers, conversion can grow
data, output size is unbounded, and an out-of-memory pod at prefetch 1 is a redelivery loop rather
than a single failure. The mitigation is sizing `MaxExpandedBytes` with conversion headroom, noted in
the expander's manifest beside the value.

## 14. Open questions

**Which node in an item is the audio?** `ProfileFor` tells the pipeline *how* to convert but never
*what*, so `NormalizationPipeline` picks `item.Nodes.FirstOrDefault(n => n.Content is
FileContent.Bytes)` — the first node carrying bytes. For the canonical item this design describes,
an audio file plus its metadata sidecar (§5.5), that resolves to whichever node `Locate` happened to
put first, so a handler must encode "audio first" as an undocumented convention.

**Deliberately left open rather than guessed at.** The fix is either that `ProfileFor` names the
node it wants converted, or that `SourceItem` distinguishes its audio member — and which is right
depends on what a real provider's items actually look like. Settling it now would bake a convention
into the shared pipeline that every later handler inherits. §6.2 records the same reasoning for why
the default mirror substitutes nothing.

Otherwise nothing blocking. The first real provider handler is what will test whether the eight
stages fit; §5.2 records the most likely place they will not.
