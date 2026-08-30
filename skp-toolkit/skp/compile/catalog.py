import json
import pathlib
from collections import Counter
from dataclasses import dataclass, field

INTENTS = ("design", "control", "observe", "analyze",
           "investigate", "verify", "remediate")
"""Closed, and closed is load-bearing: an open vocabulary lets a model invent a
category, find nothing, and improvise."""


class CatalogError(Exception):
    """The catalog does not describe the system. Never recoverable at runtime."""


@dataclass
class Entry:
    id: str
    component: str
    operation: str
    detail: str
    intents: list[str] = field(default_factory=list)
    answers: str = ""
    never_for: str = ""
    write_authority: str = "none"
    cost: str = "cheap"
    verb: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id, "component": self.component, "operation": self.operation,
            "detail": self.detail, "intents": self.intents, "answers": self.answers,
            "never_for": self.never_for, "write_authority": self.write_authority,
            "cost": self.cost, "verb": self.verb,
        }


def load_annotations(directory: pathlib.Path) -> dict[str, dict]:
    merged: dict[str, dict] = {}
    for path in sorted(directory.glob("*.json")):
        merged.update(json.loads(path.read_text(encoding="utf-8")))
    return merged


def build(surfaces, annotations: dict[str, dict]) -> list[Entry]:
    entries = []
    for surface in surfaces:
        note = annotations.get(surface.id, {})
        entries.append(Entry(
            id=surface.id,
            component=surface.component,
            operation=surface.operation,
            detail=surface.detail,
            intents=list(note.get("intents", [])),
            answers=note.get("answers", ""),
            never_for=note.get("never_for", ""),
            write_authority=note.get("write_authority", "none"),
            cost=note.get("cost", "cheap"),
            verb=note.get("verb", ""),
        ))
    return sorted(entries, key=lambda e: e.id)


def check(entries: list[Entry], surfaces, annotations: dict[str, dict]) -> list[str]:
    """Every problem, not just the first: a build that fails four ways should say so."""
    problems: list[str] = []

    for surface in surfaces:
        if surface.id not in annotations:
            problems.append(
                f"{surface.id}: discovered in source but has no annotation "
                f"(add it to skp/annotations/)")

    id_counts = Counter(surface.id for surface in surfaces)
    for surface_id, count in sorted(id_counts.items()):
        if count > 1:
            problems.append(
                f"{surface_id}: duplicate id — {count} surfaces claim it "
                f"(a collapsed id silently discards the others; ids must be unique)")

    for entry in entries:
        if not entry.intents:
            problems.append(f"{entry.id}: no intent — every capability must be categorised")
        for intent in entry.intents:
            if intent not in INTENTS:
                problems.append(
                    f"{entry.id}: unknown intent {intent!r} — the taxonomy is closed: "
                    f"{', '.join(INTENTS)}")

    covered = {i for entry in entries for i in entry.intents}
    for intent in INTENTS:
        if intent not in covered:
            problems.append(
                f"no capability serves intent {intent!r} — that is a gap in the "
                f"shipped system, not in this file")

    return problems
