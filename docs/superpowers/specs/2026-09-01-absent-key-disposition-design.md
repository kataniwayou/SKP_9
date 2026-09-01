# The absent-key disposition — Design

**Date:** 2026-09-01
**Status:** Decided. Implemented in the same change.
**Resolves:** the divergence recorded as deliberately unresolved in `7ac5ce2`
(`ProcessDispatchHandler` "entry absent" and `StepOutcomeHandler.ReadAsync`), and named in
`2026-08-31-consistent-advance-materialize-topology-design.md` §10 as *"the deeper inconsistency,
independent of topology"*.
**Evidence:** one live incident, diagnosed 2026-09-01 — see §4.

## 1. Decision

> **The orchestrator ACKS an absent execution blob, as the processor already does.** It logs the
> ack at Warning with the ids, reclaims nothing, advances nothing, and returns. The processor is
> unchanged.

The divergence closes toward the processor's side, and the reason is not symmetry for its own sake.
It is that the orchestrator's condition turns out to have exactly one reachable cause, and it is the
same one the processor already names.

## 2. What the two handlers actually meet

Both read `L2[EntryId]` and find it gone. The prior note held that the *evidence* differs, and it
was right to: a processor can prove its own reclaim removed the key, while the orchestrator "could
equally have been removed by a previous attempt at this outcome or never written at all, and the
second is a real defect."

**The second reading is not reachable.** By the time `ReadAsync` runs, four things hold:

1. **The workflow and the step exist in L1.** `RunAsync` resolves the entry at line 148 and throws
   `DescribeL1Miss` at 173 — before the read. A message naming a workflow or step this replica does
   not hold already parks, and says which lookup missed.
2. **`EntryId != Guid.Empty`.** The sentinel path returns `[]` without reading. The three shapes
   that carry it — a failed source step, an output that failed its schema, a cancelled source step —
   never reach the read.
3. **The write happened.** `ProcessedDataHandler` writes `L2[p.EntryId]` and *then* sends the
   outcome, and its schema-failure branch sends `Guid.Empty` for exactly this reason, in its own
   words: *"the write below never ran, so that key does not exist, and naming it would send the
   orchestrator to reclaim a key that was never written."* A non-empty `EntryId` on a `StepOutcome`
   is therefore a key that was written.
4. **Nothing else deletes it.** There are four `KeyDeleteAsync` sites against `ExecutionData`.
   `ProcessDispatchHandler:305` reclaims the processor's own *input*, a different guid — the
   orchestrator mints `Guid.NewGuid()` per successor, so input and output keys never collide.
   `NextStepHandoffHandler:166` deletes only on the arm where the outcome *could not be sent at
   all*, so no message names that key. `L2Cleanup` touches root and step keys, not this one. The
   fourth is `StepOutcomeHandler`'s own reclaim.

**Therefore: an absent key here means this outcome has already been handled.** There is no second
reading left for parking to protect.

## 3. Parking does not preserve what it claims to

The prior note accepted the false-positive case openly — *"a channel lost between [the delete and
the ack] parks an outcome that was in fact handled"* — and justified it because the message "lands
in the dead-letter queue with its ids intact rather than being lost."

It lands there, but it cannot be used. Replaying it re-reads the same absent key and parks it again.
The parked message can only ever be read once by a human and then deleted. That is a log line with
a queue attached, an on-call interruption, and a permanent entry in `pipeline.deadletter.depth` —
in exchange for information a log line carries just as well.

## 4. The base rate is operational, not defect-driven

`orchestrator-result.dead` held one message on 2026-09-01. Diagnosed:

- Correlation `bebe990a…`, workflow `cbe1c767…`, `Result = Completed`,
  `x-first-death-reason: rejected` — refused on first delivery, not a delivery-limit casualty.
- The run was in flight across two orchestrator restart waves, which were **planned**: the topology
  migration's own scale-down. Scaling to zero requeues every unacked outcome.
- The parked delivery is the first message `orchestrator-0` consumed after hydrating, **32ms** after
  admitting consumption on `orchestrator-result`.
- One entry dispatch produced 3 entry-step completions, 20 hand-offs and **4 terminal completions**.
  The run did not lose progress; it made the same progress four times. One late redelivery found a
  key an earlier pass had reclaimed.

So the park rate tracks **restarts, deploys and migrations** — not defects. An alarm that fires on
planned maintenance is one people learn to skip, and this repository has already paid that: the six
parked outcomes in the 2026-08-24 handover consumed an investigation and were never resolved.

## 5. What replaces it

An ack, and a Warning naming the ids. Not Information, which is where the processor logs it: the
processor can prove its own reclaim removed the key, and the orchestrator is inferring it from §2.
A burst of these is a real signal — it means outcomes are being redelivered in volume — and Warning
is where a burst is visible without a queue being involved.

**The forgery question moves to where it can actually be answered.** `orchestrator-result` is an
addressable queue on a shared broker and `StepOutcomeHandler` never compares the message against
anything but L1. Parking on an absent key was standing in for a provenance check, very indirectly:
it caught only forgeries that happened to name a bogus `EntryId`, and only after they had already
been inert. The real answer is the guard `ac23c1e` restored one hop away — `ProcessedDataHandler`
refusing a branch whose `ProcessorId` is not its own. The orchestrator has no equivalent, and should
have one; it is out of scope here for the same reason WR-02 was kept out of the topology change: it
is justified equally before and after this decision, so it belongs in its own change and not riding
on one that would let it in unexamined.

## 6. What does not change

- **The processor.** Its case is strictly narrower and its ack already correct.
- **The L1 miss.** A workflow or step this replica does not hold still parks, still via
  `DescribeL1Miss`. That is the branch the six historical messages took, and it is untouched.
- **The `Guid.Empty` path**, the per-successor mint, the reclaim-last ordering, and the store-fault
  propagation — an unreachable Redis still closes the gate and returns the delivery rather than
  acking an outcome that was never acted on. Only `raw.IsNullOrEmpty` changes disposition.
- **The multi-successor hazard** the processor's comment refuses to defend against. The orchestrator
  already mints one key per successor and `EachSuccessorOfAFanOutGetsItsOwnCopyUnderItsOwnKey` pins
  it. Acking here does not open it.

## 7. Residual risk, stated

A forged `StepOutcome` naming a real workflow, a real step and a bogus `EntryId` becomes a Warning
instead of a dead-lettered message. It advanced nothing before and advances nothing now — the early
return precedes every hand-off — so the change is one of visibility, not of exposure. §5 names the
guard that answers it properly.

## 8. Verified live

Orchestrator rebuilt, loaded and restarted (3/3 Ready, 0 restarts, 0 error lines). A `StepOutcome`
with `Result = Completed` was published to `orchestrator-result` naming a real workflow and a real
step — so it passes the L1 check — with `EntryId = deadbee5-0000-4000-8000-000000000003`, a blob
that has never existed. That is the incident's exact shape.

| Check | Result |
| --- | --- |
| `orchestrator-result` depth after | 0 — acked, not requeued |
| `orchestrator-result.dead` | **still 1** — under the old code this would now be 2 |
| Log | `the execution blob is absent — treating as a duplicate delivery, advancing nothing` (Warning) |
| Hand-offs emitted | none |
| Processor queues | all four at 0 — nothing dispatched |

The early return does precede every hand-off and the reclaim, which is the property the whole
decision rests on.

## 9. Observed, and deliberately not fixed here

**A duplicate still logs `the entry step completed with {Result}` before it is discarded.** That
line sits above the read, so the injected duplicate produced two records: the completion line and
then the Warning. In the 2026-08-31 incident the three completion lines were accurate — those
deliveries really did re-advance the run — but for a delivery that advances nothing the line
overstates what happened.

Moving the read above it would fix that and is probably right. It is not done here because it
changes what `elasticsearch.EntryStepCompleted` counts, and that template is read by the chaos
scenarios, by `skp operate verify`'s run observation and by the boards. Re-pointing a counted
template is its own change with its own verification, and folding it into this one would let it
through unexamined — the same reason WR-02 was kept out of the topology change.

## 10. Rollout

Orchestrator-only. `Orchestrator/` is outside the SourceHash fold, so no processor rebuild, no row
repoint, no queue teardown: rebuild the image, load it, restart the StatefulSet.
