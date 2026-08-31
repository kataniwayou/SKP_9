# Gate: cycle

HTTP 422 with `errors.gate = "cycle"`.

## What the gate checks

The step graph must be acyclic. This gate runs **first**, before every other —
a cyclic graph cannot be meaningfully checked by the later gates.

## What the offending payload tells you

`errors.offending` is `{stepChain}`: the ordered list of step ids forming the
cycle, and the `detail` renders it as `a -> b -> c`. The chain is the whole
answer; no further lookup is needed to locate the loop.

## Remedy

Break one edge in the chain. Every step in `stepChain` is a real step, so pick
the edge that should not exist and remove that successor from its parent, then
`skp author apply` and validate again.

## What this is NOT

Not a missing step. A parent pointing at a child id that does not exist is
`missingStep`, and its remedy is to create the step or fix the reference.
