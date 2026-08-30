import re

_CONST = re.compile(
    r"(?:public|internal|private)\s+const\s+string\s+(\w+)\s*=\s*(.*?);",
    re.DOTALL)
_EXPR = re.compile(
    r"public\s+static\s+string\s+(\w+)\s*\([^)]*\)\s*=>\s*(.*?);",
    re.DOTALL)
_LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')
_SPECIFIER = re.compile(r"\{(\w+):[^}]*\}")
_BARE_IDENTIFIER = re.compile(r"^\w+$")


def unescape(raw: str) -> str:
    """Decode the escapes C# source uses, without touching anything else.

    ``codecs.decode(..., 'unicode_escape')`` would corrupt any non-ASCII byte
    already present, so the substitutions are explicit and ordered.
    """
    out = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), raw)
    return out.replace('\\"', '"').replace("\\\\", "\\")


def _joined_literals(rhs: str) -> str:
    """Every string literal in a right-hand side, concatenated in source order.

    This is what handles ``"a " + "b"`` spanning lines without needing to parse
    the ``+`` operator at all.
    """
    return "".join(unescape(m.group(1)) for m in _LITERAL.finditer(rhs))


def const_strings(text: str) -> dict[str, str]:
    return {name: _joined_literals(rhs) for name, rhs in _CONST.findall(text)}


def expression_bodies(text: str, consts: dict[str, str] | None = None) -> dict[str, str]:
    """Interpolated expression-bodied string methods, placeholders preserved.

    ``{workflowId:D}`` becomes ``{workflowId}``: the specifier is a rendering
    detail, and the key family is what the catalog records.

    A body with no string literal is usually not a key format, but a bare
    identifier referring to a const declared in the same file (``=> Prefix;``)
    is: when ``consts`` is given and the stripped body names one of its keys,
    that const's value is used as the body.
    """
    found: dict[str, str] = {}
    for name, rhs in _EXPR.findall(text):
        literal = _LITERAL.search(rhs)
        if not literal:
            identifier = rhs.strip()
            if consts is not None and _BARE_IDENTIFIER.match(identifier) and identifier in consts:
                found[name] = consts[identifier]
            continue  # a body returning a bare identifier is not a key format
        found[name] = _SPECIFIER.sub(r"{\1}", unescape(literal.group(1)))
    return found


def literals_matching(text: str, prefix: str) -> list[str]:
    """Every distinct string literal starting with ``prefix``, sorted.

    Used for instrument names, where the declaration shapes vary too much to be
    worth matching but the value's prefix is uniform.
    """
    seen = {m.group(1) for m in _LITERAL.finditer(text)
            if m.group(1).startswith(prefix)}
    return sorted(seen)
