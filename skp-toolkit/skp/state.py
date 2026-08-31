"""The `state/` ledger -- spec §5, "compensates for forgetfulness".

A small model does not hold the workflow id from four turns ago, so verbs
record what they acted on and later verbs default to it. Deliberately tiny:
one file per key, last write wins, and a corrupt or absent file recalls as
``None`` so a damaged ledger degrades to "pass --workflow" rather than to a
crash mid-investigation.
"""
import json
import pathlib

KEYS = frozenset({"workflow"})


def _path(home: pathlib.Path, key: str) -> pathlib.Path:
    if key not in KEYS:
        raise ValueError(f"unknown state key {key!r}; known: {sorted(KEYS)}")
    return home / "state" / f"{key}.json"


def record(home: pathlib.Path, key: str, value: str) -> None:
    path = _path(home, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"value": value}), encoding="utf-8")


def recall(home: pathlib.Path, key: str) -> str | None:
    try:
        return json.loads(_path(home, key).read_text(encoding="utf-8"))["value"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
