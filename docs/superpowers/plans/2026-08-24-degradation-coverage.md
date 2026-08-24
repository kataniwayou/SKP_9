# Degradation Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a dependency that is **slow** rather than absent, and find out whether the boards can tell the two apart — the fault class every one of the nine existing scenarios misses.

**Architecture:** Every scenario in the suite removes something entirely. Nothing is ever slow, and a slow dependency is the most common way production actually fails. Two bands are worth injecting, and the boundary between them is a number already in the code: `L2GateOptions.ProbeTimeout` is **2 seconds**, probed every **5 seconds**.

- **300 ms** — slower than normal, comfortably inside the probe timeout. The gate should stay open and the pipeline should keep working. The question is whether *anything* on the boards moves.
- **3 s** — past the probe timeout. The probe should fail, and the interesting question is whether the boards then read exactly like Redis being **down**, which would make slow indistinguishable from absent — the same shape as the wipe-versus-pause gap already recorded.

**Four decisions, three of them forced.**

1. **Toxiproxy, not `tc netem`.** Not a preference — the WSL2 kernel this cluster runs on reports `CONFIG_NET_SCH_NETEM is not set` and carries no loadable modules at all (`/lib/modules` does not exist). `tc qdisc add ... netem` fails with `Specified qdisc kind is unknown` even `--privileged`. BusyBox's `tc` applet is present but is a stub that rejects `root`. Kernel-level latency injection is unavailable on this stack, full stop.
2. **Redis, and only the processor's connection to it.** Redis is the most latency-sensitive path here and the one with existing panels — `L2 gate`, `Consuming`, `Data freshness`. Confining the repoint to `processor-sample` also makes the run an attribution test: one workload's dependency is slow while its peers talk to Redis directly, so a board that blames the wrong thing will say so.
3. **The proxy sits in the path always, not only during chaos.** An overlay would change the topology between the baseline and the fault run, leaving two variables moving instead of one. The cost is a permanent extra hop, which Task 4 measures rather than assumes.
4. **`kubectl exec` for the toxics**, matching every other lever in `ClusterControl`, rather than a new port-forward. The image has no shell, but `/toxiproxy-cli` is a binary and `kubectl exec` runs it directly.

**Tech Stack:** Toxiproxy 2.12.0 (8 MB, already imported into the node's containerd as `skp-toxiproxy:2.12.0`), C# / .NET 8, xUnit v3, kubectl, Python 3.11 (`chaos-probe.py`).

**Spec:** `grafana/README.md`, the open gap **"A *slow* rather than absent dependency is untested — the most common production failure"**.

## Global Constraints

- **`kind load` does not work for this image.** Both `kind load docker-image` and `kind load image-archive` fail with `ctr: content digest ... not found`, because the published manifest is a multi-platform list carrying attestations. What works, and what was used: `docker pull --platform linux/amd64`, re-tag, `docker save`, then `docker exec -i desktop-control-plane ctr -n k8s.io images import -`. The image is present on the node as `docker.io/library/skp-toxiproxy:2.12.0`.
- `imagePullPolicy: IfNotPresent` is mandatory — the tag is local to the node and does not exist in any registry.
- Chaos gates: `SKP_REALSTACK=1` **and** `SKP_CHAOS=1`. Use `--filter-class`; `--filter` is silently ignored.
- Stop the standing orchestration and wait 55s before any scenario. Verify no orphaned runners first.
- **Never scale Redis** except via `RedisWipeScenarioTests`.
- **Dashboards are provisioned now.** `/api/dashboards/db` returns `Cannot save provisioned dashboard`; regenerate and `kubectl apply --server-side --field-manager=skp-dashboards -f k8s/24-grafana-dashboards.yaml`.
- Toxiproxy toxics **do not self-expire**. Unlike `CLIENT PAUSE`, a killed run leaves the latency in place. Every lever must remove its toxic on disposal *and* the scenario must clear stale toxics on entry.

---

### Task 1: Put the proxy in the path and prove nothing changed

**Files:**
- Create: `k8s/13-toxiproxy.yaml` — Deployment, Service, and the proxy config ConfigMap
- Modify: `k8s/kustomization.yaml` — add the resource
- Modify: `k8s/33-processor-sample.yaml` — repoint `ConnectionStrings__Redis`

- [ ] **Step 1: Write the manifest.** Proxy `redis` listening `0.0.0.0:6379`, upstream `redis:6379`; API on 8474. Config supplied as a mounted JSON so the proxy exists at startup rather than needing a runtime create.
- [ ] **Step 2: Apply and wait for ready.**
- [ ] **Step 3: Repoint the processor and roll it.**
- [ ] **Step 4: Prove the pipeline is healthy through the proxy** — gate open, consuming 1, dispatch rate ~0.35.
- [ ] **Step 5: Commit.**

---

### Task 2: A lever that makes Redis slow for the processor

**Files:**
- Modify: `src/tests/BaseApi.Tests/Live/Resilience/ClusterControl.cs`
- Modify: `src/tests/BaseApi.Tests/Resilience/RabbitConnectionListTests.cs` or a new test file for any parsed output

- [ ] **Step 1: Add `HoldRedisSlowAsync(TimeSpan latency, CancellationToken)`** — adds a `latency` toxic on entry, removes it on disposal, and clears any stale toxic of the same name first so a previously killed run cannot poison the next one.
- [ ] **Step 2: Build and commit.**

---

### Task 3: Two scenarios, and what the boards do with them

- [ ] **Step 1: `SlowRedisUnderTimeoutScenarioTests`** — 300 ms. Expect no loss. The finding is whatever the boards show, including nothing.
- [ ] **Step 2: `SlowRedisOverTimeoutScenarioTests`** — 3 s. Expect the gate to close. The finding is whether that is distinguishable from Redis being absent.
- [ ] **Step 3: Run both with the sampler, judge with `chaos-probe.py`, record in `grafana/README.md`.** A negative result — "a 300 ms dependency is invisible on every board" — is the most likely outcome and is worth recording precisely, not tuned away.

---

### Task 4: Prove the extra hop cost nothing

The proxy is in the path permanently, so every existing measurement now runs through it. That is a change to the system under test and must be checked rather than assumed.

- [ ] **Step 1: Re-run `RedisUnavailableScenarioTests`** and confirm the verdict stats still move as the README's table records (`Consuming 0`, `L2 gate 0`).
- [ ] **Step 2: Re-run `RedisWipeScenarioTests`** — the one that scales Redis, where a proxy in front changes what the client sees on the way down.
- [ ] **Step 3: Record any difference. If either regressed, say so and stop** rather than adjusting the scenario to match.

---

## Out of scope

**RabbitMQ latency** — the same lever would extend to it, but one dependency at a time, and Redis is the one with the panels. **Alertmanager**, **the L2 epoch gauge**, and **a true wedged replica** all remain open and are recorded in `grafana/README.md`.
