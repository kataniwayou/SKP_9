# Gate: payloadConfigSchema

HTTP 422 with `errors.gate = "payloadConfigSchema"`.

## What the gate checks

Each assignment's payload must conform to its processor's **config** schema. It
runs third, after `schemaEdge` and before `processorLiveness`.

## What the offending payload tells you

`errors.offending` is `{assignmentId, errors}`, where `errors` is the flattened
list of validation messages — the specific fields that failed, not just the fact
that something did.

## Remedy

Fix the assignment body to satisfy the config schema, then re-apply the
`assignments` section and validate again. If the schema is what is wrong,
changing it is a schema edit and re-registers the processor.

## What this is NOT

Not about data flowing between steps. Input/output schema disagreement across an
edge is `schemaEdge`. This gate is only about an assignment's own config payload.
