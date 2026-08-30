import json
import pathlib

from skp.compile import extract
from skp.compile.catalog import Entry, build, check, load_annotations
from skp.compile.lock import build_lock_two_roots

SOURCE_MAP = {
    "l2_keys": "Messaging.Contracts/Projections/L2ProjectionKeys.cs",
    "processor_queues": "Messaging.Contracts/ProcessorQueues.cs",
    "orchestrator_queues": "Messaging.Contracts/OrchestratorQueues.cs",
    "templates": "tests/BaseApi.Tests/Live/Resilience/Templates.cs",
    "dbcontext": "BaseApi.Service/AppDbContext.cs",
}

CONTROLLER_GLOB = "BaseApi.Service/Features/**/*Controller.cs"
METRICS_GLOB = "**/*Metrics.cs"


def _read(root: pathlib.Path, rel: str) -> str:
    path = root / rel
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _source_paths(source_root: pathlib.Path) -> list[pathlib.Path]:
    """Every source path the lock should track.

    The ``SOURCE_MAP`` fixed paths are kept even when missing -- ``hash_file``
    records them as ``MISSING`` rather than dropping them, so a rename shows
    up as drift instead of quietly disappearing from the lock (see C2). Only
    the glob-derived paths are filtered by existence, since a glob can only
    ever return paths that exist.
    """
    paths = [source_root / rel for rel in SOURCE_MAP.values()]
    paths += sorted(source_root.glob(CONTROLLER_GLOB))
    paths += [p for p in sorted(source_root.glob(METRICS_GLOB))
              if "obj" not in p.parts and "bin" not in p.parts]
    return paths


def _missing_fixed_path_problems(source_root: pathlib.Path) -> list[str]:
    """SOURCE_MAP paths are mandatory: a missing one is a named compile
    problem, not an empty string quietly fed to an extractor."""
    return [f"SOURCE_MAP path missing: {rel} (component data extracted from it is lost)"
            for rel in SOURCE_MAP.values() if not (source_root / rel).exists()]


def collect_surfaces(source_root: pathlib.Path) -> list[extract.Surface]:
    surfaces: list[extract.Surface] = []
    surfaces += extract.redis_keys(_read(source_root, SOURCE_MAP["l2_keys"]))
    surfaces += extract.queues(_read(source_root, SOURCE_MAP["processor_queues"]),
                               _read(source_root, SOURCE_MAP["orchestrator_queues"]))
    surfaces += extract.templates(_read(source_root, SOURCE_MAP["templates"]))
    surfaces += extract.pg_tables(_read(source_root, SOURCE_MAP["dbcontext"]))
    surfaces += extract.metrics([
        p.read_text(encoding="utf-8") for p in sorted(source_root.glob(METRICS_GLOB))
        if "obj" not in p.parts and "bin" not in p.parts])
    surfaces += extract.rest_endpoints({
        p.name: p.read_text(encoding="utf-8")
        for p in sorted(source_root.glob(CONTROLLER_GLOB))})
    return sorted(surfaces, key=lambda s: s.id)


def compile_catalog(source_root: pathlib.Path, annotations_dir: pathlib.Path,
                    out_dir: pathlib.Path) -> tuple[list[Entry], list[str]]:
    """Write the catalog and the lock, and return every problem found.

    The catalog is written even when checks fail: a partial catalog plus a named
    list of gaps is more useful than nothing plus an exception, and `skp doctor`
    is the thing that refuses to call it healthy.
    """
    surfaces = collect_surfaces(source_root)
    annotations = load_annotations(annotations_dir)
    entries = build(surfaces, annotations)
    problems = check(entries, surfaces, annotations) + _missing_fixed_path_problems(source_root)

    out_dir.mkdir(parents=True, exist_ok=True)
    catalog_path = out_dir / "catalog.json"
    catalog_path.write_text(
        json.dumps([e.to_dict() for e in entries], indent=2, sort_keys=True),
        encoding="utf-8")

    lock = build_lock_two_roots(_source_paths(source_root), source_root,
                                [catalog_path], out_dir,
                                manifest_globs=[CONTROLLER_GLOB, METRICS_GLOB])
    (out_dir / "compile.lock").write_text(
        json.dumps(lock, indent=2, sort_keys=True), encoding="utf-8")
    return entries, problems
