import argparse

from skp.result import EXIT_USAGE, Result
from skp.verbs import doctor as doctor_verb
from skp.verbs import init as init_verb
from skp.verbs import map as map_verb

GROUPS = {"init": init_verb.run, "map": map_verb.run, "doctor": doctor_verb.run}
"""Group name -> callable(args: list[str]) -> Result. Populated by later tasks."""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="skp", add_help=True)
    parser.add_argument("group", nargs="?", help="command group")
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    ns = parser.parse_args(argv)

    if ns.group is None or ns.group not in GROUPS:
        known = ", ".join(sorted(GROUPS)) or "none registered"
        result = Result(EXIT_USAGE,
                        [f"unknown command group {ns.group!r}. known: {known}"],
                        next_command="skp init")
    else:
        result = GROUPS[ns.group](ns.rest)

    print(result.render())
    return result.code
