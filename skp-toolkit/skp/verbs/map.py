import argparse
import json
import pathlib
import re

from skp.profile import ProfileMissing, default_home, not_compiled, not_initialised
from skp.result import EXIT_OK, EXIT_VERDICT, Result

STOPWORDS = {"a", "an", "the", "did", "do", "does", "is", "are", "was", "were",
             "why", "what", "which", "where", "how", "to", "of", "in", "on",
             "at", "for", "i", "my", "it", "that", "this"}


def load_catalog(home: pathlib.Path) -> list[dict]:
    path = home / "model" / "catalog.json"
    if not path.exists():
        raise ProfileMissing(str(path))
    return json.loads(path.read_text(encoding="utf-8"))


def by_component(entries: list[dict], name: str) -> list[dict]:
    return [e for e in entries if e["component"] == name]


def index_by_id(entries: list[dict]) -> dict[str, dict]:
    """Every entry keyed by its catalog id -- the lookup ``skp observe`` and
    ``skp investigate`` use to turn a capability id into the concrete key
    pattern, queue name, or log template ``extract.py`` read from source.
    This is the one join point: neither verb ever spells a Redis key,
    queue name or ES template as a literal string of its own."""
    return {e["id"]: e for e in entries}


def by_intent(entries: list[dict], intent: str) -> list[dict]:
    return [e for e in entries if intent in e.get("intents", [])]


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", text.lower()) if w not in STOPWORDS}


def by_question(entries: list[dict], question: str) -> list[dict]:
    """Rank by word overlap with each entry's ``answers`` text.

    Crude on purpose: this narrows seven components to one or two, and the model
    reads real entries after that. Entries with no overlap are dropped rather
    than ranked last -- returning nothing is a better answer than a bad guess.
    """
    asked = _words(question)
    scored = []
    for entry in entries:
        overlap = len(asked & _words(entry.get("answers", "")))
        if overlap:
            scored.append((overlap, entry["id"], entry))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [entry for _, _, entry in scored]


def render(entries: list[dict]) -> str:
    blocks = []
    for entry in entries:
        block = [
            f"{entry['id']}  [{', '.join(entry.get('intents', []))}]",
            f"  {entry['operation']}   -> {entry['detail']}",
            f"  ANSWERS: {entry.get('answers', '')}",
        ]
        if entry.get("never_for"):
            block.append(f"  NEVER: {entry['never_for']}")
        if entry.get("verb"):
            block.append(f"  VERB: {entry['verb']}")
        blocks.append("\n".join(block))
    return "\n\n".join(blocks)


def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp map")
    parser.add_argument("--home", default=str(default_home()))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--component")
    mode.add_argument("--intent")
    mode.add_argument("--answers")
    ns = parser.parse_args(argv)

    home = pathlib.Path(ns.home)
    # A missing catalog.json raises the same ProfileMissing whether or not
    # the memory folder itself exists. Distinguish the two: "not initialised"
    # is wrong once the folder plainly exists (see the map.py/doctor.py
    # minor in the final fix brief).
    if not (home / "profile.json").exists():
        return not_initialised()
    try:
        entries = load_catalog(home)
    except ProfileMissing:
        return not_compiled(home)

    if ns.component:
        found, what = by_component(entries, ns.component), f"component {ns.component!r}"
    elif ns.intent:
        found, what = by_intent(entries, ns.intent), f"intent {ns.intent!r}"
    elif ns.answers:
        found, what = by_question(entries, ns.answers), f"question {ns.answers!r}"
    else:
        components = sorted({e["component"] for e in entries})
        return Result(EXIT_OK,
                      [f"{len(entries)} capabilities across: {', '.join(components)}"],
                      next_command="skp map --component <name>")

    if not found:
        return Result(EXIT_VERDICT,
                      [f"no catalog entry for {what}",
                       "this is a gap, not a reason to guess — report it"],
                      next_command="skp map")
    return Result(EXIT_OK, [render(found)])
