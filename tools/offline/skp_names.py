"""Read entity display names from L2 (HASH skp:{wf|step|proc}:{id}, field "name") without a redis
client library.

BaseApi writes workflow and step names on every start; each processor instance writes its own. Used
by the Kibana verify script and the offline pin script, so neither depends on an Elasticsearch index
or on a package the offline machine may not have.
"""
import re
import socket

_SUFFIX = re.compile(r"-[0-9a-f]{4}-[0-9a-f]{12}$")
_FALLBACK = re.compile(r"^[0-9a-f]{4}-[0-9a-f]{12}$")
KINDS = ("wf", "step", "proc")
_ENTITY_KEY = re.compile(r"^skp:(wf|step|proc):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")


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
    keys = []
    for kind in KINDS:
        cursor = "0"
        while True:
            _command(sock, "SCAN", cursor, "MATCH", f"skp:{kind}:*", "COUNT", "1000")
            cursor, batch = _reply(f)
            keys += [k for k in batch if _ENTITY_KEY.match(k)]
            if cursor == "0":
                break
    names = {}
    for key in keys:
        _command(sock, "HGET", key, "name")
        value = _reply(f)
        if value is not None:
            names[_ENTITY_KEY.match(key).group(2)] = value
    return names


def read_names(host="localhost", port=6380, timeout=10):
    """{id: full name} for every workflow, step and processor hash. The default port is the
    supervised dev forward."""
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        return read_names_from(sock)
    finally:
        sock.close()


def read_name_from(sock, entity_id, kind="wf"):
    """The name field of skp:{kind}:{entity_id}, or None when the key or field is absent (RESP nil)."""
    f = sock.makefile("rb")
    _command(sock, "HGET", f"skp:{kind}:{entity_id}", "name")
    return _reply(f)


def read_name(host="localhost", port=6380, entity_id=None, kind="wf", timeout=10):
    """The one name at skp:{kind}:{entity_id}, or None if it is unset. A single HGET, not a scan -
    used once the caller already knows the id (e.g. resolved from BaseApi's own registry) and wants
    the exact key rather than a name matched out of a set that may hold several stale entries."""
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        return read_name_from(sock, entity_id, kind)
    finally:
        sock.close()
