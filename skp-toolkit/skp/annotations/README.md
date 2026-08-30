# Annotations

The hand-written half of the catalog, and the only hand-written half.

Everything else is read from `src/`. These files supply what no extractor can
produce: which intents a capability serves, what it authoritatively answers,
and — most valuable — **what it must never be used for**.

One JSON file per component, keyed by the surface id the extractor emits
(`redis.Root`, `api.workflows.get`, `prometheus.pipeline_queue_depth`).

## A surface with no entry here fails the build

That is deliberate. It is what makes catalog coverage provable rather than
believed. When `compile.py` reports an unannotated id, **add the annotation**.
Do not silence the check, do not delete the surface from the extractor to make
it stop being discovered, and do not hand-edit a generated file to route
around it. A missing annotation is a gap in this directory, not a bug in the
check.

The same goes for an intent with no covering entry (a category the catalog
claims but no capability actually serves) and for two surfaces that collide on
one id (a real bug seen once already: `ProcessorQueues.cs` and
`OrchestratorQueues.cs` both declared `DeadLetterExchange`, and a naive
dict-by-id build silently discarded one of the two real exchanges). Both are
reported the same way: as a build failure naming the id, not as something
quietly dropped.

## Generated files are never hand-edited

Everything outside this directory that feeds the catalog is generated from
`src/`. Generated files are overwritten on the next `skp init --refresh`, and
`skp doctor` reports the edit if one is made anyway. If the generated surface
looks wrong, fix the extractor or fix `src/` — never patch the output.
