# FileReader output schema

`output.json` is the BASELINE: the shape every FileReader document has, and nothing about a
particular feed. It is registered against the processor identity as the output schema.

## What it asserts

- The recursive `{metadata, content, entries}` node, `additionalProperties: false` at both levels.
- Depth one: an entry's `entries` is `maxItems: 0`.
- The root's `content` may be a base64 string (a plain file) or null (an archive); an entry's is
  always a string.

## What it cannot assert

**Anything about file content.** `content` is base64, so the bytes are unconstrained by
construction. `format` and `contentEncoding` are ANNOTATIONS in 2020-12, not assertions, and
`ProcessorJsonSchemaValidator.DefaultOptions` does not enable format assertion — adding
`"format": "date-time"` to the timestamps would document them and enforce nothing. Use `pattern` if
that is ever needed.

## Per-feed variants

Entry count is enforced HERE rather than in the step payload, so a feed with a fixed layout gets its
own schema derived from this one. Constrain `entries`, never `metadata.entryCount` — the array is
the fact, the count is derived, and pinning the derived field would let a counting bug satisfy a
rule the content fails.

Exactly three entries:

    "entries": { "type": "array", "minItems": 3, "maxItems": 3,
                 "items": { "$ref": "#/$defs/leaf" } }

One `.wav` and two `.csv`, order-independent — note that `minContains`/`maxContains` must sit beside
their OWN `contains`, so two cardinality rules need two subschemas under `allOf`:

    "entries": {
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

**This schema is not registered by the build.** It is a database row against the processor identity,
applied as a deploy step. Until it is, `OutputSchemaId` is null, `TryValidate` returns true without
decoding anything, and **nothing enforces entry count anywhere** — this file is its only home.

Note what a failure costs, because it decides where checks belong: the post handler reports
`Failed` with `EntryId: Guid.Empty` and acks. Nothing is written to L2 and the step's input was
already reclaimed, so the branch is gone with no key to recover it and no file path in the log. Every
check that CAN live in `ProcessAsync` does.
