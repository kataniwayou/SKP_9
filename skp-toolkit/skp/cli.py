import argparse
import pathlib

from skp.profile import Profile, ProfileMissing, default_home
from skp.result import EXIT_USAGE, Result
from skp.verbs import doctor as doctor_verb
from skp.verbs import init as init_verb
from skp.verbs import map as map_verb
from skp.verbs import verify as verify_verb

GROUPS = {"init": init_verb.run, "map": map_verb.run, "doctor": doctor_verb.run,
         "verify": verify_verb.run}
"""Group name -> callable(args: list[str]) -> Result. Populated by later tasks."""


def _extract_home(rest: list[str]) -> pathlib.Path:
    """Best-effort ``--home`` sniff from a group's own argv, for redaction
    only. Never raises -- an unparsed ``--home`` just falls back to default.
    """
    for i, arg in enumerate(rest):
        if arg == "--home" and i + 1 < len(rest):
            return pathlib.Path(rest[i + 1])
        if arg.startswith("--home="):
            return pathlib.Path(arg.split("=", 1)[1])
    return default_home()


def render_output(result: Result, rest: list[str]) -> str:
    """Render a Result and mask the token if a profile is available.

    I5: "the token is never printed" is only a guarantee if every string this
    process writes to stdout passes through ``profile.redact()``. This is the
    one ``print`` in the whole CLI, so it is the one place that has to do it.
    """
    text = result.render()
    try:
        profile = Profile.load(_extract_home(rest))
    except ProfileMissing:
        return text
    except Exception:
        # Redaction must never be the reason a real result fails to print.
        return text
    return profile.redact(text)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="skp", add_help=True)
    parser.add_argument("group", nargs="?", help="command group")
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    ns = parser.parse_args(argv)

    known = ", ".join(sorted(GROUPS)) or "none registered"

    if ns.group is None:
        result = Result(EXIT_USAGE,
                        [f"no command given. known command groups: {known}"],
                        next_command="skp init")
        print(render_output(result, []))
        return result.code

    if ns.group not in GROUPS:
        result = Result(EXIT_USAGE,
                        [f"unknown command group {ns.group!r}. known: {known}"],
                        next_command="skp init")
        print(render_output(result, []))
        return result.code

    try:
        result = GROUPS[ns.group](ns.rest)
    except SystemExit as exc:
        # I4: argparse's own usage errors exit 2, which collides with
        # EXIT_NOT_INITIALISED and has no NEXT: -- a model keying on exit
        # codes concludes "not initialised", loops back into the very
        # command that just failed. --help (code 0/None) is not an error.
        if exc.code in (0, None):
            return 0
        result = Result(EXIT_USAGE,
                        [f"skp {ns.group}: invalid arguments"],
                        next_command=f"skp {ns.group}")

    print(render_output(result, ns.rest))
    return result.code
