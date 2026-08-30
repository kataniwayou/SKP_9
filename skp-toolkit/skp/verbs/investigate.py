"""``skp investigate``: the cut-point ladder (design spec section 7).

Localising an unknown fault does not require reasoning if the topology is
known -- it requires walking it. Nine ordered checkpoints, each one check
with two branches (``PASS``/``FAIL``), plus a third (``UNKNOWN``) for "the
evidence needed to check this could not be reached" -- an unreachable store
or a missing upstream id must never render as a false verdict.

**The model bisects; it does not diagnose.** ``run_ladder`` always walks
all nine rungs (each guarded independently), then ``boundary_and_verdict``
finds the last rung that passed and the first that did not -- that
boundary *is* the fault location. A handful of boundaries have a canned
meaning (spec section 7's own examples); every other boundary is reported
with its raw evidence and no invented cause, per spec: "an invented cause
is not a useful output."

Every key pattern, queue name and log template is read from the compiled
catalog through ``index_by_id``/``_fill`` (see ``skp.verbs.observe``) --
never typed as a literal here, and never as a hardcoded C-format id: the
`N`-vs-`D` trap is real (``attributes.CorrelationId`` is 32 hex with no
hyphens; every other id is hyphenated), so this file only ever *reads*
whichever id shape an ES record itself already carried.

Read-only throughout (spec section 8): every call below is a GET, a bounded
search, or ``list_queues`` -- nothing here writes to any store.
"""
import argparse
import json
import pathlib
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from skp.clients.http import Unreachable
from skp.profile import Profile, ProfileMissing, default_home, not_compiled, not_initialised
from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, EXIT_VERDICT, Result
from skp.verbs.init import build_clients
from skp.verbs.map import index_by_id, load_catalog
from skp.verbs.observe import _fill

PASS = "PASS"
FAIL = "FAIL"
UNKNOWN = "UNKNOWN"

QUESTIONS = {
    1: "is the workflow projected at all?",
    2: "did a fire happen?",
    3: "did the dispatch reach the processor's queue?",
    4: "did a replica pick it up?",
    5: "did the author's transform return?",
    6: "did the branch's output land?",
    7: "did the outcome reach the orchestrator?",
    8: "did successors advance?",
    9: "did it terminate?",
}

# Canned meanings for the boundaries spec section 7 names explicitly. Any
# boundary not listed here falls through to the generic report -- "I have
# no rule for this" is the honest answer, not a guess dressed as one.
def _interpret_3_4(rung3: "Rung") -> str | None:
    """Only the zero-consumers reading of a 3/4 boundary is a rule this
    toolkit actually has. A queue *with* live consumers that still never
    picked the message up is not "no ready replica" -- claiming that from
    a rung whose own evidence shows consumers > 0 is exactly the
    invented-cause failure spec section 7 warns against (confirmed live,
    2026-08-30: a 3/4 boundary with 4 live consumers on the queue, because
    rung 2 -- with no --correlation given -- had grabbed the OLDEST
    matching dispatch in the window rather than the current one).
    """
    if "zero consumers" not in rung3.evidence:
        return None
    return ("present at 3 (the queue is reachable) with zero consumers: no ready "
           "replica is consuming this processor's queue -- check the deployed pod's "
           "registered SourceHash")


# Canned meanings for the boundaries spec section 7 names explicitly, each a
# ``(rung_before_the_boundary) -> str | None`` guard: returning ``None``
# declines the canned reading and falls through to the generic report. Any
# boundary not listed here does the same -- "I have no rule for this" is the
# honest answer, not a guess dressed as one.
INTERPRETATIONS = {
    (3, 4): _interpret_3_4,
    (5, 6): lambda rung5: ("present at 5, absent at 6: the author's transform returned "
                           "without sending. Legal if this step is a sink; a bug if it "
                           "was meant to hand off to a successor."),
    (6, 7): lambda rung6: ("present at 6, absent at 7: the branch's output landed but "
                           "its outcome never reached the orchestrator -- a lost outcome."),
}


@dataclass
class Rung:
    number: int
    question: str
    verdict: str
    evidence: str


class CaseFile:
    """Findings accumulate to disk as they are gathered (spec section 7):
    a twenty-step investigation does not depend on surviving in context,
    and a human -- or the model, cold -- can read the trail afterwards.
    Overwrites the whole file on every ``record()``/``finish()`` rather
    than appending lines: nine rungs is cheap enough that a readable,
    always-valid JSON document beats an append-only log a reader has to
    replay.
    """

    def __init__(self, path: pathlib.Path, workflow_id: str, correlation_id: str | None):
        self.path = path
        self.data = {
            "workflow_id": workflow_id,
            "correlation_id": correlation_id,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "rungs": [],
        }
        self._write()

    def record(self, rung: Rung) -> None:
        self.data["rungs"].append(asdict(rung))
        if rung.number == 2:
            # rung 2 is the only place a correlation id can first appear --
            # persist it as soon as it is known rather than only at finish().
            self.data["correlation_id"] = self.data.get("correlation_id")
        self._write()

    def finish(self, boundary: tuple[int | None, int] | None, interpretation: str, verdict_code: int) -> None:
        self.data["boundary"] = boundary
        self.data["interpretation"] = interpretation
        self.data["exit_code"] = verdict_code
        self.data["finished_at"] = datetime.now(timezone.utc).isoformat()
        self._write()

    def _write(self) -> None:
        self.path.write_text(json.dumps(self.data, indent=2, default=str), encoding="utf-8")


def _original_format_filter(template: str) -> dict:
    """A handful of log templates (``TerminalCompleted``, the fault-path
    ``*Refusing*``/``Store*`` excuses) carry a literal U+2014 em dash. On
    the live cluster that byte sequence arrives at Elasticsearch mangled --
    UTF-8 bytes reinterpreted as Latin-1 -- so an exact ``term`` match built
    from the catalog's properly-decoded template silently matches nothing,
    even though the record is right there (confirmed against a real
    terminal record on the live cluster, 2026-08-30). The corruption starts
    exactly at the em dash and nowhere before it, so a ``prefix`` match on
    everything up to it is exact where it matters and immune to the
    encoding defect past that point.
    """
    if "—" in template:
        prefix = template.split("—", 1)[0]
        return {"prefix": {"attributes.{OriginalFormat}": prefix}}
    return {"term": {"attributes.{OriginalFormat}": template}}


def _es_search(es, template: str, window: str, workflow_id: str | None,
               correlation_id: str | None, extra: list[dict] | None = None, size: int = 25,
               order: str = "asc"):
    """Every ES lookup the ladder makes: bounded on time (spec section 15's
    own named risk -- ~10M documents on a shared cluster) and on identity.
    Prefer ``CorrelationId`` once known -- ``WorkflowId`` alone cannot
    identify a run, since a recurring workflow fires more than once and the
    control-plane's own start/stop endpoints log the id too (the same trap
    ``Templates.RunScoped`` in the C# Live tests exists to avoid).
    ``order="desc"`` is for rung 2's own discovery query when no correlation
    id is known yet: ascending would hand it the *oldest* matching dispatch
    in the window, not the current one, on any workflow fired more than once
    -- confirmed against the live cluster, 2026-08-30.
    """
    filters = [_original_format_filter(template),
              {"range": {"@timestamp": {"gte": f"now-{window}"}}}]
    if correlation_id:
        filters.append({"term": {"attributes.CorrelationId": correlation_id}})
    elif workflow_id:
        filters.append({"term": {"attributes.WorkflowId": workflow_id}})
    if extra:
        filters.extend(extra)
    body = {"size": size, "sort": [{"@timestamp": {"order": order}}],
            "query": {"bool": {"filter": filters}}}
    return es.search(body)


def run_ladder(entries: list[dict], clients: dict, workflow_id: str, window: str,
               case: CaseFile | None = None, correlation_id: str | None = None,
               processor_override: str | None = None) -> list[Rung]:
    """Walk all nine cut points, best-effort. A rung whose identifying
    evidence (StepId, EntryId, ProcessorId, CorrelationId) never arrived
    from an earlier rung is UNKNOWN, not skipped -- the boundary finder
    needs every rung present to tell "never checked" apart from "checked
    and failed".
    """
    by_id = index_by_id(entries)
    redis, es = clients["redis"], clients["elasticsearch"]
    rabbit = clients["rabbitmq"]
    rungs: list[Rung] = []

    def emit(number: int, verdict: str, evidence: str) -> None:
        rung = Rung(number, QUESTIONS[number], verdict, evidence)
        rungs.append(rung)
        if case is not None:
            case.record(rung)

    # -- 1: is the workflow projected at all? (Redis skp:{workflowId}) --
    root_key = _fill(by_id["redis.Root"]["detail"], workflowId=workflow_id)
    try:
        hits = redis.keys(root_key)
        emit(1, PASS if hits else FAIL,
             f"{root_key}: {'present' if hits else 'absent'} in L2")
    except Unreachable as exc:
        emit(1, UNKNOWN, f"redis unreachable -- {exc.detail}")

    # -- 2: did a fire happen? (ES "dispatched an entry step") --
    step_id = entry_id = processor_id = None
    entry_dispatched = by_id["elasticsearch.EntryDispatched"]["detail"]
    # Newest first when the caller has not already pinned a run down by
    # CorrelationId: a recurring workflow fires more than once inside any
    # window worth searching, and "the oldest matching dispatch" is a real
    # answer to a different, uninteresting question.
    fire_order = "asc" if correlation_id else "desc"
    try:
        hits = _es_search(es, entry_dispatched, window, workflow_id, correlation_id,
                          order=fire_order)
    except Unreachable as exc:
        emit(2, UNKNOWN, f"elasticsearch unreachable -- {exc.detail}")
    else:
        if hits:
            attrs = hits[0].get("attributes", {})
            correlation_id = correlation_id or attrs.get("CorrelationId")
            step_id = attrs.get("StepId")
            entry_id = attrs.get("EntryId")
            processor_id = attrs.get("ProcessorId")
            emit(2, PASS,
                 f"{len(hits)} dispatch record(s) in the window; most recent: "
                 f"correlation={correlation_id} step={step_id} processor={processor_id}")
        else:
            emit(2, FAIL, f"no {entry_dispatched!r} record for this workflow "
                          f"in the last {window}")

    # -- 3: did the dispatch reach the processor's queue? (AMQP depth+consumers) --
    processor_id = processor_override or processor_id
    if processor_id:
        queue_name = _fill(by_id["rabbitmq.processor.Work"]["detail"], processorId=processor_id)
        try:
            live = {q["name"]: q for q in rabbit.queues()}
        except Unreachable as exc:
            emit(3, UNKNOWN, f"rabbitmq unreachable -- {exc.detail}")
        else:
            q = live.get(queue_name)
            if q is None:
                emit(3, FAIL, f"{queue_name}: not found on the broker")
            else:
                note = "" if q.get("consumers", 0) else " -- WARNING: zero consumers, no ready replica"
                emit(3, PASS, f"{queue_name}: depth={q.get('messages')} "
                              f"consumers={q.get('consumers')}{note}")
    else:
        emit(3, UNKNOWN, "cannot determine -- no ProcessorId (rung 2 produced none; "
                         "pass --processor to override)")

    # -- 4: did a replica pick it up? (ES "running the step" for StepId) --
    if step_id:
        running_tpl = by_id["elasticsearch.RunningTheStep"]["detail"]
        try:
            hits = _es_search(es, running_tpl, window, workflow_id, correlation_id,
                              extra=[{"term": {"attributes.StepId": step_id}}])
        except Unreachable as exc:
            emit(4, UNKNOWN, f"elasticsearch unreachable -- {exc.detail}")
        else:
            emit(4, PASS if hits else FAIL,
                 f"{len(hits)} 'running the step' record(s) for step {step_id}" if hits
                 else f"no 'running the step' record for step {step_id} in the last {window}")
    else:
        emit(4, UNKNOWN, "cannot determine -- no StepId (rung 2 produced none)")

    # -- 5: did the author's transform return? (ES "the step returned...") --
    if step_id:
        returned_tpl = by_id["elasticsearch.StepReturned"]["detail"]
        try:
            hits = _es_search(es, returned_tpl, window, workflow_id, correlation_id,
                              extra=[{"term": {"attributes.StepId": step_id}}])
        except Unreachable as exc:
            emit(5, UNKNOWN, f"elasticsearch unreachable -- {exc.detail}")
        else:
            emit(5, PASS if hits else FAIL,
                 f"{len(hits)} 'the step returned' record(s) for step {step_id}" if hits
                 else f"no 'the step returned' record for step {step_id} in the last {window}")
    else:
        emit(5, UNKNOWN, "cannot determine -- no StepId (rung 2 produced none)")

    # -- 6: did the branch's output land? (ES "branch completed"; Redis blob) --
    # Filtered on StepId, not EntryId: EntryId is the dispatch's *input* key,
    # which is null for the entry step (it has no input -- confirmed against
    # a live "dispatched an entry step" record, 2026-08-30). "branch
    # completed" instead carries the *output* EntryId it just minted -- one
    # per branch, two for an entry step that opens two lineages -- so this
    # rung reads those back off the hits rather than requiring one in first.
    if step_id:
        branch_tpl = by_id["elasticsearch.BranchCompleted"]["detail"]
        try:
            hits = _es_search(es, branch_tpl, window, workflow_id, correlation_id,
                              extra=[{"term": {"attributes.StepId": step_id}}])
        except Unreachable as exc:
            emit(6, UNKNOWN, f"elasticsearch unreachable -- {exc.detail}")
        else:
            landed_entry_ids = sorted({h.get("attributes", {}).get("EntryId") for h in hits
                                       if h.get("attributes", {}).get("EntryId")})
            blob_notes = []
            for eid in landed_entry_ids:
                data_key = _fill(by_id["redis.ExecutionData"]["detail"], entryId=eid)
                try:
                    blob_notes.append(f"{data_key}: "
                                      f"{'present' if redis.keys(data_key) else 'absent'}")
                except Unreachable as exc:
                    blob_notes.append(f"{data_key}: redis unreachable -- {exc.detail}")
            blob_txt = f"; blobs: {'; '.join(blob_notes)}" if blob_notes else ""
            emit(6, PASS if hits else FAIL,
                 (f"{len(hits)} 'branch completed' record(s) for step {step_id}{blob_txt}"
                  if hits else
                  f"no 'branch completed' record for step {step_id} in the last {window}"))
    else:
        emit(6, UNKNOWN, "cannot determine -- no StepId (rung 2 produced none)")

    # -- 7: did the outcome reach the orchestrator? (Result queue; ES completed) --
    result_queue = by_id["rabbitmq.orchestrator.Result"]["detail"]
    try:
        live = {q["name"]: q for q in rabbit.queues()}
        rq = live.get(result_queue)
        rq_note = (f"{result_queue}: depth={rq.get('messages')} consumers={rq.get('consumers')}"
                  if rq else f"{result_queue}: not found")
    except Unreachable as exc:
        rq_note = f"rabbitmq unreachable -- {exc.detail}"

    completed_tpl = by_id["elasticsearch.EntryStepCompleted"]["detail"]
    try:
        hits = _es_search(es, completed_tpl, window, workflow_id, correlation_id)
    except Unreachable as exc:
        emit(7, UNKNOWN, f"elasticsearch unreachable -- {exc.detail}")
    else:
        emit(7, PASS if hits else FAIL,
             (f"{len(hits)} 'entry step completed' record(s); {rq_note}" if hits
              else f"no 'entry step completed' record in the last {window}; {rq_note}"))

    # -- 8: did successors advance? (ES "advanced N successor(s)") --
    advanced_tpl = by_id["elasticsearch.AdvancedSuccessors"]["detail"]
    try:
        hits = _es_search(es, advanced_tpl, window, workflow_id, correlation_id)
    except Unreachable as exc:
        emit(8, UNKNOWN, f"elasticsearch unreachable -- {exc.detail}")
    else:
        emit(8, PASS if hits else FAIL,
             f"{len(hits)} 'advanced successor(s)' record(s)" if hits
             else f"no 'advanced successor(s)' record in the last {window}")

    # -- 9: did it terminate? (ES terminal record) --
    terminal_tpl = by_id["elasticsearch.TerminalCompleted"]["detail"]
    try:
        hits = _es_search(es, terminal_tpl, window, workflow_id, correlation_id)
    except Unreachable as exc:
        emit(9, UNKNOWN, f"elasticsearch unreachable -- {exc.detail}")
    else:
        emit(9, PASS if hits else FAIL,
             f"{len(hits)} terminal record(s)" if hits
             else f"no terminal record in the last {window} -- may still be in flight")

    return rungs


def boundary_and_verdict(rungs: list[Rung]) -> tuple[tuple[int | None, int] | None, str, int]:
    """The last checkpoint that passed, the first that failed: that
    boundary *is* the fault location (spec section 7). Returns
    ``(boundary, message, exit_code)``. ``boundary`` is ``None`` only when
    every rung passed -- a run that reached its terminal step clean.
    """
    first_bad = next((r for r in rungs if r.verdict != PASS), None)
    if first_bad is None:
        return None, "no fault located -- every rung passed; the run reached its terminal step.", EXIT_OK

    idx = rungs.index(first_bad)
    last_good = rungs[idx - 1] if idx > 0 else None
    pair = (last_good.number if last_good else None, first_bad.number)

    if first_bad.verdict == UNKNOWN:
        message = (f"cannot determine at rung {first_bad.number} ({first_bad.question}): "
                   f"{first_bad.evidence}")
        return pair, message, EXIT_UNREACHABLE

    guard = INTERPRETATIONS.get(pair)
    canned = guard(last_good) if guard and last_good else None
    if canned:
        return pair, canned, EXIT_VERDICT

    last_txt = f"rung {last_good.number} passed" if last_good else "no rung passed"
    message = (f"{last_txt}; rung {first_bad.number} ({first_bad.question}) failed: "
               f"{first_bad.evidence} -- no rule for this transition; the evidence above "
               f"is the report.")
    return pair, message, EXIT_VERDICT


def _case_path(home: pathlib.Path, workflow_id: str) -> pathlib.Path:
    cases_dir = home / "cases"
    cases_dir.mkdir(parents=True, exist_ok=True)
    return cases_dir / f"{workflow_id}-{int(time.time())}.json"


def trace(entries: list[dict], clients: dict, home: pathlib.Path, workflow_id: str,
         window: str = "24h", correlation_id: str | None = None,
         processor_override: str | None = None) -> Result:
    case_path = _case_path(home, workflow_id)
    case = CaseFile(case_path, workflow_id, correlation_id)

    rungs = run_ladder(entries, clients, workflow_id, window, case=case,
                       correlation_id=correlation_id, processor_override=processor_override)
    boundary, message, code = boundary_and_verdict(rungs)
    case.finish(boundary, message, code)

    lines = [f"skp investigate trace --workflow {workflow_id}"
            f"{f' --correlation {correlation_id}' if correlation_id else ''} (window {window})", ""]
    for rung in rungs:
        lines.append(f"  #{rung.number} {rung.question}")
        lines.append(f"      {rung.verdict}  {rung.evidence}")
    lines.append("")
    lines.append(message)
    lines.append(f"CASE FILE: {case_path}")

    next_command = "skp remediate" if code == EXIT_VERDICT else \
                   "skp doctor" if code == EXIT_UNREACHABLE else "skp observe projected"
    return Result(code, lines, next_command=next_command)


# ---------------------------------------------------------------------
# lighter access primitives -- "when the ladder ends, access opens"
# ---------------------------------------------------------------------

def blob(entries: list[dict], redis, entry_id: str):
    by_id = index_by_id(entries)
    key = _fill(by_id["redis.ExecutionData"]["detail"], entryId=entry_id)
    try:
        hits = redis.keys(key)
    except Unreachable as exc:
        return EXIT_UNREACHABLE, [f"redis unreachable -- {exc.detail}"]
    if not hits:
        return EXIT_VERDICT, [f"{key}: absent"]
    value = redis.get(key)
    return EXIT_OK, [f"{key}: present ({len(value)} byte(s))", f"  {value[:300]}"]


def parked(entries: list[dict], rabbit, processor_id: str | None = None):
    by_id = index_by_id(entries)
    names = [by_id["rabbitmq.orchestrator.ControlDead"]["detail"],
            by_id["rabbitmq.orchestrator.ResultDead"]["detail"]]
    if processor_id:
        names.append(_fill(by_id["rabbitmq.processor.Dead"]["detail"], processorId=processor_id))
    try:
        live = {q["name"]: q for q in rabbit.queues()}
    except Unreachable as exc:
        return EXIT_UNREACHABLE, [f"rabbitmq unreachable -- {exc.detail}"]
    lines = []
    for name in names:
        q = live.get(name)
        lines.append(f"  {name}: depth={q.get('messages')}" if q else f"  {name}: not found")
    return EXIT_OK, [f"{len(names)} dead-letter queue(s):", *lines]


# ---------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------

def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp investigate")
    parser.add_argument("--home", default=str(default_home()))
    sub = parser.add_subparsers(dest="mode", required=True)

    p = sub.add_parser("trace")
    p.add_argument("--workflow", required=True)
    p.add_argument("--correlation")
    p.add_argument("--processor", help="override rung 3's ProcessorId if rung 2 found none")
    p.add_argument("--window", default="24h")

    p = sub.add_parser("blob")
    p.add_argument("--entry", required=True)

    p = sub.add_parser("parked")
    p.add_argument("--processor")

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

    if ns.mode == "trace":
        return trace(entries, clients, home, ns.workflow, ns.window, ns.correlation, ns.processor)
    if ns.mode == "blob":
        code, lines = blob(entries, clients["redis"], ns.entry)
    elif ns.mode == "parked":
        code, lines = parked(entries, clients["rabbitmq"], ns.processor)
    else:  # pragma: no cover -- argparse's own subparser choices already reject this
        return Result(EXIT_USAGE, [f"unknown mode {ns.mode!r}"], next_command="skp investigate")

    next_command = "skp investigate trace" if code == EXIT_VERDICT else "skp investigate"
    return Result(code, lines, next_command=next_command)
