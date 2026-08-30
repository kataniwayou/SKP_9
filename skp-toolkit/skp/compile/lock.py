import hashlib
import pathlib

MISSING = "<missing>"


def hash_file(path: pathlib.Path) -> str:
    """Newline-normalised, so a checkout on Windows and one on Linux agree.

    The same reason SourceHash.targets normalises: a hash that disagrees across
    platforms turns a correct bundle into a permanent drift warning.
    """
    if not path.exists():
        return MISSING
    raw = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(raw).hexdigest()


def _relative(path: pathlib.Path, root: pathlib.Path) -> str:
    return path.relative_to(root).as_posix()


def build_lock(sources, generated, root: pathlib.Path) -> dict:
    return {
        "sources": {_relative(p, root): hash_file(p) for p in sources},
        "generated": {_relative(p, root): hash_file(p) for p in generated},
    }


def _changed(section: dict, root: pathlib.Path) -> list[str]:
    return sorted(rel for rel, digest in section.items()
                  if hash_file(root / rel) != digest)


def stale_sources(lock: dict, root: pathlib.Path) -> list[str]:
    """The C# moved and nobody recompiled. Fix: skp init --refresh."""
    return _changed(lock.get("sources", {}), root)


def edited_generated(lock: dict, root: pathlib.Path) -> list[str]:
    """Someone edited a generated file. Fix: edit its input instead.

    Reported rather than reverted -- silently overwriting the edit is the failure
    this check exists to prevent.
    """
    return _changed(lock.get("generated", {}), root)
