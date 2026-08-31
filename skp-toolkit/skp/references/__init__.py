"""The remedy files a failure names in its ``SEE:`` line.

Spec §4.2: "Every failure prints the reference file that explains it. The
*tool* decides when context is needed, which it can do correctly and the
model cannot." Keeping these out of the verb bodies is what lets a Phase 5
leaf stay under its 1200-token budget while still covering every failure it
can reach.
"""
import pathlib

DIR = pathlib.Path(__file__).resolve().parent

_SLUGS = {
    "cycle": "gate-cycle",
    "missingStep": "gate-missing-step",
    "schemaEdge": "gate-schema-edge",
    "payloadConfigSchema": "gate-payload-config-schema",
    "processorLiveness": "gate-processor-liveness",
}


def slug_for(gate: str) -> str:
    """camelCase gate -> kebab-case file stem.

    An unknown gate gets a derived slug rather than an exception: a gate this
    toolkit has never seen is precisely what the doctor coverage check exists
    to report, and it cannot report what it cannot name.
    """
    if gate in _SLUGS:
        return _SLUGS[gate]
    kebab = "".join("-" + c.lower() if c.isupper() else c for c in gate)
    return "gate-" + kebab.lstrip("-")


def path_for(gate: str) -> pathlib.Path:
    return DIR / f"{slug_for(gate)}.md"


def reference_for(gate: str) -> str:
    """The path as the model should see it in a ``SEE:`` line."""
    return f"references/{slug_for(gate)}.md"
