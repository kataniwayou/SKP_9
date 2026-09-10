# Envelope and tree schemas

Two shapes, two files, shared across all three processors in this pipeline rather than owned by any
one of them:

| shape | file | is the contract for |
|---|---|---|
| envelope | `envelope.json` | FileFetcher output = ArchiveExpander input = ArchiveCollapser output |
| tree | `tree.json` | ArchiveExpander output = ArchiveCollapser input |

Each file is registered as a database row against a processor identity — the same file backs both
ends of a hop, since the processor on either side of it agrees on one shape. Nothing in `src/` reads
either file directly any more; see [Registration](#registration).

## The envelope schema

`envelope.json` is the file FileFetcher puts on the wire and ArchiveExpander reads back off it — and,
once it exists, the shape ArchiveCollapser writes to reassemble a tree into a single file again.

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
- **Depth two, structurally.** `depth2` may hold an array of `depth1`, `depth1` may hold an array of
  `depth0`; `depth0`'s `content` is a string and nothing else, so it cannot hold entries. That is the
  whole depth rule: root, one archive of archives, one archive of leaves — a zip inside a zip, both
  expanded.

## How depth is expressed, and why it is not a keyword

JSON Schema has no depth keyword, and there is no way to say "at most two levels" without writing
the levels out. So the bound is a property of the STRUCTURE: N node definitions, each referencing
the next, and the last one admitting only a string. You read the limit by counting the definitions.

To admit a zip whose entries are themselves zips of zips — `MaxDepth: 3` on the step — add a level
and repoint the root:

    "$ref": "#/$defs/depth3",

    "depth3": {
      "type": "object", "additionalProperties": false,
      "required": ["metadata", "content"],
      "properties": {
        "metadata": { "$ref": "#/$defs/metadata" },
        "content": { "type": ["string", "array", "null"],
                     "items": { "$ref": "#/$defs/depth2" } }
      }
    },

leaving `depth2`, `depth1` and `depth0` as they are. Each level is the same object with `items`
pointing one step shallower.

**The alternative — a self-referencing `$ref` admitting any depth — is rejected.** It would validate
every document this processor can produce, which sounds like a feature and is the opposite: a schema
that admits any depth can never tell you the depth was wrong. The unrolled form is what makes a
`MaxDepth` the schema does not expect show up as a validation failure instead of a surprise
downstream.

**The widening from depth 1 to depth 2 was a deliberate LOOSENING, and it has a cost.** A depth-1
document still validates, because `depth1` admits string content — so nothing broke. But a step
running at `MaxDepth: 1` and producing a shallow document is no longer distinguishable by this
schema from one that should have gone deeper. The schema now says less about what a given feed
should look like, which is precisely why per-feed variants exist below.

**Nothing keeps `MaxDepth` and this file in sync, and that is deliberate.** The step payload states
what to expand; this states what a document may look like. When they disagree the document fails
validation, exactly as a wrong entry count does. Note what that costs before raising either: the post
handler reports `Failed` with `EntryId: Guid.Empty` and no file path, so the processor logs the depth
it actually reached in `ProcessAsync` — that log line is where the diagnosis lives.

**The depth here caps every workflow using this processor.** `OutputSchemaId` is a column on the
processor row, not the step, so there is one output schema per processor identity. A step's
`MaxDepth` can sit at or below what this file admits, never above it. A feed needing more than the
baseline allows needs its own processor identity, not just its own payload.

## What it cannot assert

**Anything about file content.** `content` is base64, so the bytes are unconstrained by
construction. `format` and `contentEncoding` are ANNOTATIONS in 2020-12, not assertions, and
`ProcessorJsonSchemaValidator.DefaultOptions` does not enable format assertion — adding
`"format": "date-time"` to the timestamps would document them and enforce nothing. Use `pattern` if
that is ever needed.

**Which of the three `content` forms a given node should have.** `type: ["string", "array", "null"]`
admits all three at `depth2`, because the root may legitimately be any of them: a plain file, an
expanded archive, or an empty one. A feed that always ships an archive can narrow it — see below.

## Per-feed variants

Entry count is enforced HERE rather than in the step payload, so a feed with a fixed layout gets its
own schema derived from this one. Constrain `content`, never `metadata.entryCount` — the array is
the fact, the count is derived, and pinning the derived field would let a counting bug satisfy a
rule the content fails.

Always an archive, exactly three entries — the general form, following the file's own rule of
pointing one step shallower than the root (`depth2` here, so `depth1`):

    "content": { "type": "array", "minItems": 3, "maxItems": 3,
                 "items": { "$ref": "#/$defs/depth1" } }

Dropping `"string"` and `"null"` from the type is what makes it "always an archive": a plain file or
an empty archive now fails.

One `.wav` and two `.csv`, order-independent. This variant is deliberately NARROWER than the one
above: a `.wav` or `.csv` entry is always a leaf on the wire, never itself a further archive, so it
points straight at `depth0` and skips `depth1` on purpose — this is the "always an archive of
leaves" case, not the general form. Note also that `minContains`/`maxContains` must sit beside
their OWN `contains`, so two cardinality rules need two subschemas under `allOf`:

    "content": {
      "type": "array", "minItems": 3, "maxItems": 3,
      "items": { "$ref": "#/$defs/depth0" },
      "allOf": [
        { "contains": { "$ref": "#/$defs/wav" }, "minContains": 1, "maxContains": 1 },
        { "contains": { "$ref": "#/$defs/csv" }, "minContains": 2, "maxContains": 2 }
      ]
    }

with narrowing definitions that REFINE `depth0` rather than replace it — legal because `$ref` takes
sibling keywords in 2020-12, and note the omitted `additionalProperties`, which only ever sees
`properties` declared in the same schema object:

    "wav": { "$ref": "#/$defs/depth0",
             "properties": { "metadata": { "properties": { "extension": { "const": ".wav" } } } } }

## Registration

**This schema is not registered by the build.** It is a database row against the processor identity,
applied as a deploy step. Until it is, `OutputSchemaId` is null, `TryValidate` returns true without
decoding anything, and **nothing enforces entry count or depth anywhere** — this file is its only
home.

Note what a failure costs, because it decides where checks belong: the post handler reports
`Failed` with `EntryId: Guid.Empty` and acks. Nothing is written to L2 and the step's input was
already reclaimed, so the branch is gone with no key to recover it and no file path in the log. Every
check that CAN live in `ProcessAsync` does.
