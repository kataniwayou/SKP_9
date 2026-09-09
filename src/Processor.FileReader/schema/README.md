# FileReader output schema

`output.json` is the BASELINE: the shape every FileReader document has, and nothing about a
particular feed. It is registered against the processor identity as the output schema.

## What it asserts

- The `{metadata, content}` node, `additionalProperties: false` at every level.
- `content` is one key holding one of three things: a base64 string (a file's bytes), an array of
  nodes (what an archive expanded to), or null (an archive that expanded to nothing). It is never
  two keys that can disagree — see `FileContent` for why that pair was collapsed.
- **Depth one, structurally.** `depth1` may hold an array of `depth0`; `depth0`'s `content` is a
  string and nothing else, so it cannot hold entries. That is the whole depth rule.

## How depth is expressed, and why it is not a keyword

JSON Schema has no depth keyword, and there is no way to say "at most two levels" without writing
the levels out. So the bound is a property of the STRUCTURE: N node definitions, each referencing
the next, and the last one admitting only a string. You read the limit by counting the definitions.

To admit a zip whose entries are themselves zips — `MaxDepth: 2` on the step — add a level and
repoint the root:

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

leaving `depth1` and `depth0` as they are. Each level is the same object with `items` pointing one
step shallower.

**The alternative — a self-referencing `$ref` admitting any depth — is rejected.** It would validate
every document this processor can produce, which sounds like a feature and is the opposite: a schema
that admits any depth can never tell you the depth was wrong. The unrolled form is what makes a
`MaxDepth` the schema does not expect show up as a validation failure instead of a surprise
downstream.

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
admits all three at `depth1`, because the root may legitimately be any of them: a plain file, an
expanded archive, or an empty one. A feed that always ships an archive can narrow it — see below.

## Per-feed variants

Entry count is enforced HERE rather than in the step payload, so a feed with a fixed layout gets its
own schema derived from this one. Constrain `content`, never `metadata.entryCount` — the array is
the fact, the count is derived, and pinning the derived field would let a counting bug satisfy a
rule the content fails.

Always an archive, exactly three entries:

    "content": { "type": "array", "minItems": 3, "maxItems": 3,
                 "items": { "$ref": "#/$defs/depth0" } }

Dropping `"string"` and `"null"` from the type is what makes it "always an archive": a plain file or
an empty archive now fails.

One `.wav` and two `.csv`, order-independent — note that `minContains`/`maxContains` must sit beside
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
