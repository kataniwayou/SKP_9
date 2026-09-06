# PathImporter — Design

**Date:** 2026-09-06
**Status:** Decided. Not yet implemented.
**Introduces:** `src/Processor.PathImporter/`, the second concrete processor, and the first
component in this system that speaks to Kafka.
**Depends on:** `BaseProcessor.Core` unchanged — every decision below lands in author code.

## 1. Decision

> **PathImporter is a source step that turns a Kafka topic of file paths into N parallel lineages.**
> It reads its topic, group and broker list from the step payload, consumes at most `MessageCount`
> records, and for each one mints an execution id, logs the path against that id and the dispatch's
> correlation id, sends the path to the post queue as its own branch, and commits the offset. The
> loop ends in one of three named ways and says which.

Nothing about the framework moves. The Kafka client, its lifecycle and its fault classification are
all author concerns, living in `src/Processor.PathImporter/`, in the same way `SampleProcessor`'s
hop counter is.

## 2. Why a source step, and what that costs

A source step arrives with `data` empty and `executionId == Guid.Empty` — the sentinel that means
"you are the entry; open the lineages yourself." PathImporter is the first *real* instance of the
shape `SampleProcessor` demonstrates with two synthetic seeds: it does not transform an input, it
manufactures one from outside the system.

That has a consequence worth stating before the design rather than discovering after it.
`BaseProcessorOfT` is explicit that a redelivered dispatch replays `ProcessAsync`, and that the
input-key delete which normally makes replay a no-op **does not exist for a source step** — there is
no input key to reclaim, so there is no idempotence token. The framework's own words: *"it is not
reachable at all for a source step."*

So PathImporter is a processor that runs twice on redelivery, and unlike a pure transform it has
external state. What keeps that safe is that its external state is *the committed offset*, and the
offset is the idempotence token the framework couldn't give it. A replay resumes from the last
commit; the paths already committed are not re-read and not re-sent. This is why §5 commits per
message rather than once at the end, and why the commit is ordered after the send rather than
before.

The residual duplicate window is exactly one path wide: a send that succeeded and a commit that then
failed. That path is re-read and re-sent on the next dispatch under a fresh execution id, producing
a duplicate lineage. At-least-once, one record deep, and it is accepted rather than solved.

## 3. Configuration — flat, from the step payload

```csharp
public sealed record PathImporterConfig(
    string BrokerList,
    string Topic,
    string ConsumerGroup,
    int    MessageCount,
    int    IdleTimeoutSeconds) : ProcessorConfig;
```

Five scalar fields, no nesting. `ProcessorConfig.SerializerOptions` binds them case-insensitively
from the orchestrator's step payload and ignores unknown properties, so a sixth field added later
does not break workflows authored before it.

**A null config is a `FailedException`, not a default.** `SampleProcessor` treats an empty payload as
"the author picks the default" because its defaults are meaningful — zero and null. There is no
meaningful default topic, and inventing one would have this processor read from somewhere nobody
asked for. The absence is a workflow authoring error and is reported as one.

`IdleTimeoutSeconds` is the field that was not in the original request, and §6 is the whole reason it
exists.

**The broker list travels in the payload, so the workflow author picks the broker, not the
operator.** This is deliberate and was confirmed, but it is the one field whose placement is
arguable: brokers are usually infrastructure, and infrastructure usually comes from the environment.
Keeping it in the payload is what lets one deployment serve several topics on several clusters
without a redeploy, and it is consistent with every other field here arriving the same way. If that
ever inverts, the change is one field and a fallback to configuration.

## 4. Consumer lifecycle — one, cached, evicted on fault

**A single consumer is held in a field on the processor and reused across dispatches**, keyed on
`(BrokerList, Topic, ConsumerGroup)`. A dispatch whose key differs from the held one closes the old
consumer and builds a new one. A cache of exactly one — not a dictionary, not an eviction policy,
one field and an equality check.

This is safe because the processor is a singleton and prefetch is one, which the framework describes
as structural rather than tunable. Exactly one dispatch is in flight per replica, so nothing else can
touch the consumer while a dispatch holds it. The same sentence that makes `BaseProcessor`'s
`_dispatch` field safe makes this field safe, and it fails in the same way if prefetch ever moves.

### Why not a consumer per dispatch

The rejected alternative builds, subscribes, consumes and closes inside each `ProcessAsync`. It is
stateless and obviously correct, and at one partition and one replica it has no contention to
suffer. It was still rejected, for a cost that is not latency:

**A single-member group that empties pays `group.initial.rebalance.delay.ms` on the next join.** That
default is three seconds, it is set on the org's brokers, and we do not control it. A stateless
consumer leaves the group at the end of every dispatch, so every dispatch that follows an idle gap
starts with a three-second stall before it can read anything. Held across dispatches, the group is
joined once per pod lifetime and never sees it.

Static group membership (`group.instance.id` from `POD_NAME`) was also considered and rejected. It
would suppress the rejoin cost without holding state, but it requires suppressing `Close()` to work
as intended — which fights the disposal path in §9 — and it leaves a dead pod's partition held for
the full session timeout. It is the right tool for a long-lived streaming consumer. This is a
bounded batch reader.

### The idle-eviction problem, and the fix that is not a keepalive

librdkafka enforces `max.poll.interval.ms` locally: a consumer that does not call `Consume` within
that window (default five minutes) removes itself from the group. Nothing polls between dispatches,
so a workflow that runs less often than that would evict its own cached consumer and pay the rejoin
regardless — the benefit above evaporates for exactly the schedules most likely to be used.

**`max.poll.interval.ms` is raised to one hour.** This is safe because it is not the mechanism that
detects a dead consumer. `session.timeout.ms` is, it is heartbeat-driven on librdkafka's own thread,
it stays at its default of roughly forty-five seconds, and it releases the partition promptly when a
pod dies. `max.poll.interval.ms` governs livelock detection only, and a livelocked author here is
already a wedged dispatch that the framework's own liveness and queue-depth signals surface.

**A background keepalive poll is explicitly not the fix.** `Consume` is what resets the interval, and
`Consume` is what returns records. A keepalive would consume paths outside a dispatch, with no
execution id to mint them under, no branch to send them on and no dispatch scope to log them in.
Those paths would be committed and lost. This is worth writing down because it is the obvious idea
and it silently destroys data.

### Faults evict the cache

**A dispatch that ends in `Faulted` (§6) disposes the consumer before returning**, so the next
dispatch builds a fresh one. Without this rule, a consumer wedged in some state the classifier read
as transient stays wedged for the life of the pod, and every subsequent dispatch inherits it.

This is what makes the cached design strictly better than the stateless one rather than a trade:
the fast path is cached, and the recovery path is per-dispatch.

### Consumer settings

`EnableAutoCommit=false` and `EnableAutoOffsetStore=false` — §5 owns when an offset moves, and
neither may move on librdkafka's schedule. `AutoOffsetReset=Earliest`, because the topic is seeded by
something outside the cluster and a group reading it for the first time must see paths written
before it existed. No credentials, per the stated architecture.

## 5. The loop

Subscribe once when the consumer is built. Then, at most `MessageCount` times:

1. `Consume(idleTimeout)`.
2. The record's value **is** the path. There is no envelope and no deserialization — a Kafka record
   here is a full file path and nothing else, which is what makes it the branch's `data`.
3. `NewExecutionId()`. One per path, unconditionally — including when the dispatch arrived with a
   non-empty execution id. Every path is the origin of its own lineage; there is no case where this
   processor continues one it was handed.
4. Log the path against the minted id (§7).
5. `SendToPostAsync(payload, executionId, ct)`.
6. `Commit(result)`.

**Step 6 follows step 5, and that ordering is the whole of §2's safety argument.** Committing first
would acknowledge a path whose branch had not been sent, and a fault between the two would lose it
with nothing recording that it was lost. Committing after means the failure mode is a duplicate
rather than a disappearance, and a duplicate is recoverable while a disappearance is not.

`Close()` runs in a `finally` for the eviction and disposal paths, so the group is left deliberately
rather than by session timeout.

The branch payload is `{"path":"..."}` rather than the raw bytes, because data moving between steps
passes `ProcessorJsonSchemaValidator` and a bare string has nothing for a schema to describe.

`PostSendException` from step 5 propagates untouched, exactly as `SampleProcessor` insists it must.
It is safer here than there: committed offsets mean the replayed dispatch resumes at the uncommitted
path instead of re-sending the ones that already landed, so the replay cost is the one-record window
of §2 rather than the whole batch.

## 6. The three terminals, and the log line that tells them apart

The original requirement: a line reading `12/100` has two causes and must say which. It has three.

```
consumed {Consumed}/{Requested} paths; stopped because {Reason}
```

| Reason | Cause | Offsets |
|---|---|---|
| `Completed` | The loop ran `MessageCount` times. | All committed. |
| `Drained` | `Consume` returned null after `IdleTimeoutSeconds`. The topic is empty. | All committed. |
| `Faulted` | A transient fault at record *n+1*. | Committed through *n*; nothing beyond. |

`Drained` is the reason `IdleTimeoutSeconds` is a config field rather than a constant. It is the only
signal Kafka offers for "there is nothing more right now" — the client cannot distinguish an empty
topic from a slow one except by waiting, and how long to wait is a property of the workflow, not of
this code.

**`Drained` means what it says only because the topic has one partition and the deployment has one
replica.** A consumer reads only the partitions assigned to it, so under any other arrangement a
drained *assignment* would be reported as a drained *topic*, and `12/100 Drained` would mean "my
slice held 12" while the topic held a hundred. That is a false report of the exact distinction this
section exists to make. The constraint is recorded in §9 and in the manifest, and **scaling either
number invalidates this reason and requires renaming it** — it is not a capacity decision that can be
made independently.

`Faulted` returns normally. The step succeeds with a partial count, no exception reaches the
framework, and the uncommitted records are read by the next dispatch. This is the stated intent: a
transient fault is not a business failure, and the next dispatch will probably resolve it.

## 7. The path in Elasticsearch

```csharp
logger.LogInformation(
    "imported path {Path} as execution {ExecutionId} from {TopicPartitionOffset}",
    path, executionId, result.TopicPartitionOffset);
```

`CorrelationId` rides the dispatch scope that `ProcessDispatchHandler` opens around the call, along
with the workflow, step and processor ids — an author names none of them and gets all of them.

**`ExecutionId` must be named explicitly, and that is the point of the line.** The scope carries the
*dispatch's* execution id, which for a source step is `Guid.Empty`. The per-path id minted at step 3
exists nowhere else. Rendering it here is the only thing that couples a path to the lineage it
opened, and without it the correlation id leads to a hundred indistinguishable records.

`SampleProcessor` states at length that runtime `data` never appears in a log template, and this line
breaks that rule knowingly. The justification is narrower than the sample's own exception: the path
is not derived content, it is the business identifier — the single thing an operator would search
for. There is nothing to join on instead. **The consequence is that file paths land in Elasticsearch
in the clear**, and if that is ever not acceptable the mitigation is to hash or truncate here, in one
place.

## 8. Fault classification

`KafkaFaultClassifier`, in the shape of `SendFaultClassifier` and `BrokerFaultClassifier`.

**Deterministic is the allow-list**: unknown topic or partition, topic and group authorization
failure, invalid argument or configuration, SASL authentication failure, and anything where
`Error.IsFatal`. These throw `FailedException`, which the framework reports to the orchestrator as a
failed step with a sanitized message.

**Everything unrecognized is transient**: break the loop, report `Faulted`, evict the consumer, commit
nothing further.

**That default is the inverse of `SendFaultClassifier`'s, deliberately.** There, an unrecognized fault
is left raw so the dispatch parks somewhere a human can look, on the reasoning that a misclassified
deterministic fault would requeue forever. Here the requirement is the opposite — an unrecognized
consume fault should cost a partial batch and be retried by the next dispatch, not fail the step. The
asymmetry is intentional and will carry a comment saying so, because a reader who knows the other
classifier will otherwise read this one as a mistake.

One behaviour worth encoding in a test: **`Subscribe` does not throw on a nonexistent topic.** The
error surfaces on the first `Consume` as an error result. A classifier tested only against
`Subscribe` would look correct and catch nothing.

## 9. Deployment

`k8s/34-processor-pathimporter.yaml`, modelled on `33-processor-sample.yaml`: no Service, probes
only, `POD_NAME` and the OTLP endpoint injected the same way.

Two departures, both load-bearing:

- **`replicas: 1`**, against the sample's two. The sample's comment argues for two on the grounds
  that a pure consumer has no inbound traffic to balance; that reasoning does not survive a
  single-partition topic, where a second replica would own nothing, consume nothing, and report
  `0/100 Drained` for every dispatch that landed on it.
- **`maxSurge: 0`, `maxUnavailable: 1`**, so a rolling update never briefly runs two members against
  one partition. The handover is a clean stop-then-start rather than an overlap.

The comment block in the manifest states the partition coupling explicitly, so that someone scaling
this deployment reads §6 before they do.

Disposal comes free: the container owns the singleton and disposes it at shutdown, so `Close()` runs
and the group is left cleanly instead of waiting out the session timeout.

## 10. Packaging

`Confluent.Kafka` and its transitive `librdkafka.redist` are pinned in `Directory.Packages.props` and
added to the offline `nugets/` feed. This is roughly forty megabytes of per-RID native binaries
entering an air-gapped drop — the largest single addition the feed has taken. `tools/ship-delta.ps1`
already recurses `nugets/`, so the drop picks them up without anyone remembering to list them, which
is the behaviour that folder's scope entry was built for.

## 11. Testing

The consumer sits behind a narrow interface — subscribe, consume, commit, close — so the loop is
exercised with a fake and **no Kafka runs in the hermetic suite**. The hermetic baseline is a shape
(zero failed, exit zero, everything under `Live/` skipped) and this work must not change it.

Hermetic coverage: all three terminals of §6 including the counts and reasons; the commit-after-send
ordering, and that a failed send commits nothing; cache reuse across dispatches with a matching key,
and rebuild on a differing one; eviction on `Faulted`; the classifier's allow-list on both arms,
including the `Subscribe`-is-silent case from §8; a null config failing rather than defaulting; and
that a distinct execution id is minted per path and appears on the log record.

A real-broker test goes under `Live/` with the RealStack category, and needs a Kafka reachable from
the test host — which, per the architecture, is org infrastructure outside the cluster rather than
anything the k8s manifests stand up.

## 12. Open

**The seeding side is out of scope.** Something outside the cluster writes paths to the topic; this
design does not specify it, and the partition count it chooses is what §6 and §9 depend on.

**Nothing here re-reads a path.** The processor imports paths, not files. Whether a downstream step
opens the file, and what happens when the path no longer resolves by the time it does, is that step's
design.
