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


def _manifest_files(root: pathlib.Path, pattern: str) -> list[str]:
    return sorted(
        _relative(p, root) for p in root.glob(pattern)
        if "obj" not in p.parts and "bin" not in p.parts)


def manifest_hash(root: pathlib.Path, pattern: str) -> str:
    """A hash of the *set* of files a glob currently matches under ``root``,
    not their contents. ``stale_sources`` only ever walks paths the lock
    already knows about, so a newly *added* controller or ``*Metrics.cs``
    file -- one the lock has never seen -- was otherwise undetectable: the
    catalog lacks its surfaces and doctor reports "in step with source".
    Recording this hash lets a changed file set register as drift too."""
    return hashlib.sha256(
        "\n".join(_manifest_files(root, pattern)).encode("utf-8")).hexdigest()


def build_lock(sources, generated, root: pathlib.Path) -> dict:
    return {
        "sources": {_relative(p, root): hash_file(p) for p in sources},
        "generated": {_relative(p, root): hash_file(p) for p in generated},
    }


def build_lock_two_roots(sources, source_root: pathlib.Path,
                         generated, generated_root: pathlib.Path,
                         manifest_globs: list[str] | None = None) -> dict:
    """Sources and generated files live under different roots, so each is
    recorded relative to its own. One shared root would force absolute paths,
    which do not survive the bundle being moved.

    ``manifest_globs`` are glob patterns (relative to ``source_root``) whose
    *matched file set* -- not any one file's contents -- should be tracked,
    so a newly added file matching the pattern shows up as drift. Keyed by
    the pattern string itself, so ``stale_sources`` needs no separate
    knowledge of what the patterns were.
    """
    lock = {
        "sources": {_relative(p, source_root): hash_file(p) for p in sources},
        "generated": {_relative(p, generated_root): hash_file(p) for p in generated},
    }
    if manifest_globs:
        lock["manifests"] = {
            pattern: manifest_hash(source_root, pattern) for pattern in manifest_globs}
    return lock


def _changed(section: dict, root: pathlib.Path) -> list[str]:
    return sorted(rel for rel, digest in section.items()
                  if hash_file(root / rel) != digest)


def stale_sources(lock: dict, root: pathlib.Path) -> list[str]:
    """The C# moved and nobody recompiled. Fix: skp init --refresh.

    A source recorded as ``MISSING`` in the lock is drift by definition: the
    path was tracked (SOURCE_MAP paths are kept even when absent -- see
    ``_source_paths``) and is not there now. Comparing it against a *current*
    hash that is also ``MISSING`` -- the normal state after a rename -- would
    make ``_changed`` see them as equal and hide the drift, so a stored
    ``MISSING`` is reported unconditionally rather than routed through that
    comparison."""
    stale = sorted(rel for rel, digest in lock.get("sources", {}).items()
                    if digest == MISSING or hash_file(root / rel) != digest)
    for pattern, digest in lock.get("manifests", {}).items():
        if manifest_hash(root, pattern) != digest:
            stale.append(f"file set changed for {pattern}")
    return sorted(stale)


def edited_generated(lock: dict, root: pathlib.Path) -> list[str]:
    """Someone edited a generated file. Fix: edit its input instead.

    Reported rather than reverted -- silently overwriting the edit is the failure
    this check exists to prevent.
    """
    return _changed(lock.get("generated", {}), root)
