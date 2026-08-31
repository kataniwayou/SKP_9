"""`skp author` -- design and verify workflow definitions.

**This verb reimplements nothing.** The five gates -- cycle, missingStep,
schemaEdge, payloadConfigSchema, processorLiveness -- live in
``OrchestrationService.StartAsync``, run before any side effect, and report
themselves in the 422's ``errors.gate``. Copying them into Python would give
this toolkit a second opinion free to disagree with the system, which is the
confabulation the whole design exists to prevent (spec §2: a hand-written
copy "is recall with extra steps, and fails the same silent way when the C#
moves").

**There is no dry-run, and the verb says so.** Passing every gate IS
starting: ``StartAsync`` sends ``StartOrchestration`` the moment the fifth
gate returns. So a rejection is free, a pass is a running workflow, and
``--confirm-start`` is the gate on that write (spec §8).
"""
import argparse
import json
import pathlib

from skp import state
from skp.profile import Profile, ProfileMissing, default_home
from skp.result import (EXIT_NOT_INITIALISED, EXIT_OK, EXIT_UNREACHABLE,
                        EXIT_USAGE, EXIT_VERDICT, Result)
from skp.verbs import operate
from skp.verbs.init import build_clients
from skp.verbs.map import load_catalog

START_ID = "api.orchestration.post_start"


def path_for(entries: list[dict], surface_id: str) -> str | None:
    for entry in entries:
        if entry["id"] == surface_id:
            return entry["operation"].split(" ", 1)[1]
    return None


def _body(text: str) -> dict:
    try:
        return json.loads(text) if text else {}
    except ValueError:
        return {}


def validate(entries: list[dict], clients: dict, workflow_id: str,
             confirm_start: bool) -> Result:
    path = path_for(entries, START_ID)
    if path is None:
        return Result(EXIT_NOT_INITIALISED,
                      [f"{START_ID} is not in the catalog"],
                      next_command="skp init --refresh")

    if not confirm_start:
        return Result(EXIT_USAGE, [
            "skp author validate runs the system's own five gates by calling",
            f"POST {path}. There is no dry-run: a workflow that passes every",
            "gate is STARTED by the same call that validates it.",
            "",
            "A rejection costs nothing -- all five gates run before any write.",
            "Re-run with --confirm-start once you accept that a valid graph",
            "will begin running.",
        ], next_command=(f"skp author validate --workflow {workflow_id} "
                         f"--confirm-start"))

    try:
        status, text = clients["baseapi"].http.probe_status("POST", path, workflow_id)
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"POST {path} failed -- {exc}"],
                      next_command="skp doctor")

    # I5: the same 422 shape operate.start renders -- one implementation,
    # shared, so the two verbs never drift into rendering the identical
    # gate rejection two different ways. Only the NEXT: differs by caller.
    gated = operate.gate_result(
        status, text, next_command="skp author apply --spec <file> --confirm-write")
    if gated is not None:
        return gated

    if status in (200, 202):
        return Result(EXIT_OK, [
            f"valid -- all five gates passed (HTTP {status}).",
            "The workflow is now RUNNING: the call that validates is the call",
            "that starts. 202 means accepted, not applied.",
        ], next_command=f"skp operate verify --workflow {workflow_id}")

    body = _body(text)
    detail = body.get("detail") or text[:200] or f"HTTP {status}"
    return Result(EXIT_VERDICT, [f"start refused with HTTP {status}: {detail}"],
                  next_command="skp map --component api")


# The foreign-key graph, read from the live database rather than assumed:
#   processors -> schemas
#   steps -> processors
#   assignments -> steps
#   workflow_entry_steps -> workflows, steps
#   workflow_assignments -> workflows, assignments
# The junctions ride the workflow body, so workflows go last.
APPLY_ORDER = ("schemas", "processors", "steps", "assignments", "workflows")


def _landed(applied: list[str]) -> str:
    if not applied:
        return "nothing"
    counts: dict[str, int] = {}
    for section in applied:
        counts[section] = counts.get(section, 0) + 1
    return ", ".join(f"{n} {s}" for s, n in counts.items())


def apply(entries: list[dict], clients: dict, spec: dict,
          confirm_write: bool) -> Result:
    """POSTs each section verbatim, in foreign-key order.

    The bodies are passed through untouched. This toolkit does not know the
    DTO shapes and must not learn them: a translation layer here would be a
    second definition of the contract, free to drift from the validators that
    actually run. A malformed body comes back as the API's own 400 with its
    own message, which is the authority.
    """
    unknown = [k for k in spec if k not in APPLY_ORDER]
    if unknown:
        return Result(EXIT_USAGE,
                      [f"unknown spec section(s): {', '.join(sorted(unknown))}",
                       f"known sections, in apply order: {', '.join(APPLY_ORDER)}"],
                      next_command="skp author apply --spec <file>")

    if not confirm_write:
        planned = ", ".join(f"{len(spec[s])} {s}" for s in APPLY_ORDER if spec.get(s))
        return Result(EXIT_USAGE,
                      ["skp author apply writes to the live system.",
                       f"planned, in foreign-key order: {planned or 'nothing'}",
                       "re-run with --confirm-write to apply."],
                      next_command="skp author apply --spec <file> --confirm-write")

    applied: list[str] = []
    for section in APPLY_ORDER:
        path = path_for(entries, f"api.{section}.post")
        if path is None:
            return Result(EXIT_NOT_INITIALISED,
                          [f"api.{section}.post is not in the catalog"],
                          next_command="skp init --refresh")
        for index, body in enumerate(spec.get(section) or []):
            try:
                status, text = clients["baseapi"].http.probe_status("POST", path, body)
            except Exception as exc:
                return Result(EXIT_UNREACHABLE,
                              [f"POST {path} failed -- {exc}",
                               f"applied before the failure: {_landed(applied)}"],
                              next_command="skp doctor")
            if status not in (200, 201, 202, 204):
                detail = _body(text).get("detail") or text[:200] or f"HTTP {status}"
                return Result(EXIT_VERDICT, [
                    f"{section}[{index}] rejected with HTTP {status}: {detail}",
                    f"applied before the failure: {_landed(applied)}",
                    "The definition is now PARTIAL. Fix the section and "
                    "re-apply; rows already created will collide rather than "
                    "duplicate.",
                ], next_command="skp author apply --spec <file> --confirm-write")
            applied.append(section)

    return Result(EXIT_OK, [f"applied: {_landed(applied)}"],
                  next_command="skp author validate --workflow <id> --confirm-start")


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp author")
    parser.add_argument("--home", default=str(default_home()))
    sub = parser.add_subparsers(dest="mode", required=True)

    p = sub.add_parser("validate")
    p.add_argument("--workflow", required=True)
    p.add_argument("--confirm-start", action="store_true")

    p = sub.add_parser("apply")
    p.add_argument("--spec", required=True)
    p.add_argument("--confirm-write", action="store_true")

    ns = parser.parse_args(argv)
    home = pathlib.Path(ns.home)
    try:
        profile = Profile.load(home)
    except ProfileMissing:
        return Result(EXIT_NOT_INITIALISED, ["no profile in " + str(home)],
                      next_command="skp init")

    entries = load_catalog(home)
    clients = build_clients(profile)

    if ns.mode == "validate":
        result = validate(entries, clients, ns.workflow, ns.confirm_start)
        if result.code == EXIT_OK:
            state.record(home, "workflow", ns.workflow)
        return result

    if ns.mode == "apply":
        try:
            spec = json.loads(pathlib.Path(ns.spec).read_text(encoding="utf-8"))
        except OSError as exc:
            return Result(EXIT_USAGE, [f"cannot read {ns.spec}: {exc}"],
                          next_command="skp author apply --spec <file>")
        except ValueError as exc:
            return Result(EXIT_USAGE, [f"{ns.spec} is not valid JSON: {exc}"],
                          next_command="skp author apply --spec <file>")
        return apply(entries, clients, spec, ns.confirm_write)

    return Result(EXIT_USAGE, [f"unknown mode {ns.mode!r}"],
                  next_command="skp author validate --workflow <id>")
