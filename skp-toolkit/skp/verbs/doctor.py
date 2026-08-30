import argparse
import json
import pathlib

from skp.compile.lock import edited_generated, stale_sources
from skp.profile import Profile, ProfileMissing, default_home, not_initialised
from skp.result import EXIT_DRIFT, EXIT_OK, EXIT_UNREACHABLE, Result
from skp.verbs.init import build_clients, probe
from skp.verbs.map import load_catalog

FIXES = {
    "source drift": "skp init --refresh",
    "generated files": "edit the annotation, not the generated file — then skp init --refresh",
    "catalog present": "skp init --refresh",
}


def _read_lock(lock_path: pathlib.Path):
    """Returns (lock, error). error is None on success.

    A missing or malformed compile.lock is a doctor finding, not a stack trace --
    this is the exact shape of bug Task 7 already had to fix once for ``skp init``.
    """
    try:
        return json.loads(lock_path.read_text(encoding="utf-8")), None
    except (OSError, json.JSONDecodeError) as exc:
        return None, str(exc)


def _target_name(check_name: str) -> str:
    """``reachability: redis`` -> ``redis``. Falls back to the whole name for
    a future check that does not carry the ``reachability: `` prefix, rather
    than raising ``IndexError`` on ``name.split(": ", 1)[1]``."""
    parts = check_name.split(": ", 1)
    return parts[1] if len(parts) > 1 else check_name


def diagnose(profile: Profile, clients: dict) -> list[tuple[str, bool, str]]:
    """Every check, always run. A doctor that stops at the first problem hides
    the second one, and two problems at once is the normal case after a move."""
    rows: list[tuple[str, bool, str]] = []
    model = profile.home / "model"
    lock_path = model / "compile.lock"

    if lock_path.exists():
        lock, err = _read_lock(lock_path)
        if err is not None:
            rows.append(("source drift", False, f"compile.lock unreadable: {err}"))
            rows.append(("generated files", False, f"compile.lock unreadable: {err}"))
        else:
            try:
                stale = stale_sources(lock, pathlib.Path(profile.source_root))
                edited = edited_generated(lock, model)
            except (AttributeError, TypeError) as exc:
                detail = f"compile.lock malformed: {exc}"
                rows.append(("source drift", False, detail))
                rows.append(("generated files", False, detail))
            else:
                rows.append(("source drift", not stale,
                             ", ".join(stale) if stale else "in step with source"))
                rows.append(("generated files", not edited,
                             ", ".join(edited) if edited else "unmodified"))
    else:
        rows.append(("source drift", False, "no compile.lock"))
        rows.append(("generated files", False, "no compile.lock"))

    try:
        entries = load_catalog(profile.home)
    except ProfileMissing:
        rows.append(("catalog present", False, "no catalog.json"))
    except json.JSONDecodeError as exc:
        rows.append(("catalog present", False, f"catalog.json malformed: {exc}"))
    else:
        try:
            untagged = [e.get("id", "?") for e in entries if not e.get("intents")]
        except (AttributeError, TypeError):
            rows.append(("catalog present", False,
                         "catalog.json malformed: expected a list of entries"))
        else:
            rows.append(("catalog present", not untagged,
                         f"{len(entries)} entries" if not untagged
                         else f"{len(untagged)} untagged: {', '.join(untagged[:3])}"))

    for name, ok, detail in probe(clients):
        rows.append((f"reachability: {name}", ok, detail or ("ok" if ok else "no answer")))

    return rows


def run_with(profile: Profile, clients: dict) -> Result:
    """The testable core of ``run()``: everything after the profile is loaded
    and the clients are built. ``run()`` delegates here so tests can inject a
    profile and a fake client table without touching disk or the network."""
    rows = diagnose(profile, clients)
    width = max(len(name) for name, _, _ in rows)
    lines = [f"  {name.ljust(width)}  {'ok' if ok else 'FAIL'}  {detail}".rstrip()
             for name, ok, detail in rows]

    failed = [name for name, ok, _ in rows if not ok]
    if failed:
        toolkit_fix = next((FIXES[name] for name in failed if name in FIXES), None)
        if toolkit_fix:
            return Result(EXIT_DRIFT, [*lines, "", f"{len(failed)} check(s) failed"],
                          next_command=toolkit_fix)
        # Only reachability failed: the toolkit is in step with its source and its
        # generated files are intact. Recompiling cannot help a store that is down,
        # and saying so is the distinction this command exists to draw. I10: this is
        # EXIT_UNREACHABLE, not EXIT_DRIFT -- the prose says "this is the system, not
        # the toolkit" and the exit code has to agree, the same way init.py already
        # does for the identical condition. NEXT: does not loop back into the doctor
        # run that just reported this; it advances to what still works.
        unreachable = [_target_name(name) for name in failed]
        return Result(EXIT_UNREACHABLE,
                      [*lines, "",
                       "the toolkit checks pass — this is the system, not the toolkit",
                       f"not answering: {', '.join(unreachable)}"],
                      next_command="skp map --intent observe")
    return Result(EXIT_OK, lines)


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp doctor")
    parser.add_argument("--home", default=str(default_home()))
    ns = parser.parse_args(argv)

    try:
        profile = Profile.load(pathlib.Path(ns.home))
    except ProfileMissing:
        return not_initialised()

    return run_with(profile, build_clients(profile))
