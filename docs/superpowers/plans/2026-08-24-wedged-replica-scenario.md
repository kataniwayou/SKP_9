# Wedged Replica Scenario Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a fault that leaves one processor replica **alive and exporting metrics while it stops consuming**, and find out whether the boards can name it — the one fault class the suite has never been able to inject.

**Architecture:** Every scenario in the suite injects binary absence: scaled to zero, paused, wiped. A replica that is *present but not working* has never been produced, and `SIGSTOP` is the wrong tool for it — a frozen process stops exporting too, so Prometheus cannot tell it from a departure, which is the case Tasks 1 and 2 of the per-replica plan already cover.

The lever this plan uses is RabbitMQ's own: close **one replica's** AMQP connection and keep closing it. The broker can do this natively and target a single replica, because each processor replica holds exactly one connection and `rabbitmqctl list_connections` reports its `peer_host` as the pod IP. The process keeps running, keeps its HTTP server up, and keeps exporting — only its consumer is disrupted. That is the wedge, and `Consuming by queue and replica` is the only panel that can resolve it.

Like `CLIENT PAUSE`, this lever is **self-healing**: a killed run leaves nothing to undo, because the client simply reconnects once nothing is closing it. That property is why it was chosen over anything that mutates broker state.

**Tech Stack:** C# / .NET 8, xUnit v3 (Microsoft.Testing.Platform), kubectl, RabbitMQ 4.1.8, Python 3.11 (`chaos-probe.py`), Playwright (`chaos-timeline.js`).

**Spec:** `grafana/README.md`, the open gap **"A wedged replica cannot be produced by SIGSTOP"**, and the "Out of scope" section of `docs/superpowers/plans/2026-08-24-per-replica-panels.md`, which named this approach and deferred it.

## Global Constraints

- Chaos gates: `SKP_REALSTACK=1` **and** `SKP_CHAOS=1`. **`--filter` is not a flag this runner has** — it prints its help and runs nothing, which reads like a hang. Use `--filter-class`.
- Stop the standing orchestration (`4cd8af45-1295-43db-ab2e-e955dd82b5c5`) and wait 55s before any scenario; the soak's drain check fails if it fired in the last 40s.
- **Verify no orphaned runners before starting.** A background task reported as killed may still be running; two racing runners invalidated three earlier runs.
- **`rabbitmqctl close_connection` takes the Erlang PID, not the connection name.** Verified against this cluster: `close_connection <connection pid> <explanation>`. Passing the name fails.
- Never scale Redis. Never restart Grafana without expecting to re-establish the `svc/grafana 13000:3000` port-forward, which binds to a pod and dies with it.
- Chaos scenarios are serialised by `[Collection(Chaos.Category)]` — that is a safety mechanism, not tidiness.

---

### Task 1: A lever that disconnects one replica and keeps it disconnected

**Files:**
- Create: `src/tests/BaseApi.Tests/Resilience/RabbitConnectionListTests.cs` — unit tests for the parser
- Modify: `src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs` — add the parser and the lever

**Interfaces:**
- Consumes: `Kubectl.RunOrThrowAsync`, `Chaos.Namespace`.
- Produces: `ClusterControl.ParseConnectionPids(string listOutput, string peerHost) -> IReadOnlyList<string>` and `ClusterControl.HoldOneProcessorDisconnectedAsync(CancellationToken) -> Task<IAsyncDisposable>`.

The only part that can be unit-tested is the parse, and it is the part most likely to be quietly wrong: `peer_host` must match **exactly**, or `10.244.0.20` would select `10.244.0.205` and the scenario would disconnect a replica it did not mean to — or every replica, which is scenario S7, not this one.

- [ ] **Step 1: Write the failing tests** (see the file content in Task 1 of this repo's history — six cases: header skipped, exact IP match, prefix IP not matched, multiple connections for one host, no match returns empty, blank lines ignored).

- [ ] **Step 2: Run them and confirm they fail** — `ParseConnectionPids` does not exist.

- [ ] **Step 3: Implement the parser and the lever.**

- [ ] **Step 4: Run the tests and confirm they pass.**

- [ ] **Step 5: Commit.**

---

### Task 2: The scenario

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/Resilience/WedgedReplicaScenarioTests.cs`

Reuses `FaultKind.Rabbit`, whose arrival and heal templates (`ChannelShutDown` / `ConnectionRecovered`, `ConsumptionAdmitted`) are exactly what a disconnected consumer logs — the same reuse, for the same reason, that `PartialReplicaLossScenarioTests` makes of `FaultKind.Processor`.

The obligation is the standing one: **no step may be lost.** The survivor is entitled to every delivery the disconnected replica did not take.

- [ ] **Step 1: Write the scenario. Step 2: Build. Step 3: Commit.**

---

### Task 3: Run it, judge the panels, record what it shows

- [ ] **Step 1: Confirm no orphaned runners.**
- [ ] **Step 2: Stop the standing orchestration, wait 55s, run with the sampler.**
- [ ] **Step 3: Judge with `chaos-probe.py`** — this is what Task 2 of the previous plan was built for. The question is whether the disconnected replica's `Consuming by queue and replica` line drops to 0 or ends while its `Replica fan-out` peer keeps working, and whether the replica keeps *exporting* throughout (which is what distinguishes a wedge from a departure).
- [ ] **Step 4: Record the result in `grafana/README.md`**, including a negative result. If the .NET client auto-recovers so fast the fault is invisible at 15s resolution, that is a resilience finding and belongs in the text as one — not a failure to be tuned away.
- [ ] **Step 5: Restart the standing orchestration and confirm dispatch rate ~0.35.**
- [ ] **Step 6: Commit.**

---

## Out of scope

**Alertmanager, degradation coverage, and the L2 epoch gauge** all remain open and are recorded in `grafana/README.md`. Degradation is the largest of the three and needs a latency proxy the dev stack does not run.
