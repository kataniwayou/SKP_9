"""``skp observe``: the current picture, and windowed quantities over it.

Read-only, spec section 8: no mode here writes to any store. Every key
pattern, queue name and metric name comes from the compiled catalog --
``index_by_id()`` plus ``_fill()`` below is the one join point, so a
catalog change (a renamed key prefix, say) changes what this file reads
without a single literal here going stale.

Modes match the ``verb`` field the annotation files already carry for
these surfaces (``skp observe projected``, ``skp observe liveness``, ...):
that field is this module's own contract with ``skp/annotations/*.json``.
"""
import argparse
import json
import pathlib
import re
from datetime import datetime, timezone

from skp.clients.http import Unreachable
from skp.profile import Profile, ProfileMissing, default_home, not_compiled, not_initialised
from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, EXIT_VERDICT, Result
from skp.verbs.init import build_clients
from skp.verbs.map import index_by_id, load_catalog

_PLACEHOLDER = re.compile(r"\{[^}]*\}")


def _fill(pattern: str, **values) -> str:
    """Substitute every ``{name}`` placeholder ``values`` supplies; any
    placeholder not supplied is left alone rather than guessed at, so a
    caller missing an id sees the literal unfilled pattern instead of a
    key that silently means something else."""
    def sub(m: re.Match) -> str:
        name = m.group(0)[1:-1]
        return str(values[name]) if name in values else m.group(0)
    return _PLACEHOLDER.sub(sub, pattern)


def _age_seconds(timestamp, now: float) -> float | None:
    """Seconds between a JSON liveness ``timestamp`` (ISO-8601, as
    ``System.Text.Json`` renders a ``DateTime``) and ``now``. ``None`` if it
    cannot be parsed -- a malformed timestamp is a fact to report, not a
    reason to raise out of an observe call."""
    if not timestamp:
        return None
    text = str(timestamp)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return now - parsed.timestamp()


def liveness_rule(age_s: float | None, interval_s: float) -> str:
    """The 2x-stale / 4x-present rule, in one place both ``skp observe
    liveness`` and ``skp investigate``'s cross-cutting checks read from --
    ``redis.PerInstance``'s own catalogued warning: stale at 2x the
    interval but present until 4x, so 'absent' and 'unhealthy' are
    different answers and neither is 'gone' on its own."""
    if age_s is None:
        return "age unknown"
    if interval_s <= 0:
        return "cannot evaluate -- interval is 0"
    if age_s <= 2 * interval_s:
        return "fresh"
    if age_s <= 4 * interval_s:
        return "stale (past 2x interval) but still present -- not yet gone"
    return "gone (past 4x interval)"


def _live_queue_map(rabbit) -> dict:
    return {q["name"]: q for q in rabbit.queues()}


# ---------------------------------------------------------------------
# projected -- redis.ParentIndex / redis.Root
# ---------------------------------------------------------------------

def projected(entries: list[dict], redis, workflow_id: str | None = None):
    by_id = index_by_id(entries)
    if workflow_id:
        key = _fill(by_id["redis.Root"]["detail"], workflowId=workflow_id)
        try:
            hits = redis.keys(key)
        except Unreachable as exc:
            return EXIT_UNREACHABLE, [f"redis unreachable -- {exc.detail}"]
        if not hits:
            return EXIT_VERDICT, [f"{workflow_id}: NOT projected -- no key at {key}"]
        value = redis.get(key)
        return EXIT_OK, [f"{workflow_id}: projected", f"  {key} = {value[:300]}"]

    index_key = by_id["redis.ParentIndex"]["detail"]
    try:
        members = redis.smembers(index_key)
    except Unreachable as exc:
        return EXIT_UNREACHABLE, [f"redis unreachable -- {exc.detail}"]
    if not members:
        return EXIT_OK, [f"no workflows currently projected at {index_key}"]
    return EXIT_OK, [f"{len(members)} workflow(s) projected:", *(f"  {w}" for w in sorted(members))]


# ---------------------------------------------------------------------
# liveness -- redis.InstanceIndex / redis.PerInstance
# ---------------------------------------------------------------------

def liveness(entries: list[dict], redis, processor_id: str, now: float):
    by_id = index_by_id(entries)
    index_key = _fill(by_id["redis.InstanceIndex"]["detail"], processorId=processor_id)
    try:
        instance_ids = redis.smembers(index_key)
    except Unreachable as exc:
        return EXIT_UNREACHABLE, [f"redis unreachable -- {exc.detail}"]
    if not instance_ids:
        return EXIT_VERDICT, [f"processor {processor_id}: no instance has ever registered at {index_key}"]

    lines = [f"processor {processor_id}: {len(instance_ids)} instance(s) ever registered"]
    for instance_id in sorted(instance_ids):
        key = _fill(by_id["redis.PerInstance"]["detail"],
                    processorId=processor_id, instanceId=instance_id)
        try:
            raw = redis.get(key)
        except Unreachable as exc:
            lines.append(f"  {instance_id}: UNREACHABLE -- {exc.detail}")
            continue
        if not raw:
            lines.append(f"  {instance_id}: absent -- gone, or never present")
            continue
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            lines.append(f"  {instance_id}: unparseable liveness value: {raw[:120]}")
            continue
        # ProcessorLivenessOptions.IntervalSeconds -> ProcessorLivenessEntry.Interval:
        # this field is already whole seconds, not milliseconds (see
        # BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs -- the
        # [ConfigurationKeyName("Interval")] on an *Seconds-suffixed property).
        interval_s = record.get("interval", 0) or 0
        age_s = _age_seconds(record.get("timestamp"), now)
        rule = liveness_rule(age_s, interval_s)
        age_txt = f"{age_s:.1f}s" if age_s is not None else "?"
        lines.append(f"  {instance_id}: status={record.get('status', '?')} "
                     f"interval={interval_s}s age={age_txt} -- {rule}")
    return EXIT_OK, lines


# ---------------------------------------------------------------------
# queues -- rabbitmq.*
# ---------------------------------------------------------------------

_CONCRETE_QUEUES = ("orchestrator.Control", "orchestrator.Result", "orchestrator.ResultPost",
                    "orchestrator.ControlDead", "orchestrator.ResultDead")


def queues(entries: list[dict], rabbit, processor_id: str | None = None):
    by_id = index_by_id(entries)
    wanted = []
    for local in _CONCRETE_QUEUES:
        entry = by_id.get(f"rabbitmq.{local}")
        if entry:
            wanted.append(entry["detail"])
    if processor_id:
        for local in ("processor.Work", "processor.Dead"):
            entry = by_id.get(f"rabbitmq.{local}")
            if entry:
                wanted.append(_fill(entry["detail"], processorId=processor_id))

    try:
        live = _live_queue_map(rabbit)
    except Unreachable as exc:
        return EXIT_UNREACHABLE, [f"rabbitmq unreachable -- {exc.detail}"]

    lines = []
    width = max((len(n) for n in wanted), default=0)
    for name in wanted:
        q = live.get(name)
        if q:
            lines.append(f"  {name.ljust(width)}  depth={q.get('messages', '?')}"
                         f"  consumers={q.get('consumers', '?')}")
        else:
            lines.append(f"  {name.ljust(width)}  NOT FOUND on broker")
    return EXIT_OK, [f"{len(wanted)} queue(s):", *lines]


# ---------------------------------------------------------------------
# gate -- prometheus.pipeline_gate_open
# ---------------------------------------------------------------------

def gate(prom):
    # The catalog's own instrument name is "pipeline.gate.open" -- OTel dots
    # become underscores -- but the live exporter renders a 0/1 gauge with a
    # "_ratio" suffix that neither this catalog nor skp verify's own suffix
    # vocabulary (_total/_bucket/_sum/_count) names. Try the bare name first,
    # the observed live rendering second, rather than hardcoding only the one
    # that happens to work today.
    try:
        series = prom.query("pipeline_gate_open") or prom.query("pipeline_gate_open_ratio")
    except Exception as exc:  # pragma: no cover -- defensive, mirrors skp verify
        return EXIT_UNREACHABLE, [f"prometheus unreachable -- {exc}"]
    if not series:
        return EXIT_VERDICT, ["no live pipeline.gate.open series -- gate state cannot be read"]
    lines = ["pipeline.gate.open (1=open, consumers may run; 0=closed) per replica:"]
    for s in series:
        instance = s.get("metric", {}).get("service_instance_id", "(no service_instance_id)")
        value = s.get("value", [None, "?"])[1]
        lines.append(f"  {instance}: {value}")
    return EXIT_OK, lines


# ---------------------------------------------------------------------
# pods / rollout / manifest -- cluster.*
# ---------------------------------------------------------------------

def pods(raw_cluster, workload: str | None = None):
    try:
        out = raw_cluster.run(["get", "pods", "-o", "json"])
    except Unreachable as exc:
        return EXIT_UNREACHABLE, [f"cluster unreachable -- {exc.detail}"]
    data = json.loads(out) if out else {"items": []}
    lines = []
    for item in data.get("items", []):
        name = item.get("metadata", {}).get("name", "?")
        if workload and workload not in name:
            continue
        status = item.get("status", {})
        phase = status.get("phase", "?")
        ready = next((c.get("status") for c in status.get("conditions", [])
                     if c.get("type") == "Ready"), "?")
        restarts = sum(cs.get("restartCount", 0) for cs in status.get("containerStatuses", []))
        lines.append(f"  {name:<44} phase={phase} ready={ready} restarts={restarts}")
    if not lines:
        return EXIT_VERDICT, ["no pods found" + (f" matching {workload!r}" if workload else "")]
    return EXIT_OK, [f"{len(lines)} pod(s):", *lines]


def rollout(raw_cluster, workload: str):
    try:
        out = raw_cluster.run(["rollout", "status", workload, "--timeout=5s"])
    except Unreachable as exc:
        return EXIT_UNREACHABLE, [f"{workload}: {exc.detail}"]
    return EXIT_OK, [f"{workload}: {out or 'rollout complete'}"]


def manifest(raw_cluster, workload: str):
    try:
        out = raw_cluster.run(["get", workload, "-o", "json"])
    except Unreachable as exc:
        return EXIT_UNREACHABLE, [f"{workload}: {exc.detail}"]
    return EXIT_OK, [out]


# ---------------------------------------------------------------------
# readiness / startup -- api.health.*
# ---------------------------------------------------------------------

def health(baseapi, path: str):
    try:
        baseapi.http.get_json(path)
    except Unreachable as exc:
        return EXIT_VERDICT, [f"{path}: {exc.detail}"]
    return EXIT_OK, [f"{path}: ok"]


# ---------------------------------------------------------------------
# rate -- prometheus.pipeline_* windowed
# ---------------------------------------------------------------------

_OPERATION_METRIC = re.compile(r"^instant query on (\S+)")


def rate(entries: list[dict], prom, metric: str, window: str = "5m"):
    by_id = index_by_id(entries)
    key = metric if metric.startswith("prometheus.") else f"prometheus.pipeline_{metric}"
    entry = by_id.get(key) or by_id.get(f"prometheus.pipeline_{metric.replace('.', '_')}")
    if not entry:
        return EXIT_USAGE, [f"no catalogued metric matching {metric!r} "
                            f"-- see: skp map --component prometheus"]

    match = _OPERATION_METRIC.match(entry["operation"])
    base = match.group(1).replace(".", "_") if match else metric.replace(".", "_")

    attempts = [
        ("mean over " + window,
         f"sum by (service_instance_id) (rate({base}_sum[{window}])) / "
         f"sum by (service_instance_id) (rate({base}_count[{window}]))"),
        ("rate over " + window, f"sum by (service_instance_id) (rate({base}_total[{window}]))"),
        ("current value", base),
    ]
    for label, expr in attempts:
        try:
            series = prom.query(expr)
        except Exception:  # pragma: no cover -- defensive, mirrors skp verify
            series = []
        if series:
            lines = [f"{entry['id']} -- {label}:"]
            for s in series:
                instance = s.get("metric", {}).get("service_instance_id", "(no service_instance_id)")
                value = s.get("value", [None, "?"])[1]
                lines.append(f"  {instance}: {value}")
            return EXIT_OK, lines
    return EXIT_VERDICT, [f"{entry['id']}: no live series for {base} "
                          f"(mean, rate, or current value) in the last {window}"]


# ---------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------

def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp observe")
    parser.add_argument("--home", default=str(default_home()))
    sub = parser.add_subparsers(dest="mode", required=True)

    p = sub.add_parser("projected")
    p.add_argument("--workflow")

    p = sub.add_parser("liveness")
    p.add_argument("--processor", required=True)

    p = sub.add_parser("queues")
    p.add_argument("--processor")

    sub.add_parser("gate")

    p = sub.add_parser("pods")
    p.add_argument("--workload")

    p = sub.add_parser("rollout")
    p.add_argument("--workload", required=True)

    p = sub.add_parser("manifest")
    p.add_argument("--workload", required=True)

    sub.add_parser("readiness")
    sub.add_parser("startup")

    p = sub.add_parser("rate")
    p.add_argument("--metric", required=True)
    p.add_argument("--window", default="5m")

    ns = parser.parse_args(argv)

    home = pathlib.Path(ns.home)
    if not (home / "profile.json").exists():
        return not_initialised()
    try:
        profile = Profile.load(home)
        entries = load_catalog(home)
    except ProfileMissing:
        return not_compiled(home)

    clients = build_clients(profile)

    if ns.mode == "projected":
        code, lines = projected(entries, clients["redis"], ns.workflow)
    elif ns.mode == "liveness":
        import time
        code, lines = liveness(entries, clients["redis"], ns.processor, time.time())
    elif ns.mode == "queues":
        code, lines = queues(entries, clients["rabbitmq"], ns.processor)
    elif ns.mode == "gate":
        code, lines = gate(clients["prometheus"])
    elif ns.mode == "pods":
        code, lines = pods(clients["cluster"].cluster, ns.workload)
    elif ns.mode == "rollout":
        code, lines = rollout(clients["cluster"].cluster, ns.workload)
    elif ns.mode == "manifest":
        code, lines = manifest(clients["cluster"].cluster, ns.workload)
    elif ns.mode == "readiness":
        code, lines = health(clients["baseapi"], "/health/ready")
    elif ns.mode == "startup":
        code, lines = health(clients["baseapi"], "/health/startup")
    elif ns.mode == "rate":
        code, lines = rate(entries, clients["prometheus"], ns.metric, ns.window)
    else:  # pragma: no cover -- argparse's own `choices` already rejects this
        return Result(EXIT_USAGE, [f"unknown mode {ns.mode!r}"], next_command="skp observe")

    if code == EXIT_UNREACHABLE:
        next_command = "skp doctor"
    elif code == EXIT_VERDICT:
        next_command = "skp investigate trace"
    else:
        next_command = "skp observe"
    return Result(code, lines, next_command=next_command)
