"""The invocable command surface, and the verbs the catalog names but does not have.

``skp doctor`` checks every annotation's ``verb`` against this module. The check
exists because a ``verb`` field is an instruction: the offline model reads it and
runs it. A verb naming a command that does not exist spends the model's one
attempt on an argparse usage error, which is indistinguishable to it from the
system being broken -- the failure this bundle is built to remove, reintroduced
by the catalog itself.

``PLANNED`` is the seam, and it is deliberately not a default. Section 12 of the
design already names "a capability has no verb" as a real state -- it routes to
"write the verb, tag its intents, recompile", which comes back to this repo. So
an unbuilt verb is recorded here WITH its justification rather than silently
dropped from the entry, because dropping it would erase the gap the design wants
reported. Adding a line here is a decision someone has to write down; leaving a
dangling verb in an annotation is not.
"""

INVOCABLE = {
    "skp init",
    "skp map",
    "skp doctor",
    "skp observe projected", "skp observe liveness", "skp observe queues",
    "skp observe gate", "skp observe pods", "skp observe rollout",
    "skp observe manifest", "skp observe readiness", "skp observe startup",
    "skp observe rate",
    "skp investigate trace", "skp investigate blob", "skp investigate parked",
    "skp verify",
    "skp operate start", "skp operate stop", "skp operate freeze", "skp operate verify",
    "skp author validate", "skp author apply",
}

PLANNED = {
    "skp analyze backlog":
        "no analyze verb exists. The intent is in the taxonomy and has catalog "
        "coverage; the verb is phase-4 work and returns to this repo.",
    "skp analyze latency":
        "same as analyze backlog. Quantifying over a window is catalogued and "
        "unbuilt; skp observe rate is the nearest shipped capability.",
    "skp investigate fault-window":
        "the fault/heal template pairs are catalogued and there is no verb that "
        "walks a window of them. skp investigate trace covers one run, not one "
        "fault window.",
    "skp investigate restart":
        "reading a restart from its log templates has no verb; the Prometheus "
        "side of the same question is skp observe rate.",
    "skp investigate logs":
        "cluster.logs is catalogued as a capability and no verb wraps it. "
        "skp observe pods names the pod to read by hand.",
    "skp author get": "author ships validate and apply; single-entity reads are unbuilt.",
    "skp author list": "author ships validate and apply; listing is unbuilt.",
    "skp author update": "author ships validate and apply; in-place update is unbuilt.",
    "skp author delete": "author ships validate and apply; delete is unbuilt.",
    "skp author lookup-by-hash":
        "the by-source-hash route is catalogued with its byte-exact-lowercase "
        "trap and has no verb; it is phase-4 processor-ship work.",
}


def resolve(verb: str) -> tuple[bool, str]:
    """``(ok, reason)`` for one annotation ``verb`` string.

    A PLANNED verb is ``ok``. This is the load-bearing choice in the module and
    the reasoning is section 6.5's: a capability with no verb is "a gap in the
    shipped system, reported rather than hidden" -- reported, not failed. What
    must fail is a verb that is neither invocable nor written down, because that
    is a rename, a typo, or a verb somebody deleted, and those are drift. The
    doctor row still prints how many are planned, so declaring one buys silence
    from the exit code and nothing from the output.

    Matched on the longest declared prefix, because a real command may carry
    arguments the annotation spells out -- ``skp verify --component rabbitmq``
    is ``skp verify`` invoked correctly, and ``skp author get --entity steps``
    is a planned ``skp author get``. Matching on the whole string instead would
    make every argument a new command.
    """
    if not verb:
        return True, "no verb claimed"
    for command in sorted(INVOCABLE, key=len, reverse=True):
        if verb == command or verb.startswith(command + " "):
            return True, command
    for command in sorted(PLANNED, key=len, reverse=True):
        if verb == command or verb.startswith(command + " "):
            return True, f"planned: {PLANNED[command]}"
    return False, "names no command, and is not a declared planned verb"
