# Gate: processorLiveness

HTTP 422 with `errors.gate = "processorLiveness"`.

## What the gate checks

Every participating processor must have at least one replica that is present,
healthy and fresh — its liveness timestamp plus twice its interval still ahead
of now. It runs **last**, and is the only gate that reads live cluster state
rather than the definition. One healthy replica admits the processor even when
its siblings are unhealthy, stale, absent or malformed.

## What the offending payload tells you

`errors.offending` is `{procId, reason}`, and `reason` is a **count-only**
breakdown, e.g. `no healthy replica (4 checked: 4 absent, 0 unhealthy, 0 stale,
0 malformed)`. It deliberately carries no instance ids or connection detail. The
counts are the diagnosis: `absent` means no key at all (never deployed, or
scaled to zero), `stale` means a replica stopped heartbeating.

## Remedy

    skp observe liveness --processor <procId>
    skp observe pods --workload <deployment>

If the count is all-absent, the processor is not deployed — deploy it or scale
it up. If it is stale, the replicas are running but not heartbeating, which is a
processor-side fault: read its logs. Re-validate once a replica is fresh.

## What this is NOT

Not a definition error. The graph is fine; the cluster is not. Nothing in the
spec file needs to change, so do not re-apply — just fix the workload and start
again.
