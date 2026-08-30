import re
from dataclasses import dataclass

from skp.compile.csharp import const_strings, expression_bodies, literals_matching

_DBSET = re.compile(r"DbSet<\w+>\s+(\w+)\s*=>")
_CONTROLLER_CLASS = re.compile(r"class\s+(\w+)Controller\b")
_INHERITS_BASE = re.compile(r"BaseController<")
_HTTP_ATTR = re.compile(r'\[Http(Get|Post|Put|Delete)(?:\("([^"]*)"\))?\]')

API_PREFIX = "/api/v1.0"

INHERITED_VERBS = [
    ("GET", ""),
    ("GET", "{id}"),
    ("POST", ""),
    ("PUT", "{id}"),
    ("DELETE", "{id}"),
]


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


def metrics(texts: list[str]) -> list[Surface]:
    """Every ``pipeline.*`` instrument, across every declaration shape.

    Matching the declaration syntax would mean tracking four Meter.Create* forms
    plus the ``const string ...Instrument`` convention. The value's prefix is
    uniform where the syntax is not, so the scan is on the value.
    """
    names: set[str] = set()
    for text in texts:
        names.update(literals_matching(text, "pipeline."))
    return sorted(
        (Surface("prometheus", f"prometheus.{name.replace('.', '_')}",
                 f"instant query on {name}", name) for name in names),
        key=lambda s: s.id)


def _route_token(class_name: str) -> str:
    """``WorkflowsController`` -> ``workflows``. The [controller] token convention."""
    return class_name.lower()


def rest_endpoints(controller_texts: dict[str, str]) -> list[Surface]:
    out: list[Surface] = []
    for text in controller_texts.values():
        match = _CONTROLLER_CLASS.search(text)
        if not match:
            continue
        token = _route_token(match.group(1))
        base = f"{API_PREFIX}/{token}"

        if _INHERITS_BASE.search(text):
            for verb, tail in INHERITED_VERBS:
                path = f"{base}/{tail}" if tail else base
                out.append(Surface("api", f"api.{token}.{verb.lower()}{'_id' if tail else ''}",
                                   f"{verb} {path}", token))

        for verb, tail in _HTTP_ATTR.findall(text):
            if not tail:
                continue  # an undecorated attribute on a BaseController subclass is inherited
            path = f"{base}/{tail}"
            slug = re.sub(r"[^a-z0-9]+", "_", tail.lower()).strip("_")
            out.append(Surface("api", f"api.{token}.{verb.lower()}_{slug}",
                               f"{verb.upper()} {path}", token))
    return sorted(out, key=lambda s: s.id)


def pg_tables(dbcontext_text: str) -> list[Surface]:
    return sorted(
        (_surface("postgres", name, f'SELECT ... FROM "{name}"', name)
         for name in _DBSET.findall(dbcontext_text)),
        key=lambda s: s.id)
