import re
from dataclasses import dataclass

from skp.compile.catalog import CatalogError
from skp.compile.csharp import const_strings, expression_bodies, literals_matching, unescape

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


_PLACEHOLDER = re.compile(r"\{([A-Za-z_]\w*)\}")
_TOSTRING_FORMAT = re.compile(r'\.ToString\(\s*"(\w)"\s*\)')

_LOG_RECORD_CS = "LogRecord.cs (FromSource)"
_BASE_CONSOLE_OBS_EXT_CS = "BaseConsoleObservabilityExtensions.cs (AddBaseConsoleObservability)"

ELASTICSEARCH_ENVELOPE = [
    ("timestamp", "@timestamp",
     "record time; arrives as either an ISO-8601 string or epoch milliseconds with a fractional part",
     _LOG_RECORD_CS),
    ("body_text", "body.text", "the rendered message text", _LOG_RECORD_CS),
    ("original_format", "attributes.{OriginalFormat}",
     "the unsubstituted template -- what templates() catalogues one surface per", _LOG_RECORD_CS),
    ("service_name", "resource.attributes.service.name", "which role emitted the record",
     _LOG_RECORD_CS),
    ("service_instance_id", "resource.attributes.service.instance.id",
     "the replica identity -- the field a per-replica query must group on instead of "
     "resource.attributes.service.name, which every replica of a role shares",
     _BASE_CONSOLE_OBS_EXT_CS),
    ("source", "resource.attributes.Source",
     "the application type stamped on the resource -- worker/webapi; coarser than "
     "service.name and not a substitute for it (AddBaseConsoleObservability/"
     "AddBaseApiObservability)", _BASE_CONSOLE_OBS_EXT_CS),
    ("scope_name", "scope.name", "the .NET logger category name", _LOG_RECORD_CS),
]
"""Hand-listed, not extracted: none of this is C#. Each entry names its own
authority (fourth tuple element) rather than assuming ``LogRecord.cs`` for
all of them: that reader (``FromSource``) is cut down to the fields *it*
queries, not a schema, and it does not read ``service.instance.id`` or
``Source`` at all. Those two are verified instead against
``BaseConsoleObservabilityExtensions.cs``, where the log resource's
attributes are actually assembled -- stating the wrong authority for a field
neither oracle reads would be exactly the kind of unverifiable claim this
wave exists to remove."""


def log_attributes(templates_text: str, scope_text: str, correlation_text: str) -> list[Surface]:
    """Every field this catalog can attribute to an Elasticsearch log record:
    placeholder-derived, dispatch-scope, correlation, and the hand-listed
    envelope (see ``ELASTICSEARCH_ENVELOPE``) -- not a claim that this is
    every field a raw document holds, since the envelope's own authority is
    itself a cut-down consumer rather than a schema.

    **Message-scoped.** Every ``{Placeholder}`` in a log template becomes
    ``attributes.<Placeholder>`` -- mechanical, since ``templates()`` already
    reads all 26 templates and the vocabulary is just their placeholders.
    Present only on the records whose own template names it.

    **Dispatch-scope.** The five ``ExecutionLogScope`` ids ride the scope
    ``ProcessDispatchHandler`` opens for the whole hop, so they appear on
    every record that hop writes whether or not its template names them --
    a different presence rule from the message-scoped attributes above, and
    the ``detail`` text says so.

    **The trap.** ``ExecutionLogScope.BuildScope`` renders every id with
    ``ToString("D")`` (hyphenated); ``CorrelationKeys.Render`` renders with
    ``ToString("N")`` (32 lowercase hex, no dashes) -- verified here by
    scanning both sources for the literal format character rather than
    trusting prose, so a future rendering change shows up as a changed
    surface instead of a stale comment. A query formatting one id like the
    other returns zero hits.
    """
    out: list[Surface] = []

    sources: dict[str, list[str]] = {}
    for template_name, template_value in const_strings(templates_text).items():
        for placeholder in _PLACEHOLDER.findall(template_value):
            sources.setdefault(placeholder, []).append(template_name)
    for name, from_templates in sorted(sources.items()):
        example = sorted(from_templates)[0]
        out.append(_surface(
            "elasticsearch", f"attr.{name}",
            f"search by attributes.{name}",
            f"attributes.{name} -- message-scoped placeholder, present only on a record whose "
            f"own template names it (e.g. {example})"))

    scope_consts = const_strings(scope_text)
    scope_formats = sorted(set(_TOSTRING_FORMAT.findall(scope_text)))
    scope_format = scope_formats[0] if len(scope_formats) == 1 else ("/".join(scope_formats) or "?")
    for _member, value in sorted(scope_consts.items(), key=lambda kv: kv[1]):
        out.append(_surface(
            "elasticsearch", f"attr.{value}",
            f"search by attributes.{value}",
            f'attributes.{value} -- dispatch-scope id (ExecutionLogScope.BuildScope), rides every '
            f'record the hop writes regardless of its own template; renders "{scope_format}" '
            f'(hyphenated) -- DIFFERENT from CorrelationId, which renders "N" (no dashes)'))

    correlation_consts = const_strings(correlation_text)
    correlation_formats = sorted(set(_TOSTRING_FORMAT.findall(correlation_text)))
    correlation_format = (correlation_formats[0] if len(correlation_formats) == 1
                          else ("/".join(correlation_formats) or "?"))
    for _member, value in sorted(correlation_consts.items(), key=lambda kv: kv[1]):
        out.append(_surface(
            "elasticsearch", f"attr.{value}",
            f"search by attributes.{value}",
            f'attributes.{value} -- cross-boundary correlation id (CorrelationKeys.Render); renders '
            f'"{correlation_format}" (32 lowercase hex, no dashes) -- DIFFERENT from every '
            f'ExecutionLogScope id, which renders "{scope_format}" (hyphenated)'))

    for name, path, note, authority in ELASTICSEARCH_ENVELOPE:
        out.append(_surface(
            "elasticsearch", f"attr.{name}",
            f"read {path}",
            f"{path} -- fixed envelope field, hand-listed from {authority} (not extracted): {note}"))

    return sorted(out, key=lambda s: s.id)


_METHOD_START = re.compile(
    r'(?:public|internal|private)\s+(?:static\s+)?(?:async\s+)?'
    r'[^{};(]+?\s(\w+)\s*\([^)]*\)\s*')

_TAGLIST_ENTRY = re.compile(r'\{\s*"(\w+)"\s*,\s*[^{}]+?\}')
_KVP_ENTRY = re.compile(r'KeyValuePair<[^>]*>\(\s*"(\w+)"\s*,')

_FIELD_INSTRUMENT = re.compile(
    r'(?:Counter|Histogram)<[\w,\s]+>\s+(\w+)\s*=\s*Meter\.Create(?:Counter|Histogram)<[\w,\s]+>\(\s*'
    r'([\w.]+|"(?:[^"\\]|\\.)*")')

_OBSERVABLE_CALL = re.compile(
    r'Meter\.CreateObservable(?:Gauge|Counter)(?:<[\w,\s]*>)?\(\s*'
    r'([\w.]+|"(?:[^"\\]|\\.)*")\s*,\s*(.+?)\s*,\s*unit\s*:',
    re.DOTALL)


_STRING_SPAN = re.compile(r'@"(?:[^"]|"")*"|\'(?:[^\'\\]|\\.)*\'|"(?:[^"\\]|\\.)*"')


def _match_brace(text: str, open_idx: int) -> int:
    """Index of the ``}`` matching the ``{`` at ``open_idx``.

    Braces inside a string or char literal are ignored, so a unit string like
    ``"{message}"`` cannot desynchronise the count. Whole spans are matched
    and skipped with ``_STRING_SPAN`` -- the same verbatim-string and char-
    literal alternatives ``_strip_comments`` uses -- rather than a hand-rolled
    quote/escape toggle, so a bare ``"`` inside a char literal (``'"'``) or a
    verbatim string's trailing backslash (``@"C:\\dir\\"``) cannot
    desynchronise this scan the way it used to desynchronise comment
    stripping (I2): the same failure mode, guarded the same way.
    """
    depth = 0
    i = open_idx
    n = len(text)
    while i < n:
        m = _STRING_SPAN.match(text, i)
        if m:
            i = m.end()
            continue
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise CatalogError("unbalanced braces while scanning a method body for tags")


def _method_bodies(text: str) -> dict[str, str]:
    """Every method's own body text, keyed by method name.

    Coarse rather than a real parser -- a "method" is whatever follows an
    access modifier and looks like ``Name(params)``, block- or
    expression-bodied. That is good enough for the small, uniformly
    formatted ``*Metrics.cs`` files this feeds: see ``metric_labels``'s
    method-scope association rule.

    **Raises on a genuine duplicate method name** -- two bodies that would
    collapse onto the same dict key, last one silently winning and hiding
    whichever call site the label scan needed. A field declaration the
    regex mis-parses as a zero-arg method named ``new`` (``= new(...)``,
    common in this codebase) does not count: it never resolves to a ``{``
    or ``=>`` body, so it never reaches the dict at all and cannot collide.
    """
    bodies: dict[str, str] = {}
    for m in _METHOD_START.finditer(text):
        name = m.group(1)
        i = m.end()
        while i < len(text) and text[i].isspace():
            i += 1
        body = None
        if i < len(text) and text[i] == "{":
            body = text[i + 1:_match_brace(text, i)]
        elif text[i:i + 2] == "=>":
            end = text.find(";", i + 2)
            if end != -1:
                body = text[i + 2:end]
        if body is not None:
            if name in bodies:
                raise CatalogError(
                    f"duplicate method name {name!r} found scanning method bodies "
                    f"(overload?) -- last-one-wins would silently drop the other body "
                    f"a label scan might need")
            bodies[name] = body
    return bodies


def _tag_keys(text: str) -> set[str]:
    """Every tag key literally present in ``text``, from either shape the
    source uses: ``{ "queue", queue }`` inside a ``TagList`` initialiser, or
    ``new KeyValuePair<string, object?>("outcome", outcome)``."""
    return ({m.group(1) for m in _TAGLIST_ENTRY.finditer(text)} |
            {m.group(1) for m in _KVP_ENTRY.finditer(text)})


_AMBIENT_TAG_APPEND = re.compile(r"PipelineAmbientTag\.AppendTo\s*\(\s*ref\s+tags\s*\)")


def _method_labels(body: str) -> set[str]:
    """A method body's tag keys (``_tag_keys``), plus ``role`` when the body
    calls ``PipelineAmbientTag.AppendTo(ref tags)``.

    ``role`` carries no string literal of its own -- it is appended by a
    runtime provider (``leader``/``follower``, installed only on the
    orchestrator) -- so no literal scan can see it; this recognises the one
    call site that adds it by name instead. Deliberately narrow: only a
    method body that itself makes this exact call gains ``role``, so this
    cannot leak the tag onto an instrument that never carries it the way
    widening to file scope would (see ``_file_dimensions``). It is not
    generalised into ``_tag_keys`` itself for the same reason -- the file-
    scope fallback calls ``_tag_keys`` directly on the whole file text, and
    that path must never see this pattern.
    """
    keys = _tag_keys(body)
    if _AMBIENT_TAG_APPEND.search(body):
        keys.add("role")
    return keys


def _resolve_token(token: str, consts: dict[str, str]) -> str:
    """A ``Create*``/``CreateObservable*`` call's name argument: a string
    literal, or an identifier -- possibly dotted, as in
    ``EgressMeter.DurationInstrument`` -- naming a const declared somewhere
    in the same file. ``const_strings`` scans the whole file regardless of
    which class holds the declaration, so the dotted prefix only needs
    stripping, not resolving."""
    token = token.strip()
    if token.startswith('"'):
        return unescape(token[1:-1])
    return consts.get(token.rsplit(".", 1)[-1], token)


def _label_domains(labels: set[str], consts: dict[str, str]) -> dict[str, list[str]]:
    """A label's value domain, where -- and only where -- the values
    themselves are const-declared in the same file.

    The one pattern found in this codebase is ``RouteQueue = "queue"`` /
    ``RouteFanout = "fanout"``, naming the complete domain of the ``route``
    tag. Detected generically here -- a const whose name starts with the
    label's Title-cased form, has more after that prefix, and whose value is
    not itself a ``pipeline.*`` instrument name (which would just be the
    ``XxxInstrument`` const family colliding on the same prefix, e.g.
    ``QueueWaitInstrument`` for label ``queue``) -- rather than hardcoding
    "route": a label whose values are inline literals or runtime data
    (every other tag here) matches no const and gets no domain, which is the
    honest answer -- an incomplete domain presented as complete is worse
    than none.
    """
    domains: dict[str, list[str]] = {}
    for label in labels:
        prefix = label[:1].upper() + label[1:]
        values = sorted(
            value for name, value in consts.items()
            if name.startswith(prefix) and len(name) > len(prefix)
            and not value.startswith("pipeline."))
        if values:
            domains[label] = values
    return domains


_COMMENT_OR_STRING = re.compile(
    r'@"(?:[^"]|"")*"|\'(?:[^\'\\]|\\.)*\'|"(?:[^"\\]|\\.)*"|//[^\n]*|/\*.*?\*/', re.DOTALL)


def _strip_comments(text: str) -> str:
    """Blank out ``//`` and ``/* */`` comments, leaving string and char literals
    untouched.

    Without this, a comment sitting between two call arguments -- exactly
    the house style in this codebase, e.g. the multi-line rationale between
    ``Observe,`` and ``unit:`` in ``DeadLetterDepthMetrics.cs`` -- breaks a
    regex expecting only whitespace there, and the call is silently not
    matched at all rather than matched wrong. Newlines in a stripped comment
    are kept so line-oriented reasoning elsewhere is unaffected.

    **Verbatim strings and char literals are matched first, and matter even
    though this codebase has none today.** A plain ``"(?:[^"\\]|\\.)*"``
    cannot see ``@"...\"`` -- the trailing backslash in a Windows path is not
    an escape inside a verbatim string, so the regex reads past the real
    closing quote looking for one, and everything up to the NEXT quote
    (commonly the start of the next string literal in the file) is treated
    as being inside that string and left untouched, desynchronising quote
    parity for the rest of the file. A char literal has the same failure
    mode: ``'"'`` flips the string-tracking parity a bare double-quote
    pattern assumes, so a later real ``//`` inside actual code gets matched
    as a comment and blanked -- a confident false negative from the function
    added to prevent confident false negatives. This function runs before
    every structural regex in this module, so an unguarded quote-parity bug
    here has the widest blast radius in the extractor.
    """

    def _replace(m: re.Match) -> str:
        matched = m.group(0)
        # Any string-shaped match -- regular, verbatim (@"..."), or char ('...')
        # -- is left untouched; only the two comment alternatives are blanked.
        is_string = matched.startswith('"') or matched.startswith("@\"") or matched.startswith("'")
        return matched if is_string else "\n" * matched.count("\n")

    return _COMMENT_OR_STRING.sub(_replace, text)


def _file_dimensions(text: str) -> dict[str, dict]:
    """Every instrument declared in one file, mapped to its labels, the
    association rule that found them, and any const-declared value domain.

    **Association rule.** Labels are associated with an instrument by
    *method scope* where derivable: the method whose body contains the
    ``<field>.Add(``/``.Record(`` call, for a pushed counter or histogram;
    the callback method itself, for an observable gauge/counter registered
    with a bare method-group reference. Where the callback is instead a
    lambda that delegates to a third method (``() => Snapshot(...)`` in
    ``QueueDepthMetrics``, built in the static initialiser) no single
    method scope can be named, so this falls back to *file scope*: every
    instrument declared in the file carries the union of every tag key
    found anywhere in it. Which rule fired is recorded on the surface
    rather than blurred.

    **Exactly one call site, or fail loudly.** Picking the first method that
    touches an instrument's field would silently choose one of two ``TagList``
    shapes if a second call site existed, reporting one method's labels as
    if they were the whole truth. Not hypothetical guesswork about a future
    file -- a genuine second call site is exactly the shape ``.Add(``/
    ``.Record(`` on the wrong field would produce, so this raises rather than
    picking.
    """
    text = _strip_comments(text)
    consts = const_strings(text)
    bodies = _method_bodies(text)
    dims: dict[str, dict] = {}

    for field, token in _FIELD_INSTRUMENT.findall(text):
        name = _resolve_token(token, consts)
        matches = [b for b in bodies.values()
                   if f"{field}.Add(" in b or f"{field}.Record(" in b]
        if len(matches) > 1:
            raise CatalogError(
                f"{name}: {len(matches)} method bodies call .Add(/.Record( on "
                f"{field!r} -- cannot resolve labels to a single method scope "
                f"without arbitrarily picking one")
        if matches:
            labels, scope = _method_labels(matches[0]), "method"
        else:
            labels, scope = _tag_keys(text), "file"
        dims[name] = {"labels": sorted(labels), "scope": scope,
                      "domains": _label_domains(labels, consts)}

    for token, callback in _OBSERVABLE_CALL.findall(text):
        name = _resolve_token(token, consts)
        callback = callback.strip()
        if re.fullmatch(r"\w+", callback) and callback in bodies:
            labels, scope = _method_labels(bodies[callback]), "method"
        else:
            labels, scope = _tag_keys(text), "file"
        dims[name] = {"labels": sorted(labels), "scope": scope,
                      "domains": _label_domains(labels, consts)}

    return dims


def _merge_dims(dims: dict[str, dict], file_dims: dict[str, dict]) -> None:
    """Merge one file's ``_file_dimensions`` result into the running map,
    raising on a conflicting redefinition rather than letting the later
    file's labels silently win.

    A plain ``dict.update`` here would let two files declaring the same
    instrument name disagree and still produce a clean map -- and ``names``
    (built separately, as a set union) has no way to notice, so the
    completeness guard could not catch it either. Not idle: this codebase
    already has two same-named ``L2GateMetrics.cs`` files aliasing
    ``GateMetrics``' constants, which is exactly the shape a future real
    collision would take.
    """
    for name, dim in file_dims.items():
        if name in dims and dims[name] != dim:
            raise CatalogError(
                f"{name}: instrument redeclared with conflicting labels in "
                f"another file ({dims[name]} vs {dim}) -- dict.update would "
                f"silently let the later file win")
        dims[name] = dim


def metric_labels(texts: dict[str, str]) -> dict[str, list[str]]:
    """Every ``pipeline.*`` instrument name mapped to its sorted label names.

    One entry per file is merged in; see ``_file_dimensions`` for how an
    instrument's labels are found and which association rule governs.
    """
    dims: dict[str, dict] = {}
    for text in texts.values():
        _merge_dims(dims, _file_dimensions(text))
    return {name: dim["labels"] for name, dim in dims.items()}


def _metric_detail(name: str, dim: dict | None) -> str:
    if dim is None:
        # A call site was never found for this name -- a parse miss, not a
        # determination that the instrument carries no tags. Inventing a
        # scope here (the old behaviour: always "method scope") would claim
        # a precision this branch never earned.
        return f"{name} | no call site found -- labels not determined"
    if not dim["labels"]:
        return f"{name} | no labels ({dim['scope']} scope -- this instrument carries no tags)"
    parts = []
    for label in dim["labels"]:
        domain = dim["domains"].get(label)
        parts.append(f"{label}={{{'|'.join(domain)}}}" if domain else label)
    if dim["scope"] == "file":
        scope_note = ("file scope -- the union of every tag key in this "
                      "instrument's file; it may not carry all of them")
    else:
        scope_note = "method scope"
    return f"{name} | labels: {', '.join(parts)} ({scope_note})"


def metrics(texts: list[str]) -> list[Surface]:
    """Every ``pipeline.*`` instrument, across every declaration shape, its
    ``detail`` now carrying its labels (see ``metric_labels``) alongside its
    name.

    Matching the declaration syntax would mean tracking four Meter.Create* forms
    plus the ``const string ...Instrument`` convention. The value's prefix is
    uniform where the syntax is not, so the name scan is on the value; the
    label scan (``_file_dimensions``) does track the declaration shapes,
    because a label lives on the call site, not in a literal with a
    recognisable prefix.
    """
    names: set[str] = set()
    dims: dict[str, dict] = {}
    for text in texts:
        names.update(literals_matching(text, "pipeline."))
        _merge_dims(dims, _file_dimensions(text))
    return sorted(
        (Surface("prometheus", f"prometheus.{name.replace('.', '_')}",
                 f"instant query on {name}", _metric_detail(name, dims.get(name)))
         for name in names),
        key=lambda s: s.id)


def metric_label_gaps(texts: list[str]) -> list[str]:
    """Every ``pipeline.*`` instrument name found by ``literals_matching`` but
    absent from the merged dimension map -- a parse miss the label scan could
    not resolve to any declaration shape, as opposed to a genuine absence of
    tags (which resolves to an entry with an empty label list, not a missing
    entry).

    Promoted from a unit-test-only assertion
    (``test_no_instrument_is_silently_missing_from_the_dimension_map``) into a
    function ``collect_surfaces`` calls, so a future parse miss fails
    ``skp doctor`` as a named compile problem rather than staying invisible
    outside ``unittest``.
    """
    names: set[str] = set()
    dims: dict[str, dict] = {}
    for text in texts:
        names.update(literals_matching(text, "pipeline."))
        _merge_dims(dims, _file_dimensions(text))
    missing = sorted(names - set(dims))
    return [f"prometheus.{name.replace('.', '_')}: instrument name found but no "
            f"label scan resolved it (parse miss, not a genuine absence of tags)"
            for name in missing]


RESOURCE_LABELS = [
    ("service_name", "service.name",
     "the role name (processor/orchestrator/keeper/webapi) -- ResourceBuilder.AddService(serviceName:), "
     "same call on both signals; the Prometheus exporter also derives exported_job from it"),
    ("service_instance_id", "service.instance.id",
     "the replica identity -- InstanceId.Resolve(), added via ResourceBuilder.AddAttributes on the "
     "metrics resource in AddBaseConsoleObservability/AddBaseApiObservability"),
    ("processorId", "processorId (MetricKey; the log-side LogKey is the differently-cased 'ProcessorId')",
     "set only on a processor host, via ResourceAttribute(\"ProcessorId\", \"processorId\", identity.Id) "
     "passed to AddBaseConsoleObservability -- absent on every other role"),
]
"""Hand-listed, not extracted: these three resource attributes are assembled
by ``ResourceBuilder.AddService``/``.AddAttributes`` calls in
``BaseApi.Core/DependencyInjection/ObservabilityServiceCollectionExtensions.cs``
and ``BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs``
-- neither file matches ``METRICS_GLOB``, and ``service.name`` specifically is
never written as a string literal anywhere in this source at all; it is the
OpenTelemetry semantic convention ``AddService()`` guarantees. Same shape as
``driver.cluster_operations()``: a fact about the shipped system that has no
single regex to read it from, recorded here instead of invented at query
time. See ``ResourceAttribute`` (``BaseConsole.Core/DependencyInjection/
ResourceAttribute.cs``) for the LogKey/MetricKey split behind the third
entry.
"""


def resource_labels() -> list[Surface]:
    """The resource-level attributes every Prometheus series carries --
    not instrument labels, but the model needs them to group correctly.
    Independent of ``source_root``, like ``cluster_operations()``: nothing
    here is read from a glob.
    """
    return sorted(
        (_surface("prometheus", f"label.{name}",
                  f"resource attribute {rendered}", note)
         for name, rendered, note in RESOURCE_LABELS),
        key=lambda s: s.id)


def _route_token(class_name: str) -> str:
    """``WorkflowsController`` -> ``workflows``. The [controller] token convention."""
    return class_name.lower()


def rest_endpoints(controller_texts: dict[str, str]) -> list[Surface]:
    out: list[Surface] = []
    for filename, text in controller_texts.items():
        # Merge-blocking minor: raise on anything other than exactly one
        # controller class in the file. `finditer` looks like the fix for "what
        # if there are two", but `_INHERITS_BASE` is tested per *file*, so both
        # classes would receive the five inherited CRUD verbs and one of them
        # would get five fabricated endpoints -- fabricating a route is worse
        # than dropping one, so this fails loudly instead.
        matches = _CONTROLLER_CLASS.findall(text)
        if len(matches) != 1:
            raise CatalogError(
                f"{filename}: expected exactly one controller class, found "
                f"{len(matches)} ({', '.join(matches) if matches else 'none'})")
        token = _route_token(matches[0])
        base = f"{API_PREFIX}/{token}"
        inherits = bool(_INHERITS_BASE.search(text))

        if inherits:
            for verb, tail in INHERITED_VERBS:
                path = f"{base}/{tail}" if tail else base
                out.append(Surface("api", f"api.{token}.{verb.lower()}{'_id' if tail else ''}",
                                   f"{verb} {path}", token))

        for verb, tail in _HTTP_ATTR.findall(text):
            if not tail:
                # A bare, undecorated attribute is the inherited route on a
                # BaseController<...> subclass and is already covered above.
                # On a controller that does NOT inherit (OrchestrationController
                # is the real one today), the same bare attribute is a real,
                # undocumented route -- I8: it must be a surface, not dropped.
                if inherits:
                    continue
                path = base
                surface_id = f"api.{token}.{verb.lower()}"
            else:
                path = f"{base}/{tail}"
                slug = re.sub(r"[^a-z0-9]+", "_", tail.lower()).strip("_")
                surface_id = f"api.{token}.{verb.lower()}_{slug}"
            out.append(Surface("api", surface_id, f"{verb.upper()} {path}", token))
    return sorted(out, key=lambda s: s.id)


def pg_tables(dbcontext_text: str) -> list[Surface]:
    return sorted(
        (_surface("postgres", name, f'SELECT ... FROM "{name}"', name)
         for name in _DBSET.findall(dbcontext_text)),
        key=lambda s: s.id)
