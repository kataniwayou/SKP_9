"""Read entity display names from L2 (skp:name:{id}) without a redis client library.

The single store of names since 2026-09-29: BaseApi writes one key per workflow, step and
processor on every start. Used by the Kibana verify script and the offline pin script, so neither
depends on an Elasticsearch index or on a package the offline machine may not have.
"""
import re
import socket

_SUFFIX = re.compile(r"-[0-9a-f]{4}-[0-9a-f]{12}$")
_FALLBACK = re.compile(r"^[0-9a-f]{4}-[0-9a-f]{12}$")
PREFIX = "skp:name:"


def base_name(name):
    """name_version-xxxx-xxxxxxxxxxxx -> name_version. A fallback has no base and is returned as is."""
    return name if _FALLBACK.match(name) else _SUFFIX.sub("", name)


def is_fallback(name):
    """True for an unresolved record: the id suffix alone, no underscore, no version."""
    return bool(_FALLBACK.match(name))


def _command(sock, *parts):
    out = f"*{len(parts)}\r\n".encode()
    for p in parts:
        b = p.encode()
        out += b"$" + str(len(b)).encode() + b"\r\n" + b + b"\r\n"
    sock.sendall(out)


def _reply(f):
    line = f.readline().rstrip(b"\r\n")
    kind, rest = line[:1], line[1:]
    if kind == b"$":
        n = int(rest)
        if n < 0:
            return None
        data = f.read(n + 2)
        if len(data) < n + 2:
            # The connection dropped mid-bulk-string: fewer bytes than the length the server itself
            # declared, including the trailing \r\n. Silently returning a truncated value would read
            # as a real (wrong) name; raising makes the failure visible instead.
            raise RuntimeError(f"short read: expected {n + 2} bytes, got {len(data)}")
        return data[:-2].decode("utf-8")
    if kind == b"*":
        n = int(rest)
        return None if n < 0 else [_reply(f) for _ in range(n)]
    if kind in (b"+", b":"):
        return rest.decode()
    if kind == b"-":
        raise RuntimeError(rest.decode())
    raise RuntimeError(f"unexpected RESP reply {line!r}")


def read_names_from(sock):
    f = sock.makefile("rb")
    keys, cursor = [], "0"
    while True:
        _command(sock, "SCAN", cursor, "MATCH", PREFIX + "*", "COUNT", "1000")
        cursor, batch = _reply(f)
        keys += batch
        if cursor == "0":
            break
    names = {}
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        _command(sock, "MGET", *chunk)
        for key, value in zip(chunk, _reply(f)):
            if value is not None:
                names[key[len(PREFIX):]] = value
    return names


def read_names(host="localhost", port=6380, timeout=10):
    """{id: full name} for every skp:name:* key. The default port is the supervised dev forward."""
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        return read_names_from(sock)
    finally:
        sock.close()


def read_name_from(sock, entity_id):
    """A single skp:name:{entity_id} value, or None when the key is absent (RESP nil)."""
    f = sock.makefile("rb")
    _command(sock, "GET", PREFIX + entity_id)
    return _reply(f)


def read_name(host="localhost", port=6380, entity_id=None, timeout=10):
    """The one name at skp:name:{entity_id}, or None if it is unset. A single RESP GET, not a scan -
    used once the caller already knows the id (e.g. resolved from BaseApi's own registry) and wants
    the exact key rather than a name matched out of a set that may hold several stale entries."""
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        return read_name_from(sock, entity_id)
    finally:
        sock.close()
