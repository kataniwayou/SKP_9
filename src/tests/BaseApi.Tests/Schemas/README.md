# Envelope, tree, and locator schemas

Three shapes, three files, shared across the pipeline's processors rather than owned by any one of
them:

| shape | file | is the contract for |
|---|---|---|
| locator | `locator.json` | KafkaImporter output = FileFetcher input |
| envelope | `envelope.json` | FileFetcher output = ArchiveExpander input = ArchiveCollapser output |
| tree | `tree.json` | ArchiveExpander output = ArchiveCollapser input |

Each file is registered as a database row against a processor identity — the same file backs both
ends of a hop, since the processor on either side of it agrees on one shape. Nothing in `src/` reads
any of these files directly any more; see [Registration](#registration).

## The locator schema

`locator.json` is the file KafkaImporter puts on the wire and FileFetcher reads back off it — the
first hop in the pipeline, before there is any file content to carry. `FileFetcherProcessor.ReadPath`
is the code that consumes this shape; see its comments for the full accept/reject logic.

What it asserts:

- One key, `filePath`, REQUIRED, `additionalProperties: false`. A branch that carries no `filePath`
  key at all is exactly the case `ReadPath` reports as "the branch carries no filePath".
- `filePath` is `{ "type": "string", "minLength": 1 }` — a string and non-empty, with no `"null"` in
  its `type`. The C# record behind it, `FileLocator(string? FilePath)`, declares the property
  nullable, but that nullability is a DESERIALIZATION concern, not a contract one: `string?` exists so
  a malformed branch can be caught and turned into a diagnosed `FailedException` instead of an
  unhandled throw. A valid branch — the thing this schema is a contract for — always carries a
  present, non-empty `filePath`. `ReadPath`'s own pattern match, `locator?.FilePath is { Length: > 0 }
  filePath`, treats a null `filePath` and an empty-string `filePath` identically to a missing one —
  all three fall through to "the branch carries no filePath" — so the schema mirrors that by
  disallowing all three at once via `required` + non-nullable `type` + `minLength: 1`.

### What it deliberately does not assert

**That `filePath` is absolute.** `ReadPath` additionally requires `Path.IsPathFullyQualified(filePath)`
and rejects a relative path with a separate reason ("the path is relative, and only an absolute path
names one location") — but that check is NOT encoded here as a `pattern`. "Absolute" is
platform-dependent: `C:\orders\a.csv` is fully qualified on Windows and `/orders/a.csv` is fully
qualified on Linux, and which one is valid depends on where the pod that produced the branch runs, not
on the schema. A regex trying to approximate `IsPathFullyQualified` would either reject a legal
absolute path on one platform or admit an illegal relative one on the other — worse than not checking
at all. This is exactly the kind of gap this codebase documents rather than silently drops:
`Path.IsPathFullyQualified` stays a runtime check in `FileFetcherProcessor`, and the schema's job stops
at "a non-empty string is present."

## The envelope schema

`envelope.json` is the file FileFetcher puts on the wire and ArchiveExpander reads back off it — and
the shape ArchiveCollapser writes to reassemble a tree into a single file again.

What it asserts:

- Six keys, `additionalProperties: false`. A key nobody agreed on must not travel silently — in
  particular `filePath`, which is deliberately absent from the envelope.
- Every key is REQUIRED and present, including the two timestamps that are frequently null.
  FileFetcher's own serializer is configured `DefaultIgnoreCondition.Never` for exactly this reason.
- `content` is a base64 string. An empty file is `""`, which is why there is no `minLength` on it.
- `extension` has no `minLength` either: a file with no dot in its name has `FileInfo.Extension` of
  `""`, and such a file is legal under the `*.*` whitelist.
- `fileName` DOES carry `minLength: 1`. There is no such thing as a file without a name, and the
  tree schema's root metadata node requires one too.

## The tree schema

`tree.json` is the BASELINE: the shape every ArchiveExpander document has, and nothing about a
particular feed. ArchiveCollapser reads the same file as its input schema, one hop downstream.

### What the tree schema asserts

- The `{metadata, content}` node, `additionalProperties: false` at every level.
- `content` is one key holding one of three things: a base64 string (a file's bytes), an array of
  nodes (what an archive expanded to), or null (an archive that expanded to nothing). It is never
  two keys that can disagree — see `FileContent` for why that pair was collapsed.
- **Any depth.** One `node` definition whose `items` point back at itself. A validator resolves the
  `$ref` only when it has an array element in hand, so it expands exactly as far as the document
  nests and no further.

## Depth is NOT expressed here, and this file used to say the opposite

**This section argued the reverse until 2026-09-11, and the reversal is the point.** It used to hold
an unrolled ladder — `depth2` → `depth1` → `depth0`, the last admitting only a string — and it
rejected the self-referencing form in as many words: *"a schema that admits any depth can never tell
you the depth was wrong."*

Three things retired that argument.

**A depth ceiling cannot be exact, so it was never telling you the depth was wrong.** Archive trees
are ragged: a `.zip` holding `readme.csv` beside `inner.zip` ends one branch at level 2 and its
sibling at level 3, in one document, at one `MaxDepth`. Every level therefore had to admit
`["string","array","null"]` so a branch could stop early — which means the ladder only ever caught
documents that were too DEEP, never ones that were too shallow. It was a ceiling, not a shape.

**The ceiling was checked twice and the wrong copy was authoritative.** `MaxDepth` is validated into
`1..ArchiveExpanderConfig.MaxSupportedDepth` before a file is opened; this file re-stated a bound
nothing kept in sync with it. A step raised past the schema produced a document rejected by the post
handler with `EntryId: Guid.Empty` and no file name — a depth fault diagnosed as an anonymous
validation failure one hop later. That is strictly worse than the config validator rejecting it up
front, by name, with the value it was given.

**Raising it cost a migration every time.** A schema row is frozen once referenced, so every depth
change meant a new row, both processors repointed, and both restarted — for a number that was
already enforced elsewhere.

So the bound now lives in exactly one place: `MaxSupportedDepth`, currently 4, checked by the
expander before any file is opened and again by `ArchiveBuilder` on the way back up. This file states
the SHAPE and says nothing about how far it nests.

**What was given up, stated plainly.** A document deeper than intended is no longer a validation
failure here. It is a rejected payload at the expander (above `MaxSupportedDepth`), or an
`ArchiveWritingException` at the collapser naming the node it tripped on (a document from elsewhere),
or — past roughly 32 node levels — a `JsonSerializerOptions.MaxDepth` fault the collapser reports as
`the branch is not JSON`. The first two are better diagnoses than this file ever produced. The third
is worse, and is the reason `MaxSupportedDepth` was brought down to a number well below that wall.

**One output schema per processor identity still holds.** `OutputSchemaId` is a column on the
processor row, not the step, so every workflow using ArchiveExpander shares this shape. What changed
is that sharing a shape no longer means sharing a depth limit — steps differ by `MaxDepth` alone, and
none of them needs its own processor identity to nest deeper than another.

## What it cannot assert

**Anything about file content.** `content` is base64, so the bytes are unconstrained by
construction. `format` and `contentEncoding` are ANNOTATIONS in 2020-12, not assertions, and
`ProcessorJsonSchemaValidator.DefaultOptions` does not enable format assertion — adding
`"format": "date-time"` to the timestamps would document them and enforce nothing. Use `pattern` if
that is ever needed.

**Which of the three `content` forms a given node should have.** `type: ["string", "array", "null"]`
admits all three at every node, because the root may legitimately be any of them: a plain file, an
expanded archive, or an empty one. A feed that always ships an archive can narrow it — see below.

## Per-feed variants

Entry count is enforced HERE rather than in the step payload, so a feed with a fixed layout gets its
own schema derived from this one. Constrain `content`, never `metadata.entryCount` — the array is
the fact, the count is derived, and pinning the derived field would let a counting bug satisfy a
rule the content fails.

Always an archive, exactly three entries. There is one definition to point at now — `node` — rather
than a level one step shallower than the root, which is the practical difference the recursive form
makes to a variant:

    "content": { "type": "array", "minItems": 3, "maxItems": 3,
                 "items": { "$ref": "#/$defs/node" } }

Dropping `"string"` and `"null"` from the type is what makes it "always an archive": a plain file or
an empty archive now fails.

One `.wav` and two `.csv`, order-independent. This variant is deliberately NARROWER than the one
above: a `.wav` or `.csv` entry is always a leaf on the wire, never itself a further archive, so it
The ladder expressed that by pointing at `depth0`, whose content was string-only; with one
recursive definition the leaf-ness has to be stated rather than inherited, so the variant declares
its own `leaf` refinement:

    "leaf": { "$ref": "#/$defs/node", "properties": { "content": { "type": "string" } } }

Note also that `minContains`/`maxContains` must sit beside their OWN `contains`, so two cardinality
rules need two subschemas under `allOf`:

    "content": {
      "type": "array", "minItems": 3, "maxItems": 3,
      "items": { "$ref": "#/$defs/leaf" },
      "allOf": [
        { "contains": { "$ref": "#/$defs/wav" }, "minContains": 1, "maxContains": 1 },
        { "contains": { "$ref": "#/$defs/csv" }, "minContains": 2, "maxContains": 2 }
      ]
    }

with narrowing definitions that REFINE `leaf` rather than replace it — legal because `$ref` takes
sibling keywords in 2020-12, and note the omitted `additionalProperties`, which only ever sees
`properties` declared in the same schema object:

    "wav": { "$ref": "#/$defs/leaf",
             "properties": { "metadata": { "properties": { "extension": { "const": ".wav" } } } } }

## Registration

**None of these schemas is registered by the build.** Each is a database row against a processor identity,
applied as a deploy step. Until it is, the corresponding `OutputSchemaId` is null, `TryValidate`
returns true without decoding anything, and **nothing enforces entry count or depth anywhere** —
this file is their only home.

Note what a failure costs, because it decides where checks belong: the post handler reports
`Failed` with `EntryId: Guid.Empty` and acks. Nothing is written to L2 and the step's input was
already reclaimed, so the branch is gone with no key to recover it and no file path in the log. Every
check that CAN live in `ProcessAsync` does.
