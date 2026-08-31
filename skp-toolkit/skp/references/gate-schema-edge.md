# Gate: schemaEdge

`POST /orchestration/start` rejected the workflow with HTTP 422 and
`errors.gate = "schemaEdge"`.

## What the gate checks

For every edge `parent -> child` in the step graph, the parent's **output**
schema id must equal the child's **input** schema id. It runs second, after the
cycle detector (which raises both `cycle` and `missingStep`), and before
`payloadConfigSchema`.

## What the offending payload tells you

`errors.offending` is `{parentStepId, childStepId}` — the exact edge that
failed. It names the edge rather than the schema, because a mismatch is a
property of the join, not of either side alone.

## Remedy

Read both steps and compare the schema ids on their processors:

    skp observe projected --workflow <id>
    skp map --component postgres

Then either repoint the child step at a processor whose input schema matches the
parent's output, or change one of the processors' registered schema ids. Both
are definition edits: re-apply with `skp author apply`, then validate again.

## What this is NOT

Not a payload problem. A payload that fails its config schema is
`payloadConfigSchema` — a different gate, whose remedy is to fix the assignment
body rather than the graph.
