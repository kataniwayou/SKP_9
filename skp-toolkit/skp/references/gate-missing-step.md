# Gate: missingStep

HTTP 422 with `errors.gate = "missingStep"`.

## What the gate checks

Every child step id referenced by a parent must exist. It runs after `cycle`.

## What the offending payload tells you

`errors.offending` is `{parentStepId, missingChildId}` — who points, and at
what that is not there.

## Remedy

Either create the missing step and re-apply, or remove the dangling successor
from the parent. If you applied a definition and it stopped partway, the
missing child may simply never have been created: check what `skp author apply`
reported as landed before it failed.

## What this is NOT

Not a schema mismatch. If both steps exist but their schemas disagree, the gate
is `schemaEdge`.
