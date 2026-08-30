import re

from skp.compile.catalog import CatalogError

_RHS = r'((?:"(?:[^"\\]|\\.)*"|[^;"])*)'

_CONST = re.compile(
    r'(?:public|internal|private)\s+const\s+string\s+(\w+)\s*=\s*' + _RHS + r';')
_EXPR = re.compile(
    r'public\s+static\s+string\s+(\w+)\s*\([^)]*\)\s*=>\s*' + _RHS + r';')
_LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')
_SPECIFIER = re.compile(r"\{(\w+):[^}]*\}")
_BARE_IDENTIFIER = re.compile(r"^\w+$")
_ESCAPE = re.compile(r"\\(u[0-9a-fA-F]{4}|.)", re.DOTALL)
_SIMPLE = {"n": "\n", "t": "\t", "r": "\r", "0": "\0",
           "a": "\a", "b": "\b", "f": "\f", "v": "\v"}


def unescape(raw: str) -> str:
    """Decode the escapes C# source uses, in one left-to-right pass.

    A single scan rather than ordered global substitutions: each escape consumes
    its own backslash, so `\\\\u1234` is a literal backslash followed by the text
    `u1234`, not a unicode escape. No substitution order can express that.
    """

    def _replace(match: re.Match) -> str:
        token = match.group(1)
        if len(token) == 5 and token[0] == "u":
            return chr(int(token[1:], 16))
        return _SIMPLE.get(token, token)

    return _ESCAPE.sub(_replace, raw)


def _joined_literals(rhs: str) -> str:
    """Every string literal in a right-hand side, concatenated in source order.

    This is what handles ``"a " + "b"`` spanning lines without needing to parse
    the ``+`` operator at all.
    """
    return "".join(unescape(m.group(1)) for m in _LITERAL.finditer(rhs))


def _check_no_duplicate_names(names, kind: str) -> None:
    """Two members with the same name in one file -- nested classes are the
    realistic cause -- used to collide in the dict comprehension these
    functions build, last one silently winning. That is corruption, not an
    incomplete state, so it raises the same way `load_annotations` does for
    a duplicated annotation id."""
    seen: set[str] = set()
    for name in names:
        if name in seen:
            raise CatalogError(
                f"duplicate {kind} member name {name!r} declared twice in one file "
                f"(nested classes?) -- rename one; the second declaration was "
                f"silently overwriting the first")
        seen.add(name)


def const_strings(text: str) -> dict[str, str]:
    pairs = _CONST.findall(text)
    _check_no_duplicate_names((name for name, _ in pairs), "const string")
    return {name: _joined_literals(rhs) for name, rhs in pairs}


def expression_bodies(text: str, consts: dict[str, str] | None = None) -> dict[str, str]:
    """Interpolated expression-bodied string methods, placeholders preserved.

    ``{workflowId:D}`` becomes ``{workflowId}``: the specifier is a rendering
    detail, and the key family is what the catalog records.

    A body with no string literal is usually not a key format, but a bare
    identifier referring to a const declared in the same file (``=> Prefix;``)
    is: when ``consts`` is given and the stripped body names one of its keys,
    that const's value is used as the body.

    Every literal in the body is joined (``_joined_literals``), not just the
    first: a body built from two concatenated literals (``$"a" + "b"``, or a
    multi-line interpolation) used to lose everything past the first ``"``.
    """
    pairs = _EXPR.findall(text)
    _check_no_duplicate_names((name for name, _ in pairs), "expression-bodied string")
    found: dict[str, str] = {}
    for name, rhs in pairs:
        joined = _joined_literals(rhs)
        if not joined:
            identifier = rhs.strip()
            if consts is not None and _BARE_IDENTIFIER.match(identifier) and identifier in consts:
                found[name] = consts[identifier]
            continue  # a body returning a bare identifier is not a key format
        found[name] = _SPECIFIER.sub(r"{\1}", joined)
    return found


_SNAKE_ACRONYM_BOUNDARY = re.compile(r"(.)([A-Z][a-z]+)")
_SNAKE_LOWER_UPPER_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")


def pascal_to_snake(name: str) -> str:
    """The transform ``EFCore.NamingConventions``' ``UseSnakeCaseNamingConvention``
    applies to a CLR member name when it derives a Postgres identifier:
    ``StepNextSteps`` -> ``step_next_steps``, ``SourceHash`` -> ``source_hash``.

    Two passes, the same shape widely used for this conversion: the first
    inserts a boundary before a capital that starts a new lowercase run (so
    a run of capitals -- an acronym -- is not split letter by letter), the
    second catches a capital immediately following a lowercase letter or
    digit that the first pass's lookahead-free pattern cannot see on its
    own (adjacent capitals, e.g. ``ID``, still collapse to one boundary).
    Exists so C1's fix is a named, independently testable function rather
    than an inline string transform buried in ``pg_tables``.
    """
    step1 = _SNAKE_ACRONYM_BOUNDARY.sub(r"\1_\2", name)
    step2 = _SNAKE_LOWER_UPPER_BOUNDARY.sub(r"\1_\2", step1)
    return step2.lower()


def literals_matching(text: str, prefix: str) -> list[str]:
    """Every distinct string literal starting with ``prefix``, sorted.

    Used for instrument names, where the declaration shapes vary too much to be
    worth matching but the value's prefix is uniform.
    """
    seen = {m.group(1) for m in _LITERAL.finditer(text)
            if m.group(1).startswith(prefix)}
    return sorted(seen)
