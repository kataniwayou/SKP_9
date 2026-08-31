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
from skp.profile import Profile, ProfileMissing, default_home
from skp.result import (EXIT_NOT_INITIALISED, EXIT_OK, EXIT_UNREACHABLE,
                        EXIT_USAGE, EXIT_VERDICT, Result)
from skp.verbs.init import build_clients
from skp.verbs.map import load_catalog

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


def gate_result(status: int, text: str) -> Result | None:
    """A 422 rendered as a gate verdict, or None when this is not a gate."""
    if status != 422:
        return None
    try:
        body = json.loads(text)
    except ValueError:
        body = {}
    gate = (body.get("errors") or {}).get("gate")
    if not gate:
        return Result(EXIT_VERDICT, [f"rejected with HTTP 422: {text[:200]}"],
                      next_command="skp doctor")
    lines = [f"rejected at gate {gate!r}", body.get("detail", "")]
    offending = (body.get("errors") or {}).get("offending")
    if offending is not None:
        lines.append("offending: " + json.dumps(offending, sort_keys=True))
    return Result(EXIT_VERDICT, [ln for ln in lines if ln],
                  next_command="skp investigate",
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

    gated = gate_result(status, text)
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
    ], next_command="skp investigate")


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

    if status not in (200, 204):
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
        ], next_command="skp investigate")

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

    handler = {"start": start, "stop": stop}[ns.mode]
    result = handler(entries, clients, ns.workflow, ns.confirm)
    if result.code == EXIT_OK:
        state.record(home, "workflow", ns.workflow)
    return result
