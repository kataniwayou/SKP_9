"""`skp operate` -- control, each command ending in a proof it took effect.

The proof is never the status code. The catalog's own ``never_for`` on
``api.orchestration.post_start`` reads "202 means accepted, not applied", and
stop's is its mirror, so both commands read the L2 root key back afterwards
and report what they observed rather than what they asked for.
"""
import argparse
import json
import pathlib
import time
import uuid

from skp import references, state
from skp.clients.http import Unreachable
from skp.profile import Profile, ProfileMissing, default_home
from skp.result import (EXIT_NOT_INITIALISED, EXIT_OK, EXIT_UNREACHABLE,
                        EXIT_USAGE, EXIT_VERDICT, Result)
from skp.verbs import investigate
from skp.verbs.init import build_clients
from skp.verbs.map import index_by_id, load_catalog
from skp.verbs.observe import _fill

START_ID = "api.orchestration.post_start"
STOP_ID = "api.orchestration.post_stop"
ROOT_ID = "redis.Root"
_ATTEMPTS = 20
_POLL_S = 0.5


def path_for(entries: list[dict], surface_id: str) -> str | None:
    for entry in entries:
        if entry["id"] == surface_id:
            return entry["operation"].split(" ", 1)[1]
    return None


def root_pattern(entries: list[dict], workflow_id: str) -> str | None:
    for entry in entries:
        if entry["id"] == ROOT_ID:
            return entry["detail"].replace("{workflowId}", workflow_id)
    return None


def _await_root(client, pattern: str, present: bool,
                attempts: int, poll_s: float) -> bool:
    """Polls the L2 root key until its presence matches ``present``."""
    for attempt in range(attempts):
        if bool(client.keys(pattern)) == present:
            return True
        if attempt + 1 < attempts:
            time.sleep(poll_s)
    return False


def gate_result(status: int, text: str, next_command: str) -> Result | None:
    """A 422 rendered as a gate verdict, or None when this is not a gate.

    Shared by ``operate.start`` and ``author.validate``: both POST
    ``api.orchestration.post_start`` with the same body and get back the
    same ``{gate, offending}`` shape, so one rendering serves both. Only
    the NEXT: each caller wants differs -- author points back at
    ``skp author apply``, operate at a concrete investigate form -- so that
    travels in as a parameter instead of being hardcoded here.
    """
    if status != 422:
        return None
    try:
        body = json.loads(text)
    except ValueError:
        body = {}
    errors = body.get("errors") or {}
    gate = errors.get("gate")
    if not gate:
        return Result(EXIT_VERDICT,
                      [f"rejected with HTTP 422 but no gate discriminator "
                       f"in the body: {text[:200]}"],
                      next_command="skp doctor")
    lines = [f"rejected at gate {gate!r} -- {body.get('title', '')}".rstrip(),
             body.get("detail", "")]
    offending = errors.get("offending")
    if offending is not None:
        lines.append("offending: " + json.dumps(offending, sort_keys=True))
    return Result(EXIT_VERDICT, [ln for ln in lines if ln],
                  next_command=next_command,
                  reference=references.reference_for(gate))


def start(entries, clients, workflow_id, confirm: bool,
          attempts: int = _ATTEMPTS, poll_s: float = _POLL_S) -> Result:
    if not confirm:
        return Result(EXIT_USAGE,
                      ["skp operate start writes to the live system.",
                       "re-run with --confirm to start the workflow."],
                      next_command=(f"skp operate start --workflow "
                                    f"{workflow_id} --confirm"))

    path = path_for(entries, START_ID)
    pattern = root_pattern(entries, workflow_id)
    if path is None or pattern is None:
        return Result(EXIT_NOT_INITIALISED,
                      ["catalog is missing api.orchestration.post_start or redis.Root"],
                      next_command="skp init --refresh")

    try:
        status, text = clients["baseapi"].http.probe_status("POST", path, workflow_id)
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"POST {path} failed -- {exc}"],
                      next_command="skp doctor")

    gated = gate_result(status, text,
                       next_command=f"skp investigate trace --workflow {workflow_id}")
    if gated is not None:
        return gated
    if status not in (200, 202):
        return Result(EXIT_VERDICT,
                      [f"start refused with HTTP {status}: {text[:200]}"],
                      next_command="skp map --component api")

    if _await_root(clients["redis"], pattern, True, attempts, poll_s):
        return Result(EXIT_OK,
                      [f"started -- accepted with HTTP {status}, and projected: "
                       f"{pattern} is present in L2."],
                      next_command=f"skp operate verify --workflow {workflow_id}")
    return Result(EXIT_VERDICT, [
        f"accepted with HTTP {status}, but {pattern} did not appear in L2 "
        f"within {attempts * poll_s:.0f}s -- accepted, not applied.",
    ], next_command=f"skp investigate trace --workflow {workflow_id}")


def stop(entries, clients, workflow_id, confirm: bool,
         attempts: int = _ATTEMPTS, poll_s: float = _POLL_S) -> Result:
    if not confirm:
        return Result(EXIT_USAGE,
                      ["skp operate stop writes to the live system.",
                       "re-run with --confirm to stop the workflow."],
                      next_command=(f"skp operate stop --workflow "
                                    f"{workflow_id} --confirm"))

    path = path_for(entries, STOP_ID)
    pattern = root_pattern(entries, workflow_id)
    if path is None or pattern is None:
        return Result(EXIT_NOT_INITIALISED,
                      ["catalog is missing api.orchestration.post_stop or redis.Root"],
                      next_command="skp init --refresh")

    try:
        status, text = clients["baseapi"].http.probe_status("POST", path, workflow_id)
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"POST {path} failed -- {exc}"],
                      next_command="skp doctor")

    if status not in (200, 202, 204):
        return Result(EXIT_VERDICT,
                      [f"stop refused with HTTP {status}: {text[:200]}"],
                      next_command="skp map --component api")

    if _await_root(clients["redis"], pattern, False, attempts, poll_s):
        return Result(EXIT_OK, [f"stopped -- {pattern} is gone from L2."],
                      next_command=f"skp operate verify --workflow {workflow_id}")
    return Result(EXIT_VERDICT, [
        f"accepted with HTTP {status}, but {pattern} is still in L2 after "
        f"{attempts * poll_s:.0f}s -- queued, not applied. Steps already in "
        f"flight resolve before the projection is removed.",
    ], next_command=f"skp operate verify --workflow {workflow_id}")


NEVER = 5  # StepEntryCondition.Never -- a stored wire value, never renumbered.


def freeze(entries, clients, step_id: str, confirm: bool) -> Result:
    """Sets one entry step's condition to ``Never``.

    Per ``StepEntryCondition.cs`` this is the operator's per-entry-step
    freeze: a stop halts a whole workflow, which is the wrong instrument when
    only one of several entry steps needs to stand down. Setting that one to
    Never and re-issuing start leaves the schedule armed and its siblings
    firing.

    THE FREEZE IS NOT IMMEDIATE. L1 is a projection, so it lands on the next
    start. The proof here is therefore the ROW plus the instruction to
    re-issue start -- never "dispatching has stopped", which would still be
    false at the moment this returns.
    """
    # pg.rows() interpolates SQL into a shell argument and offers no
    # parameter binding, so an id arriving from argv is validated before it
    # can reach the query.
    try:
        uuid.UUID(step_id)
    except ValueError:
        return Result(EXIT_USAGE, [f"{step_id!r} is not a UUID"],
                      next_command="skp observe projected --workflow <id>")

    if not confirm:
        return Result(EXIT_USAGE,
                      ["skp operate freeze writes to the live system.",
                       "re-run with --confirm to set the step to Never."],
                      next_command=f"skp operate freeze --step {step_id} --confirm")

    get_path = path_for(entries, "api.steps.get_id")
    put_path = path_for(entries, "api.steps.put_id")
    if get_path is None or put_path is None:
        return Result(EXIT_NOT_INITIALISED,
                      ["catalog is missing api.steps.get_id or api.steps.put_id"],
                      next_command="skp init --refresh")

    try:
        status, text = clients["baseapi"].http.probe_status(
            "GET", get_path.replace("{id}", step_id), None)
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"GET {get_path} failed -- {exc}"],
                      next_command="skp doctor")

    if status != 200:
        return Result(EXIT_VERDICT,
                      [f"GET step failed with HTTP {status}: {text[:200]}"],
                      next_command="skp map --component api")

    try:
        step_obj = json.loads(text)
    except ValueError:
        return Result(EXIT_VERDICT,
                      [f"GET returned HTTP {status} but body is not JSON: {text[:200]}"],
                      next_command="skp doctor")

    step_obj["entryCondition"] = NEVER

    try:
        status, text = clients["baseapi"].http.probe_status(
            "PUT", put_path.replace("{id}", step_id), step_obj)
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"PUT {put_path} failed -- {exc}"],
                      next_command="skp doctor")

    if status not in (200, 204):
        return Result(EXIT_VERDICT,
                      [f"freeze refused with HTTP {status}: {text[:200]}"],
                      next_command="skp map --component api")

    rows = clients["postgres"].rows(
        f"select entry_condition from steps where id = '{step_id}'")
    observed = rows[0][0] if rows and rows[0] else None
    if observed != str(NEVER):
        return Result(EXIT_VERDICT, [
            f"accepted with HTTP {status}, but steps.entry_condition reads "
            f"{observed!r}, not '{NEVER}' -- the freeze did not land.",
        ], next_command="skp investigate trace --workflow <id>")

    return Result(EXIT_OK, [
        f"frozen -- steps.entry_condition is {NEVER} (Never) for {step_id}.",
        "This takes effect on the NEXT start, not now: L1 is a projection, so "
        "the running projection keeps firing until it is replaced.",
        "Sibling entry steps and the schedule are unaffected.",
    ], next_command="skp operate start --workflow <id> --confirm")


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp operate")
    parser.add_argument("--home", default=str(default_home()))
    sub = parser.add_subparsers(dest="mode", required=True)

    p = sub.add_parser("freeze")
    p.add_argument("--step", required=True)
    p.add_argument("--confirm", action="store_true")

    for name in ("start", "stop"):
        p = sub.add_parser(name)
        p.add_argument("--workflow", required=True)
        p.add_argument("--confirm", action="store_true")

    p = sub.add_parser("verify")
    p.add_argument("--workflow")
    p.add_argument("--window", default="1h")

    ns = parser.parse_args(argv)
    home = pathlib.Path(ns.home)
    try:
        profile = Profile.load(home)
    except ProfileMissing:
        return Result(EXIT_NOT_INITIALISED, ["no profile in " + str(home)],
                      next_command="skp init")

    entries = load_catalog(home)
    clients = build_clients(profile)

    if ns.mode == "freeze":
        return freeze(entries, clients, ns.step, ns.confirm)

    if ns.mode == "verify":
        workflow_id = ns.workflow or state.recall(home, "workflow")
        if not workflow_id:
            return Result(EXIT_USAGE,
                          ["no workflow known -- pass --workflow"],
                          next_command="skp operate verify --workflow <id>")
        return verify(entries, clients, workflow_id, ns.window)

    handler = {"start": start, "stop": stop}[ns.mode]
    result = handler(entries, clients, ns.workflow, ns.confirm)
    if result.code == EXIT_OK:
        state.record(home, "workflow", ns.workflow)
    return result


def resolve_verdict(observations: dict) -> tuple[str, list[str]]:
    """The seven verdicts, resolved in a fixed order.

    One verdict per distinct remedy: two states that send the operator to do
    the same thing are one verdict, two that send them somewhere different
    must never be merged. This is the ruling ``skp verify`` already makes for
    NOT_OBSERVED / REFUTED / UNVERIFIABLE -- collapsing them makes a verb cry
    wolf and be ignored.

    The ORDER carries as much weight as the set. Several observations can
    hold at once, and the most actionable has to win: a frozen workflow is
    not dispatching, so checking `frozen` after `wedged` would send an
    operator to redeploy a processor that is working perfectly.

    ``parked``/``wedged`` name a *processor* (``parked-at-processor-{id}``,
    ``wedged-at-processor-{id}``), not a step: the RabbitMQ queue name is
    ``processor-{processorId}``, and one processor can back several steps in
    a workflow, so naming a step would invent precision the data does not
    have. ``failed`` is read from the Elasticsearch ``StepId`` attribute and
    genuinely names a step, so ``failed-at-{stepId}`` is left as is.
    """
    if observations["frozen"]:
        verdict, evidence = "frozen", [
            "every entry step reads steps.entry_condition = 5 (Never).",
            "Nothing is wrong: this workflow was deliberately frozen.",
        ]
    elif observations["parked"]:
        processor = observations["parked"][0]
        verdict, evidence = f"parked-at-processor-{processor}", [
            f"processor-{processor}.dead holds messages -- deliveries were "
            f"rejected and dead-lettered.",
            "They are recoverable by hand; they are not lost.",
            f"processor-{processor} is shared: it backs every workflow "
            f"assigned to that processor, so a parked message here may "
            f"belong to a different workflow than this one. Confirm with "
            f"skp investigate parked --processor {processor}.",
        ]
    elif observations["wedged"]:
        processor = observations["wedged"][0]
        verdict, evidence = f"wedged-at-processor-{processor}", [
            f"processor-{processor} has queued messages and no consumers -- "
            f"nothing is reading the queue.",
        ]
    elif observations["failed"]:
        step = observations["failed"][0]
        verdict, evidence = f"failed-at-{step}", [
            f"a completion record for {step} reports Failed.",
        ]
    elif observations["completed"]:
        verdict, evidence = "completed", [
            "a terminal step completed and the run ended."]
    elif observations["running"]:
        verdict, evidence = "running", [
            "steps are executing inside the window."]
    elif observations["dispatched"]:
        verdict, evidence = "never-started", [
            "a dispatch record exists inside the window, but nothing "
            "downstream -- no completion, failure, running step, or queue "
            "state -- confirms the run ever took hold, so this reads as "
            "never-started until something downstream says otherwise.",
            "it may still be initializing, or it ended between dispatch and "
            "the next observable event.",
        ]
    else:
        verdict, evidence = "never-started", [
            "no dispatch record inside the window, and nothing queued or "
            "parked.",
            "Either start was never issued, or it was rejected at a gate.",
        ]

    if observations.get("unscoped"):
        evidence = evidence + [
            "queue states could not be attributed to this workflow -- it "
            "has no L2 projection (no skp:{workflowId}:{stepId} keys), so "
            "parked and wedged could not be checked.",
        ]
    return verdict, evidence


def _newest_correlation(es, dispatched_tpl: str, workflow_id: str, window: str) -> str | None:
    """The current run's CorrelationId.

    order="desc" because ascending hands back the OLDEST dispatch in the
    window, and every workflow here recurs. Without this, a run that finished
    an hour ago supplies the verdict for the run happening now.
    """
    hits = investigate._es_search(es, dispatched_tpl, window, workflow_id, None,
                                  size=1, order="desc")
    for hit in hits:
        # skp.clients.es.Elastic.search() already unwraps `_source` -- each
        # hit here IS the source document, exactly as investigate.py's own
        # rungs read it (`hits[0].get("attributes", {})`). A `_source`
        # lookup here would find nothing and silently starve every verdict
        # of its evidence.
        attrs = hit.get("attributes") or {}
        if attrs.get("CorrelationId"):
            return str(attrs["CorrelationId"])
    return None


def _entry_steps_all_never(clients, workflow_id: str) -> bool:
    """True only when the workflow HAS entry steps and every one is Never.

    A workflow with no entry steps at all is NOT frozen -- it is
    never-started. Conflating them would report "nothing is wrong" about a
    definition that cannot run.
    """
    rows = clients["postgres"].rows(
        "select s.entry_condition from workflow_entry_steps w "
        "join steps s on s.id = w.step_id "
        f"where w.workflow_id = '{workflow_id}'")
    values = [r[0] for r in rows if r]
    return bool(values) and all(v == str(NEVER) for v in values)


def _workflow_processors(entries, clients, workflow_id: str) -> set[str]:
    """The processor ids backing this workflow's steps.

    Read, not inferred: the L2 projection enumerates this workflow's steps
    under skp:{workflowId}:{stepId} (catalogued as redis.Step), and Postgres
    maps each step to its processor. Scoping matters because one processor
    backs steps in several workflows, and parked/wedged outrank every
    healthy verdict -- an unscoped scan reports another workflow's outage
    as this one's.
    """
    by_id = index_by_id(entries)
    step_pattern = _fill(by_id["redis.Step"]["detail"],
                        workflowId=workflow_id, stepId="*")
    keys = clients["redis"].keys(step_pattern)
    step_ids = []
    for key in keys:
        candidate = key.rsplit(":", 1)[-1]
        try:
            uuid.UUID(candidate)
        except ValueError:
            continue
        step_ids.append(candidate)
    if not step_ids:
        return set()
    quoted = ",".join(f"'{s}'" for s in step_ids)
    rows = clients["postgres"].rows(
        f"select distinct processor_id from steps where id in ({quoted})")
    return {r[0] for r in rows if r}


def _queue_states(entries, clients, processors: set[str]) -> tuple[list[str], list[str]]:
    """Parked/wedged processors, filtered to those backing this workflow.

    Queue names are derived from the catalog's ``rabbitmq.processor.Work``/
    ``rabbitmq.processor.Dead`` templates rather than spelled as literals --
    a renamed convention on the C# side must change what this reads, not
    silently starve it (see the module docstring's ``operate verify`` trap).

    ``processors`` is expected to be non-empty here -- an empty set means
    nothing could be attributed to the workflow, and the caller must not
    call this with it (see ``observe_run``'s ``unscoped`` handling).
    """
    by_id = index_by_id(entries)
    work_tpl = by_id["rabbitmq.processor.Work"]["detail"]
    dead_tpl = by_id["rabbitmq.processor.Dead"]["detail"]
    work_prefix = work_tpl.split("{processorId}", 1)[0]
    dead_prefix, dead_suffix = dead_tpl.split("{processorId}", 1)

    parked, wedged = [], []
    for queue in clients["rabbitmq"].queues():
        name = queue.get("name", "")
        if not name.startswith(work_prefix):
            continue
        if dead_suffix and name.endswith(dead_suffix):
            processor_id = name[len(dead_prefix):len(name) - len(dead_suffix)]
            if processor_id not in processors:
                continue
            depth = int(queue.get("messages") or 0)
            if depth > 0:
                parked.append(processor_id)
        else:
            processor_id = name[len(work_prefix):]
            if processor_id not in processors:
                continue
            depth = int(queue.get("messages") or 0)
            if depth > 0 and int(queue.get("consumers") or 0) == 0:
                wedged.append(processor_id)
    return sorted(parked), sorted(wedged)


def observe_run(entries, clients, workflow_id: str, window: str = "1h") -> dict:
    """Every field is a read of a catalogued surface. Nothing here recomputes
    a decision the system already made.

    Every log template this reads (``elasticsearch.EntryStepCompleted``,
    ``elasticsearch.TerminalCompleted``, ``elasticsearch.RunningTheStep``,
    ``elasticsearch.EntryDispatched``) comes out of ``entries`` by catalog
    id, the same idiom ``investigate.py`` uses throughout: a missing id
    means the catalog is stale, and the ``KeyError`` that follows is the
    honest failure -- never a literal fallen back to silently.
    """
    uuid.UUID(workflow_id)
    by_id = index_by_id(entries)
    entry_completed = by_id["elasticsearch.EntryStepCompleted"]["detail"]
    terminal_completed = by_id["elasticsearch.TerminalCompleted"]["detail"]
    running_tpl = by_id["elasticsearch.RunningTheStep"]["detail"]
    dispatched_tpl = by_id["elasticsearch.EntryDispatched"]["detail"]

    es = clients["elasticsearch"]
    correlation = _newest_correlation(es, dispatched_tpl, workflow_id, window)

    def hits(template):
        return investigate._es_search(es, template, window, workflow_id,
                                      correlation)

    failed, completed = [], False
    for template in (entry_completed, terminal_completed):
        for hit in hits(template):
            # Same unwrapped shape as _newest_correlation above -- Elastic
            # already strips `_source` before this ever sees the hit.
            attrs = hit.get("attributes") or {}
            if str(attrs.get("Result", "")).lower() == "failed":
                failed.append(str(attrs.get("StepId", "unknown")))
            elif template == terminal_completed:
                completed = True

    processors = _workflow_processors(entries, clients, workflow_id)
    unscoped = not processors
    # Honest degradation: with no processors attributable to this workflow,
    # an unscoped scan would report another workflow's outage as this one's
    # (or its health as this one's), so parked/wedged stay empty and
    # `unscoped` records that the check could not be made -- never silently
    # "no parked messages".
    parked, wedged = ([], []) if unscoped else _queue_states(entries, clients, processors)
    return {
        "frozen": _entry_steps_all_never(clients, workflow_id),
        "parked": parked,
        "wedged": wedged,
        "failed": sorted(set(failed)),
        "completed": completed,
        "running": bool(hits(running_tpl)),
        "dispatched": bool(hits(dispatched_tpl)),
        "unscoped": unscoped,
    }


def verify(entries, clients, workflow_id: str, window: str) -> Result:
    try:
        uuid.UUID(workflow_id)
    except ValueError:
        return Result(EXIT_USAGE, [f"{workflow_id!r} is not a UUID"],
                      next_command="skp operate verify --workflow <id>")
    try:
        observations = observe_run(entries, clients, workflow_id, window)
    except Unreachable as exc:
        return Result(EXIT_UNREACHABLE,
                      [f"{exc.target} unreachable -- {exc.detail}"],
                      next_command="skp doctor")
    verdict, evidence = resolve_verdict(observations)
    code = EXIT_OK if verdict in ("completed", "running", "frozen") else EXIT_VERDICT
    nexts = {
        "completed": "skp observe projected --workflow " + workflow_id,
        "running": "skp operate verify --workflow " + workflow_id,
        "frozen": "skp operate start --workflow " + workflow_id + " --confirm",
    }
    if verdict.startswith("parked-at-processor-"):
        default_next = ("skp investigate parked --processor "
                        + verdict[len("parked-at-processor-"):])
    else:
        default_next = f"skp investigate trace --workflow {workflow_id}"
    return Result(code, [f"{verdict}"] + evidence,
                  next_command=nexts.get(verdict, default_next))
