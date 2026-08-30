from dataclasses import dataclass

from skp.compile.csharp import const_strings, expression_bodies


@dataclass(frozen=True)
class Surface:
    """One thing the system exposes, as read from source.

    ``id`` is the join key: an annotation file supplies this id's intents and
    prose, and an id with no annotation fails the build.
    """

    component: str
    id: str
    operation: str
    detail: str


def _surface(component: str, name: str, operation: str, detail: str) -> Surface:
    return Surface(component, f"{component}.{name}", operation, detail)


def redis_keys(text: str) -> list[Surface]:
    consts = const_strings(text)
    prefix = consts.get("Prefix", "")
    bodies = expression_bodies(text, consts)
    out = []
    for name, body in bodies.items():
        out.append(_surface("redis", name, "read key", body.replace("{Prefix}", prefix)))
    return sorted(out, key=lambda s: s.id)


def queues(processor_text: str, orchestrator_text: str) -> list[Surface]:
    """Queue and exchange names from both topology classes.

    Ids carry their declaring source because the two classes each define a
    `DeadLetterExchange`; a bare member name would collide and one real
    exchange would vanish at the first lookup by id.
    """
    out = []
    for namespace, text in (("processor", processor_text),
                            ("orchestrator", orchestrator_text)):
        consts = const_strings(text)
        for name, value in consts.items():
            out.append(_surface("rabbitmq", f"{namespace}.{name}", "list_queues", value))
        for name, body in expression_bodies(text, consts).items():
            out.append(_surface("rabbitmq", f"{namespace}.{name}", "list_queues", body))
    return sorted(out, key=lambda s: s.id)


def templates(text: str) -> list[Surface]:
    return sorted(
        (_surface("elasticsearch", name, "search by attributes.{OriginalFormat}", value)
         for name, value in const_strings(text).items()),
        key=lambda s: s.id)
