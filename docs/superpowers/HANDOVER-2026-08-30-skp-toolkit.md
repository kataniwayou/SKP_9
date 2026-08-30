# Handover: the SKP toolkit (phases 1–3 partial)

Date: 2026-08-30
Branch: `orchestrator-board-parity` (64 commits merged; working tree clean)
Spec: `docs/superpowers/specs/2026-08-30-skp-skill-bundle-design.md`
Plan: `docs/superpowers/plans/2026-08-30-skp-toolkit-ground-and-compile.md`

## What this is

`skp-toolkit/` — a stdlib-only Python package that compiles this system's C#
into a capability catalog a **small offline model** queries instead of recalls.
Ships to an offline machine running Claude Code. Governing principle: **lookup,
not recall**, because a small model's characteristic failure is confabulation —
asked something it does not know, it invents a plausible answer and reports it
confidently.

**372 tests.** `python -m unittest discover -s tests -t .` from `skp-toolkit/`.

## Commands that exist

| Command | Does |
| --- | --- |
| `skp init` | Resolves givens, writes the memory folder, compiles the catalog, probes seven targets |
| `skp map` | Two-axis lookup: `--component`, `--intent`, `--answers` |
| `skp doctor` | Source drift / hand-edited generated files / reachability — each with its own remedy |
| `skp verify` | Takes the catalog's claims to the running system. `--component`, `--skips`, `--probe-writes` |
| `skp observe` | Current state and windowed quantities |
| `skp investigate` | The nine-rung cut-point ladder + case files |

Not yet built: `skp author`, `skp operate` (phase 3 remainder), the developer
verbs (phase 4), the skills themselves (phase 5).

## Running against the live cluster

Cluster is **kind**, node `desktop-control-plane`, despite the kubectl context
being named `docker-desktop`. Namespace `skp`. Port-forwards are supervised and
on **offset** ports (`k8s/port-forward-realstack.ps1`):

```
baseapi 18080   prometheus 19090   elasticsearch 19200   grafana 13000
rabbitmq 5673   redis 6380         otel 14317 / 18889
```

```bash
cd skp-toolkit
python -m skp init --home <TEMP OUTSIDE THE REPO> --source-root ../src --project skp \
  --endpoint baseapi=http://localhost:18080 \
  --endpoint prometheus=http://localhost:19090 \
  --endpoint elasticsearch=http://localhost:19200
python -m skp verify --home <same> --probe-writes
```

**Never write a memory folder inside the repo** — `.gitignore` does not cover it.

## Facts that cost real time to discover

- **Postgres tables are snake_case**, not the `DbSet` property names.
  `EFCore.NamingConventions` + `.UseSnakeCaseNamingConvention()`. The extractor
  detects the convention rather than assuming it.
- **The Elasticsearch data stream is `logs-generic.otel-default`** — a dot, not
  a hyphen. ~10M documents, 17 days retention. Bound every query.
- **`attributes.CorrelationId` renders "N"** (32 hex, no hyphens); every other id
  renders "D" (hyphenated). Same document, two formats. Get it wrong and queries
  silently return nothing.
- **`instance` is the scrape target, not the replica.** Per-replica needs
  `service_instance_id`.
- **OTel → Prometheus names** gain a *unit* suffix before the type suffix
  (`pipeline.queue.wait` → `pipeline_queue_wait_seconds_bucket`). Missing this
  made 9 of 16 instruments read as absent.
- **`role` = leader|follower** rides five instruments via
  `PipelineAmbientTag.AppendTo(ref tags)` — invisible to a literal tag scan.
- **A template's em dash arrives transformed** through the OTel pipeline; exact
  `term` matching finds zero. Use a prefix match (`investigate._original_format_filter`).
- **Liveness `interval` is whole seconds** on the wire, not milliseconds.

## Verification status: ~125/136 (92%)

`skp verify --probe-writes`, live. The ratio is **not deterministic** — it moves
a point or two because the Elasticsearch sample is bounded.

The remaining 11, and how to close each:

1. **7 Elasticsearch fault-path claims** (3 templates + 4 attributes:
   `RefusingAndParking`, `StoreUnreachable`, `Queue`, `Reason`, `Type`,
   `WorkflowCount`). **Currently believed unobservable on a healthy system —
   this is probably wrong.** The check samples only the newest 200 documents;
   the index holds 17 days including past chaos runs, so these records very
   likely exist in history. **Fix: per-claim bounded existence query across
   retention instead of a recent sample.** Expected to close most or all 7.
2. **2 Redis families.** `skp:data:*` is empty when nothing is in flight —
   confirmable by verifying during an in-flight run (needs an opt-in flag, since
   starting a workflow is a write). `skp:keeper:probe:*` is written and deleted
   inside one gate probe — catchable only by a tight SCAN across a probe
   interval, or genuinely unobservable; decide and document which.
3. **2 REFUTED — a real defect in the system, not the toolkit.** Two of three
   registered processors have no broker queues; thirteen orphaned `.dead` queues
   and two live work queues belong to no `processors` row. Bidirectional drift
   between the registry and RabbitMQ. Cleaning it makes these confirm.

## How this build actually went — read this before trusting anything

Fifteen-odd defects shipped, and **every one had the same shape: something that
disappears, or reports success, without ever being able to fail.** Truncated
template text. Two queue ids collapsing into one. Annotation files overwriting
each other. A probe swallowing the message it existed to emit. A duplicated test
class name that silently disabled the guard for an already-fixed bug. A 404
classified by route shape rather than the server's answer.

Three of them were invisible to *every* source review, because the catalog was
internally consistent, fully covered, zero problems — and factually wrong about
the running system. `skp verify` exists because of those three.

**So: when reviewing work here, hunt for the check that cannot fail.** And prefer
running against the live cluster over reading code; source is not the system.

## Rulings that are load-bearing

- **Value domains only where const-declared.** `route={fanout|queue}` comes from
  consts; `outcome`/`disposition` are inline and got no extracted domain, only
  annotation prose. An incomplete domain presented as complete makes a model
  treat a valid value as invalid.
- **`cluster_url` is derived, asserted, and enforced in `ClusterClient`** — not
  in `doctor`, so every verb built on `build_clients` inherits the check.
  Normalised before comparing (trailing slash, default port, localhost/127.0.0.1).
- **`skp verify` is read-only by default.** `--probe-writes` is opt-in and sends
  deliberately invalid bodies with random guids; a 2xx is REFUTED-with-warning,
  never a pass. Row counts proven identical before/after.
- **NOT OBSERVED, REFUTED and UNVERIFIABLE are three different verdicts.**
  Collapsing them makes the verb cry wolf and be ignored.
