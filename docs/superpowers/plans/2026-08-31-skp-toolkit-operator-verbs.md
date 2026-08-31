# SKP toolkit Phase 3: the operator verbs `author` and `operate`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 3 by adding `skp author` and `skp operate`, so the five
orchestration gates and the seven run verdicts are reachable as commands instead
of as knowledge a model has to hold.

**Architecture:** Both verbs are **lookup, never reimplementation**. `author`
validates by calling the system's own `POST /orchestration/start`, whose five
gates all run before any side effect and whose 422 already carries
`{gate, offending}`. `operate` resolves seven verdicts by reading catalogued,
already-verified surfaces — Elasticsearch templates, Redis keys, queue depths,
Postgres columns. No gate logic and no run-state logic is copied out of the C#.

**Tech Stack:** Python 3.11, standard library only. `unittest`. No new
dependencies — the toolkit ships to an offline machine.

**Spec:** `docs/superpowers/specs/2026-08-30-skp-skill-bundle-design.md`

## Global Constraints

- **Standard library only.** No third-party imports anywhere in `skp-toolkit/`.
- **Never reimplement the system.** §2: a hand-written copy "is recall with extra
  steps, and fails the same silent way when the C# moves." If the system exposes
  an endpoint, call it. If it exposes a peripheral, read it. Copy no logic.
- **No changes to `src/`.** §14: "This work reads the source; it does not modify it."
- **Every command is tagged with its intents** — `author` → `design`, `verify`;
  `operate` → `control`, `verify`. Untagged surfaces fail the coverage check.
- **Every result prints `NEXT:`**, and every failure names a reference file via
  `Result.reference` (renders as `SEE:`). §4.2.
- **Writes are gated.** §8: "explicitly flagged, human-confirmed at the moment of
  use, and recorded." Opt-in flags follow the existing `--probe-writes` pattern.
- **A 202 is not proof.** The catalog's own `never_for` on
  `api.orchestration.post_start` reads "202 means accepted, not applied." Every
  control command ends in a read-back.
- **Exit codes** come from `skp/result.py` and are already fixed:
  `EXIT_OK=0`, `EXIT_USAGE=1`, `EXIT_NOT_INITIALISED=2`, `EXIT_VERDICT=3`,
  `EXIT_UNREACHABLE=4`, `EXIT_DRIFT=5`.
- **Run the suite** with `python -m unittest discover -s tests -t .` from
  `skp-toolkit/`. It is 396 tests before this plan starts.

## The seven verdicts (fixed; do not add, merge or rename)

The rule is **one verdict per distinct remedy**. Two states that send the
operator to do the same thing are one verdict; two that send them somewhere
different must never be merged. This mirrors the `skp verify` ruling that
collapsing NOT_OBSERVED, REFUTED and UNVERIFIABLE makes a verb cry wolf.

| Verdict | Remedy | Read from |
| --- | --- | --- |
| `completed` | nothing | ES `the terminal step completed with {Result} …` |
| `running` | wait | ES `running the step` inside the window |
| `failed-at-step-X` | fix the data or the author's transform | the completion templates, on `{Result}` |
| `parked-at-step-X` | recover the message by hand | `processor-{id}.dead` depth > 0 |
| `wedged-at-step-X` | fix or deploy the processor | `processor-{id}` depth > 0 with 0 consumers |
| `frozen` | nothing is wrong — an entry step is `Never` | Postgres `steps.entry_condition = 5` |
| `never-started` | the start was rejected, or never issued | no dispatch record in the window |

## File structure

| File | Responsibility |
| --- | --- |
| `skp/state.py` (new) | The `state/` ledger: record what a verb acted on, recall it for the next verb. §5. |
| `skp/compile/extract.py` (modify) | `gates(text)` — pull the gate discriminators out of the C#. |
| `skp/compile/driver.py` (modify) | Write `model/gates.json` beside the catalog. |
| `skp/references/gate-*.md` (new, 5) | One remedy file per gate, named by a failure's `SEE:` line. |
| `skp/verbs/doctor.py` (modify) | New row: every extracted gate has a reference file. |
| `skp/verbs/author.py` (new) | `validate` (call the real gates) and `apply` (real endpoints, FK order). |
| `skp/verbs/operate.py` (new) | `start`, `stop`, `freeze`, `verify`. |
| `skp/cli.py` (modify) | Register the two groups. |

**Task order note.** `skp/state.py` is built in Task 2 because Task 3 is its
first consumer, even though `operate` (Task 6) uses it most.

---

### Task 1: Extract the five gates into `model/gates.json`

The gate names must come from the C#, never from a list typed into Python. A
sixth gate added upstream has to appear here on the next `skp init --refresh`, so
that Task 2's coverage check can fail on it.

**Files:**
- Modify: `skp-toolkit/skp/compile/extract.py`
- Modify: `skp-toolkit/skp/compile/driver.py`
- Test: `skp-toolkit/tests/test_extract_gates.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `extract.gates(text: str) -> list[str]` — discriminators in source
  order. `driver.compile_catalog(source_root, annotations_dir, out_dir)`
  additionally writes `<out_dir>/gates.json` containing that list.

- [ ] **Step 1: Write the failing test**

Create `skp-toolkit/tests/test_extract_gates.py`:

```python
import json
import pathlib
import tempfile
import unittest

from skp.compile import extract
from skp.compile.driver import compile_catalog

SRC = pathlib.Path(__file__).resolve().parents[2] / "src"
ANNOTATIONS = pathlib.Path(__file__).resolve().parents[1] / "skp" / "annotations"
GATE_FILE = ("BaseApi.Service/Features/Orchestration/"
             "OrchestrationValidationException.cs")


class GateExtractionTests(unittest.TestCase):
    def test_the_factories_are_found_in_declaration_order(self):
        text = """
        public static OrchestrationValidationException Cycle(x y)
            => new(
                "cycle",
                "Workflow contains a cycle",
                $"detail", new CycleOffending(y));

        public static OrchestrationValidationException MissingStep(x y)
            => new(
                "missingStep",
                "Workflow references a missing step",
                $"detail", new MissingStepOffending(y));
        """
        self.assertEqual(extract.gates(text), ["cycle", "missingStep"])

    def test_a_title_is_not_mistaken_for_a_discriminator(self):
        """Only the FIRST argument of a `=> new(` factory counts. Titles and
        details are quoted strings too, and a looser match would catalogue
        prose as a gate -- doctor would then demand a reference file for
        'Workflow contains a cycle'."""
        text = '''
        public static OrchestrationValidationException Cycle(x)
            => new(
                "cycle",
                "Workflow contains a cycle",
                $"A cycle was detected", new CycleOffending(x));
        '''
        self.assertEqual(extract.gates(text), ["cycle"])

    def test_a_commented_out_factory_is_not_a_gate(self):
        text = '''
        // => new("ghost", "Ghost", $"d", new X());
        public static OrchestrationValidationException Cycle(x)
            => new("cycle", "Workflow contains a cycle", $"d", new X());
        '''
        self.assertEqual(extract.gates(text), ["cycle"])


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class RealGateSourceTests(unittest.TestCase):
    def test_the_live_source_yields_exactly_the_five_documented_gates(self):
        text = (SRC / GATE_FILE).read_text(encoding="utf-8")
        self.assertEqual(
            extract.gates(text),
            ["cycle", "missingStep", "schemaEdge",
             "payloadConfigSchema", "processorLiveness"])

    def test_compile_writes_gates_json_beside_the_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            compile_catalog(SRC, ANNOTATIONS, out)
            written = json.loads((out / "gates.json").read_text(encoding="utf-8"))
        self.assertEqual(written[0], "cycle")
        self.assertEqual(len(written), 5)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_extract_gates -v`

Expected: FAIL — `AttributeError: module 'skp.compile.extract' has no attribute 'gates'`

- [ ] **Step 3: Implement `extract.gates`**

Append to `skp-toolkit/skp/compile/extract.py` (`re` and `_strip_comments` are
already imported/defined in that module):

```python
_GATE_FACTORY = re.compile(r'=>\s*new\(\s*"([A-Za-z][A-Za-z0-9]*)"')


def gates(text: str) -> list[str]:
    """The orchestration gate discriminators, in declaration order.

    Anchored on the ``=> new(`` expression-bodied factories in
    ``OrchestrationValidationException``, so only the FIRST argument of a
    factory is taken -- the title and detail beside it are quoted strings too.

    Deliberately structural rather than a literal list. A sixth gate added to
    the C# appears here on the next refresh and ``skp doctor`` fails until
    somebody writes its remedy file. A typed-in list would silently
    under-report, which is the exact failure this toolkit exists to remove.
    """
    return _GATE_FACTORY.findall(_strip_comments(text))
```

- [ ] **Step 4: Run test to verify the unit cases pass**

Run: `cd skp-toolkit && python -m unittest tests.test_extract_gates.GateExtractionTests -v`

Expected: PASS (3 tests)

- [ ] **Step 5: Write `gates.json` from the driver**

In `skp-toolkit/skp/compile/driver.py`, add the constant beside the other fixed
source paths:

```python
GATE_SOURCE = ("BaseApi.Service/Features/Orchestration/"
               "OrchestrationValidationException.cs")
```

Add `GATE_SOURCE` to the list `_missing_fixed_path_problems` walks, so a moved
file is reported loudly instead of yielding an empty gate list. Then, inside
`compile_catalog`, beside the existing `catalog_path.write_text(...)`:

```python
    (out_dir / "gates.json").write_text(
        json.dumps(extract.gates(_read(source_root, GATE_SOURCE)), indent=2),
        encoding="utf-8")
```

- [ ] **Step 6: Run the full suite**

Run: `cd skp-toolkit && python -m unittest discover -s tests -t .`

Expected: OK, 401 tests

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/skp/compile/extract.py skp-toolkit/skp/compile/driver.py skp-toolkit/tests/test_extract_gates.py
git commit -m "feat(skp-toolkit): catalogue the five orchestration gates from the C#"
```

---

### Task 2: Gate reference files, the state ledger, and a doctor coverage check

§4.2 requires a failure to name the file that explains it. §12 already lists
"reference files named by errors but missing" among `doctor`'s duties. This is
the drift guard that survives now that no gate logic is copied: not "did we
mirror the rule correctly" but "can every gate the system can emit be explained."

`skp/state.py` is folded in here because it is nine lines of logic and Task 3
needs it.

**Files:**
- Create: `skp-toolkit/skp/references/__init__.py`
- Create: `skp-toolkit/skp/references/gate-cycle.md`, `gate-missing-step.md`,
  `gate-schema-edge.md`, `gate-payload-config-schema.md`,
  `gate-processor-liveness.md`
- Create: `skp-toolkit/skp/state.py`
- Modify: `skp-toolkit/skp/verbs/doctor.py`
- Test: `skp-toolkit/tests/test_references.py` (create),
  `skp-toolkit/tests/test_state.py` (create)

**Interfaces:**
- Consumes: `model/gates.json` from Task 1.
- Produces:
  - `references.slug_for(gate: str) -> str`, `references.path_for(gate: str) -> pathlib.Path`,
    `references.reference_for(gate: str) -> str` (the `SEE:` string, e.g.
    `references/gate-schema-edge.md`).
  - `state.record(home: pathlib.Path, key: str, value: str) -> None` and
    `state.recall(home: pathlib.Path, key: str) -> str | None`, keys restricted
    to `{"workflow"}`.
  - `doctor.gate_reference_rows(gate_names: list[str]) -> list[tuple[str, bool, str]]`.

- [ ] **Step 1: Write the failing tests**

Create `skp-toolkit/tests/test_references.py`:

```python
import unittest

from skp import references
from skp.verbs import doctor

FIVE = ["cycle", "missingStep", "schemaEdge",
        "payloadConfigSchema", "processorLiveness"]


class ReferenceTests(unittest.TestCase):
    def test_every_shipped_gate_has_a_reference_file(self):
        for gate in FIVE:
            self.assertTrue(references.path_for(gate).exists(),
                            f"no reference file for gate {gate}")

    def test_camel_case_becomes_a_kebab_slug(self):
        self.assertEqual(references.slug_for("schemaEdge"), "gate-schema-edge")

    def test_an_unknown_gate_gets_a_slug_rather_than_an_exception(self):
        """doctor must survive a gate the toolkit has never seen -- that is
        exactly the case the coverage check exists to report."""
        self.assertEqual(references.slug_for("brandNewGate"), "gate-brand-new-gate")
        self.assertFalse(references.path_for("brandNewGate").exists())

    def test_the_see_string_is_repo_relative(self):
        self.assertEqual(references.reference_for("cycle"),
                         "references/gate-cycle.md")


class GateReferenceRowTests(unittest.TestCase):
    def test_full_coverage_is_a_passing_row(self):
        rows = doctor.gate_reference_rows(FIVE)
        self.assertEqual(rows[0][0], "gate references")
        self.assertTrue(rows[0][1])

    def test_a_gate_with_no_file_fails_and_is_named(self):
        name, ok, detail = doctor.gate_reference_rows(["cycle", "brandNewGate"])[0]
        self.assertFalse(ok)
        self.assertIn("brandNewGate", detail)

    def test_no_gates_at_all_fails_rather_than_passing_vacuously(self):
        """An empty list must not read as 'all covered'. A check that passes
        when it had nothing to check is the signature defect of this build."""
        name, ok, detail = doctor.gate_reference_rows([])[0]
        self.assertFalse(ok)
        self.assertIn("gates.json", detail)


if __name__ == "__main__":
    unittest.main()
```

Create `skp-toolkit/tests/test_state.py`:

```python
import pathlib
import tempfile
import unittest

from skp import state


class StateTests(unittest.TestCase):
    def test_a_recorded_value_comes_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            state.record(home, "workflow", "abc")
            self.assertEqual(state.recall(home, "workflow"), "abc")

    def test_recall_of_something_never_recorded_is_none_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(state.recall(pathlib.Path(tmp), "workflow"))

    def test_an_unknown_key_raises_rather_than_writing_dead_state(self):
        """A typo'd key that silently wrote would produce state nothing ever
        reads, and the model would be told 'no previous workflow' forever."""
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                state.record(pathlib.Path(tmp), "wrokflow", "abc")

    def test_corrupt_state_recalls_as_none_rather_than_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            (home / "state").mkdir()
            (home / "state" / "workflow.json").write_text("{not json",
                                                          encoding="utf-8")
            self.assertIsNone(state.recall(home, "workflow"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd skp-toolkit && python -m unittest tests.test_references tests.test_state -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'skp.references'`

- [ ] **Step 3: Implement `skp/references/__init__.py`**

```python
"""The remedy files a failure names in its ``SEE:`` line.

Spec §4.2: "Every failure prints the reference file that explains it. The
*tool* decides when context is needed, which it can do correctly and the
model cannot." Keeping these out of the verb bodies is what lets a Phase 5
leaf stay under its 1200-token budget while still covering every failure it
can reach.
"""
import pathlib

DIR = pathlib.Path(__file__).resolve().parent

_SLUGS = {
    "cycle": "gate-cycle",
    "missingStep": "gate-missing-step",
    "schemaEdge": "gate-schema-edge",
    "payloadConfigSchema": "gate-payload-config-schema",
    "processorLiveness": "gate-processor-liveness",
}


def slug_for(gate: str) -> str:
    """camelCase gate -> kebab-case file stem.

    An unknown gate gets a derived slug rather than an exception: a gate this
    toolkit has never seen is precisely what the doctor coverage check exists
    to report, and it cannot report what it cannot name.
    """
    if gate in _SLUGS:
        return _SLUGS[gate]
    kebab = "".join("-" + c.lower() if c.isupper() else c for c in gate)
    return "gate-" + kebab.lstrip("-")


def path_for(gate: str) -> pathlib.Path:
    return DIR / f"{slug_for(gate)}.md"


def reference_for(gate: str) -> str:
    """The path as the model should see it in a ``SEE:`` line."""
    return f"references/{slug_for(gate)}.md"
```

- [ ] **Step 4: Write the five reference files**

Each states the rule, what the offending payload names, the remedy, and what the
gate is *not*. The last section carries real weight: `schemaEdge` and
`payloadConfigSchema` both sound like "a schema problem" and send an operator to
completely different places. Rules and offending shapes are taken from
`OrchestrationValidationException.cs`; the gate order from
`OrchestrationService.StartAsync`.

`skp-toolkit/skp/references/gate-schema-edge.md`:

```markdown
# Gate: schemaEdge

`POST /orchestration/start` rejected the workflow with HTTP 422 and
`errors.gate = "schemaEdge"`.

## What the gate checks

For every edge `parent -> child` in the step graph, the parent's **output**
schema id must equal the child's **input** schema id. It runs third, after
`cycle` and `missingStep`, and before `payloadConfigSchema`.

## What the offending payload tells you

`errors.offending` is `{parentStepId, childStepId}` — the exact edge that
failed. It names the edge rather than the schema, because a mismatch is a
property of the join, not of either side alone.

## Remedy

Read both steps and compare the schema ids on their processors:

    skp observe projected --workflow <id>
    skp map --component postgres

Then either repoint the child step at a processor whose input schema matches the
parent's output, or change one of the processors' registered schema ids. Both
are definition edits: re-apply with `skp author apply`, then validate again.

## What this is NOT

Not a payload problem. A payload that fails its config schema is
`payloadConfigSchema` — a different gate, whose remedy is to fix the assignment
body rather than the graph.
```

`skp-toolkit/skp/references/gate-cycle.md`:

```markdown
# Gate: cycle

HTTP 422 with `errors.gate = "cycle"`.

## What the gate checks

The step graph must be acyclic. This gate runs **first**, before every other —
a cyclic graph cannot be meaningfully checked by the later gates.

## What the offending payload tells you

`errors.offending` is `{stepChain}`: the ordered list of step ids forming the
cycle, and the `detail` renders it as `a -> b -> c`. The chain is the whole
answer; no further lookup is needed to locate the loop.

## Remedy

Break one edge in the chain. Every step in `stepChain` is a real step, so pick
the edge that should not exist and remove that successor from its parent, then
`skp author apply` and validate again.

## What this is NOT

Not a missing step. A parent pointing at a child id that does not exist is
`missingStep`, and its remedy is to create the step or fix the reference.
```

`skp-toolkit/skp/references/gate-missing-step.md`:

```markdown
# Gate: missingStep

HTTP 422 with `errors.gate = "missingStep"`.

## What the gate checks

Every child step id referenced by a parent must exist. It runs after `cycle`.

## What the offending payload tells you

`errors.offending` is `{parentStepId, missingChildId}` — who points, and at
what that is not there.

## Remedy

Either create the missing step and re-apply, or remove the dangling successor
from the parent. If you applied a definition and it stopped partway, the
missing child may simply never have been created: check what `skp author apply`
reported as landed before it failed.

## What this is NOT

Not a schema mismatch. If both steps exist but their schemas disagree, the gate
is `schemaEdge`.
```

`skp-toolkit/skp/references/gate-payload-config-schema.md`:

```markdown
# Gate: payloadConfigSchema

HTTP 422 with `errors.gate = "payloadConfigSchema"`.

## What the gate checks

Each assignment's payload must conform to its processor's **config** schema. It
runs third, after `schemaEdge` and before `processorLiveness`.

## What the offending payload tells you

`errors.offending` is `{assignmentId, errors}`, where `errors` is the flattened
list of validation messages — the specific fields that failed, not just the fact
that something did.

## Remedy

Fix the assignment body to satisfy the config schema, then re-apply the
`assignments` section and validate again. If the schema is what is wrong,
changing it is a schema edit and re-registers the processor.

## What this is NOT

Not about data flowing between steps. Input/output schema disagreement across an
edge is `schemaEdge`. This gate is only about an assignment's own config payload.
```

`skp-toolkit/skp/references/gate-processor-liveness.md`:

```markdown
# Gate: processorLiveness

HTTP 422 with `errors.gate = "processorLiveness"`.

## What the gate checks

Every participating processor must have at least one replica that is present,
healthy and fresh — its liveness timestamp plus twice its interval still ahead
of now. It runs **last**, and is the only gate that reads live cluster state
rather than the definition. One healthy replica admits the processor even when
its siblings are unhealthy, stale, absent or malformed.

## What the offending payload tells you

`errors.offending` is `{procId, reason}`, and `reason` is a **count-only**
breakdown, e.g. `no healthy replica (4 checked: 4 absent, 0 unhealthy, 0 stale,
0 malformed)`. It deliberately carries no instance ids or connection detail. The
counts are the diagnosis: `absent` means no key at all (never deployed, or
scaled to zero), `stale` means a replica stopped heartbeating.

## Remedy

    skp observe liveness --processor <procId>
    skp observe pods --workload <deployment>

If the count is all-absent, the processor is not deployed — deploy it or scale
it up. If it is stale, the replicas are running but not heartbeating, which is a
processor-side fault: read its logs. Re-validate once a replica is fresh.

## What this is NOT

Not a definition error. The graph is fine; the cluster is not. Nothing in the
spec file needs to change, so do not re-apply — just fix the workload and start
again.
```

- [ ] **Step 5: Implement `skp/state.py`**

```python
"""The `state/` ledger -- spec §5, "compensates for forgetfulness".

A small model does not hold the workflow id from four turns ago, so verbs
record what they acted on and later verbs default to it. Deliberately tiny:
one file per key, last write wins, and a corrupt or absent file recalls as
``None`` so a damaged ledger degrades to "pass --workflow" rather than to a
crash mid-investigation.
"""
import json
import pathlib

KEYS = frozenset({"workflow"})


def _path(home: pathlib.Path, key: str) -> pathlib.Path:
    if key not in KEYS:
        raise ValueError(f"unknown state key {key!r}; known: {sorted(KEYS)}")
    return home / "state" / f"{key}.json"


def record(home: pathlib.Path, key: str, value: str) -> None:
    path = _path(home, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"value": value}), encoding="utf-8")


def recall(home: pathlib.Path, key: str) -> str | None:
    try:
        return json.loads(_path(home, key).read_text(encoding="utf-8"))["value"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
```

- [ ] **Step 6: Add the doctor row**

In `skp-toolkit/skp/verbs/doctor.py`, import `references` and add:

```python
def gate_reference_rows(gate_names: list[str]) -> list[tuple[str, bool, str]]:
    """One row covering reference coverage for every extracted gate.

    A gate the system can emit with no file to explain it is a dead ``SEE:``
    line: the model is sent to read something that is not there, which is
    worse than being sent nowhere. Reported as a single row because the
    operator's action is the same for one missing file or five -- write them.

    An empty gate list FAILS rather than passing vacuously. "Nothing to
    check" and "everything checked" must not render identically.
    """
    if not gate_names:
        return [("gate references", False,
                 "no gates.json -- run skp init --refresh")]
    missing = [g for g in gate_names if not references.path_for(g).exists()]
    if missing:
        return [("gate references", False,
                 f"{len(missing)} gate(s) with no reference file: "
                 f"{', '.join(missing)}")]
    return [("gate references", True, f"{len(gate_names)} gate(s) covered")]
```

Call it from `diagnose`, reading `profile.home / "model" / "gates.json"` and
passing `[]` when the file is absent or malformed, so the first branch reports it.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd skp-toolkit && python -m unittest tests.test_references tests.test_state -v`

Expected: PASS (11 tests)

- [ ] **Step 8: Run the full suite and doctor live**

```bash
cd skp-toolkit
python -m unittest discover -s tests -t .
python -m skp init --home <TEMP OUTSIDE THE REPO> --source-root ../src --project skp \
  --endpoint baseapi=http://localhost:18080 \
  --endpoint prometheus=http://localhost:19090 \
  --endpoint elasticsearch=http://localhost:19200
python -m skp doctor --home <same>
```

Expected: suite OK; doctor prints `gate references  ok  5 gate(s) covered`.

- [ ] **Step 9: Commit**

```bash
git add skp-toolkit/skp/references skp-toolkit/skp/state.py skp-toolkit/skp/verbs/doctor.py skp-toolkit/tests/test_references.py skp-toolkit/tests/test_state.py
git commit -m "feat(skp-toolkit): a remedy file per gate, the state ledger, and a doctor check that none is missing"
```

---

### Task 3: `skp author validate` — call the real gates

**Files:**
- Create: `skp-toolkit/skp/verbs/author.py`
- Modify: `skp-toolkit/skp/cli.py`
- Test: `skp-toolkit/tests/test_author.py` (create)

**Interfaces:**
- Consumes: `references.reference_for` and `state.record` (Task 2);
  `clients["baseapi"].http.probe_status(method, path, body) -> tuple[int, str]`;
  `load_catalog(home) -> list[dict]`; `build_clients(profile) -> dict`.
- Produces: `author.validate(entries, clients, workflow_id, confirm_start) -> Result`
  and `author.run(argv) -> Result`.

**The honest contract.** There is no dry-run endpoint. All five gates run before
`_sender.SendAsync`, so a **rejection costs nothing** — but a graph that passes
every gate is *started*, because passing the gates is what starting does. So:

- Without `--confirm-start`, `validate` refuses and explains, exit `EXIT_USAGE`,
  touching nothing.
- With it, a 202 is reported as `valid — and the workflow is now RUNNING`, the
  workflow id is recorded to `state/`, and `NEXT:` points at `skp operate verify`.

- [ ] **Step 1: Write the failing test**

Create `skp-toolkit/tests/test_author.py`:

```python
import unittest

from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, EXIT_VERDICT
from skp.verbs import author

WF = "4cd8af45-1295-43db-ab2e-e955dd82b5c5"

ENTRIES = [{"id": "api.orchestration.post_start", "component": "api",
            "operation": "POST /api/v1.0/orchestration/start",
            "detail": "orchestration"}]


class FakeHttp:
    def __init__(self, reply, raises=None):
        self._reply = reply
        self._raises = raises
        self.calls = []

    def probe_status(self, method, path, body):
        self.calls.append((method, path, body))
        if self._raises:
            raise self._raises
        return self._reply


class FakeApi:
    def __init__(self, reply, raises=None):
        self.http = FakeHttp(reply, raises)


def clients_for(status, text, raises=None):
    return {"baseapi": FakeApi((status, text), raises)}


class ValidateTests(unittest.TestCase):
    def test_without_confirmation_it_refuses_and_never_calls_the_api(self):
        clients = clients_for(202, "")
        result = author.validate(ENTRIES, clients, WF, confirm_start=False)
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertEqual(clients["baseapi"].http.calls, [])
        self.assertIn("--confirm-start", result.render())

    def test_a_422_names_the_gate_and_its_reference_file(self):
        body = ('{"title":"Schema-edge mismatch between steps","status":422,'
                '"detail":"Schema-edge mismatch on edge.",'
                '"errors":{"gate":"schemaEdge","offending":'
                '{"parentStepId":"a","childStepId":"b"}}}')
        result = author.validate(ENTRIES, clients_for(422, body), WF,
                                 confirm_start=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("schemaEdge", result.render())
        self.assertIn("parentStepId", result.render())
        self.assertEqual(result.reference, "references/gate-schema-edge.md")

    def test_a_404_is_a_verdict_about_the_workflow_not_a_gate(self):
        body = ('{"title":"Not Found","status":404,'
                '"detail":"WorkflowEntity with id \'x\' was not found."}')
        result = author.validate(ENTRIES, clients_for(404, body), WF,
                                 confirm_start=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIsNone(result.reference)
        self.assertIn("not found", result.render().lower())

    def test_a_202_reports_that_the_workflow_is_now_running(self):
        result = author.validate(ENTRIES, clients_for(202, ""), WF,
                                 confirm_start=True)
        self.assertEqual(result.code, EXIT_OK)
        self.assertIn("RUNNING", result.render())
        self.assertIn("skp operate verify", result.render())

    def test_an_unparseable_422_names_the_status_rather_than_crashing(self):
        result = author.validate(ENTRIES, clients_for(422, "<html>nope</html>"),
                                 WF, confirm_start=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("422", result.render())

    def test_a_transport_failure_is_unreachable_not_a_verdict(self):
        """UNVERIFIABLE and REFUTED are different answers -- the same ruling
        skp verify makes. A store that did not answer has not rejected."""
        result = author.validate(ENTRIES, clients_for(0, "", raises=OSError("boom")),
                                 WF, confirm_start=True)
        self.assertEqual(result.code, EXIT_UNREACHABLE)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_author -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'skp.verbs.author'`

- [ ] **Step 3: Implement `author.validate`**

Create `skp-toolkit/skp/verbs/author.py`:

```python
"""`skp author` -- design and verify workflow definitions.

**This verb reimplements nothing.** The five gates -- cycle, missingStep,
schemaEdge, payloadConfigSchema, processorLiveness -- live in
``OrchestrationService.StartAsync``, run before any side effect, and report
themselves in the 422's ``errors.gate``. Copying them into Python would give
this toolkit a second opinion free to disagree with the system, which is the
confabulation the whole design exists to prevent (spec §2: a hand-written
copy "is recall with extra steps, and fails the same silent way when the C#
moves").

**There is no dry-run, and the verb says so.** Passing every gate IS
starting: ``StartAsync`` sends ``StartOrchestration`` the moment the fifth
gate returns. So a rejection is free, a pass is a running workflow, and
``--confirm-start`` is the gate on that write (spec §8).
"""
import argparse
import json
import pathlib

from skp import references, state
from skp.profile import Profile, ProfileMissing, default_home
from skp.result import (EXIT_NOT_INITIALISED, EXIT_OK, EXIT_UNREACHABLE,
                        EXIT_USAGE, EXIT_VERDICT, Result)
from skp.verbs.init import build_clients
from skp.verbs.map import load_catalog

START_ID = "api.orchestration.post_start"


def path_for(entries: list[dict], surface_id: str) -> str | None:
    for entry in entries:
        if entry["id"] == surface_id:
            return entry["operation"].split(" ", 1)[1]
    return None


def _body(text: str) -> dict:
    try:
        return json.loads(text) if text else {}
    except ValueError:
        return {}


def validate(entries: list[dict], clients: dict, workflow_id: str,
             confirm_start: bool) -> Result:
    path = path_for(entries, START_ID)
    if path is None:
        return Result(EXIT_NOT_INITIALISED,
                      [f"{START_ID} is not in the catalog"],
                      next_command="skp init --refresh")

    if not confirm_start:
        return Result(EXIT_USAGE, [
            "skp author validate runs the system's own five gates by calling",
            f"POST {path}. There is no dry-run: a workflow that passes every",
            "gate is STARTED by the same call that validates it.",
            "",
            "A rejection costs nothing -- all five gates run before any write.",
            "Re-run with --confirm-start once you accept that a valid graph",
            "will begin running.",
        ], next_command=(f"skp author validate --workflow {workflow_id} "
                         f"--confirm-start"))

    try:
        status, text = clients["baseapi"].http.probe_status("POST", path, workflow_id)
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"POST {path} failed -- {exc}"],
                      next_command="skp doctor")

    body = _body(text)

    if status in (200, 202):
        return Result(EXIT_OK, [
            f"valid -- all five gates passed (HTTP {status}).",
            "The workflow is now RUNNING: the call that validates is the call",
            "that starts. 202 means accepted, not applied.",
        ], next_command=f"skp operate verify --workflow {workflow_id}")

    if status == 422:
        errors = body.get("errors") or {}
        gate = errors.get("gate")
        if not gate:
            return Result(EXIT_VERDICT,
                          [f"rejected with HTTP 422 but no gate discriminator "
                           f"in the body: {text[:200]}"],
                          next_command="skp doctor")
        lines = [f"rejected at gate {gate!r} -- {body.get('title', '')}".rstrip(),
                 body.get("detail", "")]
        offending = errors.get("offending")
        if offending is not None:
            lines.append("offending: " + json.dumps(offending, sort_keys=True))
        return Result(EXIT_VERDICT, [ln for ln in lines if ln],
                      next_command="skp author apply --spec <file> --confirm-write",
                      reference=references.reference_for(gate))

    detail = body.get("detail") or text[:200] or f"HTTP {status}"
    return Result(EXIT_VERDICT, [f"start refused with HTTP {status}: {detail}"],
                  next_command="skp map --component api")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skp-toolkit && python -m unittest tests.test_author -v`

Expected: PASS (6 tests)

- [ ] **Step 5: Add `run` and register the CLI group**

Append to `skp-toolkit/skp/verbs/author.py`:

```python
def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp author")
    parser.add_argument("--home", default=str(default_home()))
    sub = parser.add_subparsers(dest="mode", required=True)

    p = sub.add_parser("validate")
    p.add_argument("--workflow", required=True)
    p.add_argument("--confirm-start", action="store_true")

    ns = parser.parse_args(argv)
    home = pathlib.Path(ns.home)
    try:
        profile = Profile.load(home)
    except ProfileMissing:
        return Result(EXIT_NOT_INITIALISED, ["no profile in " + str(home)],
                      next_command="skp init")

    entries = load_catalog(home)
    clients = build_clients(profile)

    if ns.mode == "validate":
        result = validate(entries, clients, ns.workflow, ns.confirm_start)
        if result.code == EXIT_OK:
            state.record(home, "workflow", ns.workflow)
        return result

    return Result(EXIT_USAGE, [f"unknown mode {ns.mode!r}"],
                  next_command="skp author validate --workflow <id>")
```

In `skp-toolkit/skp/cli.py` add the import and the group:

```python
from skp.verbs import author as author_verb
...
GROUPS = {"init": init_verb.run, "map": map_verb.run, "doctor": doctor_verb.run,
          "verify": verify_verb.run, "observe": observe_verb.run,
          "investigate": investigate_verb.run, "author": author_verb.run}
```

- [ ] **Step 6: Run the full suite and check live**

```bash
cd skp-toolkit
python -m unittest discover -s tests -t .
python -m skp author validate --home <TEMP> --workflow 4cd8af45-1295-43db-ab2e-e955dd82b5c5
```

Expected: suite OK. The live call **refuses** and prints the `--confirm-start`
explanation without touching the API — confirm by checking that no
`accepted start for workflow` record appears in Elasticsearch.

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/skp/verbs/author.py skp-toolkit/skp/cli.py skp-toolkit/tests/test_author.py
git commit -m "feat(skp-toolkit): skp author validate -- the system's own five gates, not a copy"
```

---

### Task 4: `skp author apply` — the definition, through the real endpoints

**Files:**
- Modify: `skp-toolkit/skp/verbs/author.py`
- Test: `skp-toolkit/tests/test_author.py`

**Interfaces:**
- Consumes: `author.path_for` and `probe_status` as in Task 3.
- Produces: `author.apply(entries, clients, spec: dict, confirm_write: bool) -> Result`
  and the module constant `author.APPLY_ORDER: tuple[str, ...]`.

**The spec-file format is the one invention in this plan, and it is deliberately
thin.** The design doc names "a spec file" without defining it. Rather than
design a schema, the file is an envelope whose section bodies are passed to the
endpoints **verbatim** — the DTO stays the system's, and a DTO change surfaces as
the API's own 400 rather than as a toolkit translation bug.

```json
{
  "schemas":     [ { "...exactly the POST /api/v1.0/schemas body..." } ],
  "processors":  [ { "...exactly the POST /api/v1.0/processors body..." } ],
  "steps":       [ { "..." } ],
  "assignments": [ { "..." } ],
  "workflows":   [ { "..." } ]
}
```

**The order is not a preference — it is the foreign-key graph**, read from the
live database: `processors -> schemas`, `steps -> processors`,
`assignments -> steps`, and the junction tables `workflow_entry_steps` and
`workflow_assignments` depend on `workflows` plus `steps`/`assignments`. The
junctions ride the workflow body, which is why workflows are applied last.

- [ ] **Step 1: Write the failing test**

Append to `skp-toolkit/tests/test_author.py`:

```python
APPLY_ENTRIES = ENTRIES + [
    {"id": f"api.{name}.post", "component": "api",
     "operation": f"POST /api/v1.0/{name}", "detail": name}
    for name in ("schemas", "processors", "steps", "assignments", "workflows")
]


class ApplyTests(unittest.TestCase):
    def test_sections_are_posted_in_foreign_key_order(self):
        posted = []

        class RecordingApi:
            class http:
                @staticmethod
                def probe_status(method, path, body):
                    posted.append(path)
                    return (201, '{"id":"x"}')

        spec = {"workflows": [{"n": 1}], "schemas": [{"n": 2}],
                "assignments": [{"n": 3}], "processors": [{"n": 4}],
                "steps": [{"n": 5}]}
        result = author.apply(APPLY_ENTRIES, {"baseapi": RecordingApi()}, spec,
                              confirm_write=True)
        self.assertEqual(result.code, EXIT_OK)
        self.assertEqual(posted, [
            "/api/v1.0/schemas", "/api/v1.0/processors", "/api/v1.0/steps",
            "/api/v1.0/assignments", "/api/v1.0/workflows"])

    def test_a_rejected_section_stops_the_apply_and_names_what_landed(self):
        """Half an applied definition is a real state somebody has to clean
        up, so the verb must say exactly how far it got."""
        calls = []

        class FailingApi:
            class http:
                @staticmethod
                def probe_status(method, path, body):
                    calls.append(path)
                    if "processors" in path:
                        return (400, '{"detail":"Name is required."}')
                    return (201, '{"id":"x"}')

        spec = {"schemas": [{"n": 1}], "processors": [{"n": 2}], "steps": [{"n": 3}]}
        result = author.apply(APPLY_ENTRIES, {"baseapi": FailingApi()}, spec,
                              confirm_write=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("Name is required", result.render())
        self.assertIn("1 schemas", result.render())
        self.assertNotIn("/api/v1.0/steps", calls)

    def test_without_confirmation_nothing_is_posted(self):
        class Forbidden:
            class http:
                @staticmethod
                def probe_status(method, path, body):
                    raise AssertionError("must not be called")

        result = author.apply(APPLY_ENTRIES, {"baseapi": Forbidden()},
                              {"schemas": [{}]}, confirm_write=False)
        self.assertEqual(result.code, EXIT_USAGE)

    def test_an_unknown_section_is_refused_before_any_write(self):
        class Forbidden:
            class http:
                @staticmethod
                def probe_status(method, path, body):
                    raise AssertionError("must not be called")

        result = author.apply(APPLY_ENTRIES, {"baseapi": Forbidden()},
                              {"widgets": [{}]}, confirm_write=True)
        self.assertEqual(result.code, EXIT_USAGE)
        self.assertIn("widgets", result.render())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_author -v`

Expected: FAIL — `AttributeError: module 'skp.verbs.author' has no attribute 'apply'`

- [ ] **Step 3: Implement `apply`**

Append to `skp-toolkit/skp/verbs/author.py`:

```python
# The foreign-key graph, read from the live database rather than assumed:
#   processors -> schemas
#   steps -> processors
#   assignments -> steps
#   workflow_entry_steps -> workflows, steps
#   workflow_assignments -> workflows, assignments
# The junctions ride the workflow body, so workflows go last.
APPLY_ORDER = ("schemas", "processors", "steps", "assignments", "workflows")


def _landed(applied: list[str]) -> str:
    if not applied:
        return "nothing"
    counts: dict[str, int] = {}
    for section in applied:
        counts[section] = counts.get(section, 0) + 1
    return ", ".join(f"{n} {s}" for s, n in counts.items())


def apply(entries: list[dict], clients: dict, spec: dict,
          confirm_write: bool) -> Result:
    """POSTs each section verbatim, in foreign-key order.

    The bodies are passed through untouched. This toolkit does not know the
    DTO shapes and must not learn them: a translation layer here would be a
    second definition of the contract, free to drift from the validators that
    actually run. A malformed body comes back as the API's own 400 with its
    own message, which is the authority.
    """
    unknown = [k for k in spec if k not in APPLY_ORDER]
    if unknown:
        return Result(EXIT_USAGE,
                      [f"unknown spec section(s): {', '.join(sorted(unknown))}",
                       f"known sections, in apply order: {', '.join(APPLY_ORDER)}"],
                      next_command="skp author apply --spec <file>")

    if not confirm_write:
        planned = ", ".join(f"{len(spec[s])} {s}" for s in APPLY_ORDER if spec.get(s))
        return Result(EXIT_USAGE,
                      ["skp author apply writes to the live system.",
                       f"planned, in foreign-key order: {planned or 'nothing'}",
                       "re-run with --confirm-write to apply."],
                      next_command="skp author apply --spec <file> --confirm-write")

    applied: list[str] = []
    for section in APPLY_ORDER:
        path = path_for(entries, f"api.{section}.post")
        if path is None:
            return Result(EXIT_NOT_INITIALISED,
                          [f"api.{section}.post is not in the catalog"],
                          next_command="skp init --refresh")
        for index, body in enumerate(spec.get(section) or []):
            try:
                status, text = clients["baseapi"].http.probe_status("POST", path, body)
            except Exception as exc:
                return Result(EXIT_UNREACHABLE,
                              [f"POST {path} failed -- {exc}",
                               f"applied before the failure: {_landed(applied)}"],
                              next_command="skp doctor")
            if status not in (200, 201, 202, 204):
                detail = _body(text).get("detail") or text[:200] or f"HTTP {status}"
                return Result(EXIT_VERDICT, [
                    f"{section}[{index}] rejected with HTTP {status}: {detail}",
                    f"applied before the failure: {_landed(applied)}",
                    "The definition is now PARTIAL. Fix the section and "
                    "re-apply; rows already created will collide rather than "
                    "duplicate.",
                ], next_command="skp author apply --spec <file> --confirm-write")
            applied.append(section)

    return Result(EXIT_OK, [f"applied: {_landed(applied)}"],
                  next_command="skp author validate --workflow <id> --confirm-start")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skp-toolkit && python -m unittest tests.test_author -v`

Expected: PASS (10 tests)

- [ ] **Step 5: Add the subparser**

In `author.run`, add beside the `validate` parser:

```python
    p = sub.add_parser("apply")
    p.add_argument("--spec", required=True)
    p.add_argument("--confirm-write", action="store_true")
```

and in the dispatch, before the unknown-mode fallback:

```python
    if ns.mode == "apply":
        try:
            spec = json.loads(pathlib.Path(ns.spec).read_text(encoding="utf-8"))
        except OSError as exc:
            return Result(EXIT_USAGE, [f"cannot read {ns.spec}: {exc}"],
                          next_command="skp author apply --spec <file>")
        except ValueError as exc:
            return Result(EXIT_USAGE, [f"{ns.spec} is not valid JSON: {exc}"],
                          next_command="skp author apply --spec <file>")
        return apply(entries, clients, spec, ns.confirm_write)
```

- [ ] **Step 6: Run the full suite**

Run: `cd skp-toolkit && python -m unittest discover -s tests -t .`

Expected: OK

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/skp/verbs/author.py skp-toolkit/tests/test_author.py
git commit -m "feat(skp-toolkit): skp author apply -- verbatim bodies in foreign-key order"
```

---

### Task 5: `skp operate start` and `stop` — each ending in a read-back

**Files:**
- Create: `skp-toolkit/skp/verbs/operate.py`
- Modify: `skp-toolkit/skp/cli.py`
- Test: `skp-toolkit/tests/test_operate.py` (create)

**Interfaces:**
- Consumes: `references.reference_for`, `state.record` (Task 2);
  `clients["redis"].keys(pattern) -> list[str]`; catalogued `redis.Root`
  (`skp:{workflowId}`).
- Produces: `operate.start(entries, clients, workflow_id, confirm, attempts, poll_s) -> Result`,
  `operate.stop(...)` with the same signature, and the helpers
  `operate.path_for`, `operate.root_pattern`, `operate.gate_result`.

**A 202 is not proof.** The catalog says so on both endpoints: start's `never_for`
is "confirming the workflow is projected — 202 means accepted, not applied", and
stop's is the mirror. Both commands poll the L2 root key afterwards and report
what they observed, not what they requested.

- [ ] **Step 1: Write the failing test**

Create `skp-toolkit/tests/test_operate.py`:

```python
import unittest

from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, EXIT_VERDICT
from skp.verbs import operate

WF = "4cd8af45-1295-43db-ab2e-e955dd82b5c5"

ENTRIES = [
    {"id": "api.orchestration.post_start", "component": "api",
     "operation": "POST /api/v1.0/orchestration/start", "detail": "orchestration"},
    {"id": "api.orchestration.post_stop", "component": "api",
     "operation": "POST /api/v1.0/orchestration/stop", "detail": "orchestration"},
    {"id": "redis.Root", "component": "redis", "operation": "read key",
     "detail": "skp:{workflowId}"},
]


class FakeRedis:
    """Returns a scripted sequence per pattern, so a key that appears on the
    second poll can be distinguished from one that never appears."""

    def __init__(self, sequences):
        self._sequences = {k: list(v) for k, v in sequences.items()}

    def keys(self, pattern):
        seq = self._sequences.get(pattern)
        if not seq:
            return []
        return seq.pop(0)


class FakeApi:
    def __init__(self, reply, raises=None):
        self._reply = reply
        self._raises = raises
        outer = self

        class _Http:
            @staticmethod
            def probe_status(method, path, body):
                if outer._raises:
                    raise outer._raises
                return outer._reply

        self.http = _Http()


class StartTests(unittest.TestCase):
    def test_a_202_is_not_started_until_the_root_key_appears(self):
        clients = {"baseapi": FakeApi((202, "")),
                   "redis": FakeRedis({f"skp:{WF}": [[], [f"skp:{WF}"]]})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=2, poll_s=0)
        self.assertEqual(result.code, EXIT_OK)
        self.assertIn("projected", result.render())

    def test_a_202_whose_projection_never_lands_is_a_verdict(self):
        clients = {"baseapi": FakeApi((202, "")),
                   "redis": FakeRedis({f"skp:{WF}": [[], []]})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=2, poll_s=0)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("accepted, not applied", result.render())

    def test_a_422_from_start_names_the_gate_and_reference(self):
        body = ('{"detail":"Processor is not live.","errors":'
                '{"gate":"processorLiveness","offending":'
                '{"procId":"p","reason":"no healthy replica"}}}')
        clients = {"baseapi": FakeApi((422, body)), "redis": FakeRedis({})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertEqual(result.reference,
                         "references/gate-processor-liveness.md")

    def test_without_confirmation_it_refuses(self):
        clients = {"baseapi": FakeApi((202, "")), "redis": FakeRedis({})}
        result = operate.start(ENTRIES, clients, WF, confirm=False,
                               attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_USAGE)

    def test_a_transport_failure_is_unreachable(self):
        clients = {"baseapi": FakeApi((0, ""), raises=OSError("boom")),
                   "redis": FakeRedis({})}
        result = operate.start(ENTRIES, clients, WF, confirm=True,
                               attempts=1, poll_s=0)
        self.assertEqual(result.code, EXIT_UNREACHABLE)


class StopTests(unittest.TestCase):
    def test_stop_waits_for_the_root_key_to_disappear(self):
        clients = {"baseapi": FakeApi((202, "")),
                   "redis": FakeRedis({f"skp:{WF}": [[f"skp:{WF}"], []]})}
        result = operate.stop(ENTRIES, clients, WF, confirm=True,
                              attempts=2, poll_s=0)
        self.assertEqual(result.code, EXIT_OK)
        self.assertIn("gone from L2", result.render())

    def test_a_projection_that_survives_the_stop_is_a_verdict(self):
        clients = {"baseapi": FakeApi((202, "")),
                   "redis": FakeRedis({f"skp:{WF}": [[f"skp:{WF}"],
                                                     [f"skp:{WF}"]]})}
        result = operate.stop(ENTRIES, clients, WF, confirm=True,
                              attempts=2, poll_s=0)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("queued, not applied", result.render())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_operate -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'skp.verbs.operate'`

- [ ] **Step 3: Implement `operate.py` with `start` and `stop`**

Create `skp-toolkit/skp/verbs/operate.py`:

```python
"""`skp operate` -- control, each command ending in a proof it took effect.

The proof is never the status code. The catalog's own ``never_for`` on
``api.orchestration.post_start`` reads "202 means accepted, not applied", and
stop's is its mirror, so both commands read the L2 root key back afterwards
and report what they observed rather than what they asked for.
"""
import argparse
import json
import pathlib
import time
import uuid

from skp import references, state
from skp.profile import Profile, ProfileMissing, default_home
from skp.result import (EXIT_NOT_INITIALISED, EXIT_OK, EXIT_UNREACHABLE,
                        EXIT_USAGE, EXIT_VERDICT, Result)
from skp.verbs.init import build_clients
from skp.verbs.map import load_catalog

START_ID = "api.orchestration.post_start"
STOP_ID = "api.orchestration.post_stop"
ROOT_ID = "redis.Root"
_ATTEMPTS = 20
_POLL_S = 0.5


def path_for(entries: list[dict], surface_id: str) -> str | None:
    for entry in entries:
        if entry["id"] == surface_id:
            return entry["operation"].split(" ", 1)[1]
    return None


def root_pattern(entries: list[dict], workflow_id: str) -> str | None:
    for entry in entries:
        if entry["id"] == ROOT_ID:
            return entry["detail"].replace("{workflowId}", workflow_id)
    return None


def _await_root(client, pattern: str, present: bool,
                attempts: int, poll_s: float) -> bool:
    """Polls the L2 root key until its presence matches ``present``."""
    for attempt in range(attempts):
        if bool(client.keys(pattern)) == present:
            return True
        if attempt + 1 < attempts:
            time.sleep(poll_s)
    return False


def gate_result(status: int, text: str) -> Result | None:
    """A 422 rendered as a gate verdict, or None when this is not a gate."""
    if status != 422:
        return None
    try:
        body = json.loads(text)
    except ValueError:
        body = {}
    gate = (body.get("errors") or {}).get("gate")
    if not gate:
        return Result(EXIT_VERDICT, [f"rejected with HTTP 422: {text[:200]}"],
                      next_command="skp doctor")
    lines = [f"rejected at gate {gate!r}", body.get("detail", "")]
    offending = (body.get("errors") or {}).get("offending")
    if offending is not None:
        lines.append("offending: " + json.dumps(offending, sort_keys=True))
    return Result(EXIT_VERDICT, [ln for ln in lines if ln],
                  next_command="skp investigate",
                  reference=references.reference_for(gate))


def start(entries, clients, workflow_id, confirm: bool,
          attempts: int = _ATTEMPTS, poll_s: float = _POLL_S) -> Result:
    if not confirm:
        return Result(EXIT_USAGE,
                      ["skp operate start writes to the live system.",
                       "re-run with --confirm to start the workflow."],
                      next_command=(f"skp operate start --workflow "
                                    f"{workflow_id} --confirm"))

    path = path_for(entries, START_ID)
    pattern = root_pattern(entries, workflow_id)
    if path is None or pattern is None:
        return Result(EXIT_NOT_INITIALISED,
                      ["catalog is missing api.orchestration.post_start or redis.Root"],
                      next_command="skp init --refresh")

    try:
        status, text = clients["baseapi"].http.probe_status("POST", path, workflow_id)
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"POST {path} failed -- {exc}"],
                      next_command="skp doctor")

    gated = gate_result(status, text)
    if gated is not None:
        return gated
    if status not in (200, 202):
        return Result(EXIT_VERDICT,
                      [f"start refused with HTTP {status}: {text[:200]}"],
                      next_command="skp map --component api")

    if _await_root(clients["redis"], pattern, True, attempts, poll_s):
        return Result(EXIT_OK,
                      [f"started -- accepted with HTTP {status}, and projected: "
                       f"{pattern} is present in L2."],
                      next_command=f"skp operate verify --workflow {workflow_id}")
    return Result(EXIT_VERDICT, [
        f"accepted with HTTP {status}, but {pattern} did not appear in L2 "
        f"within {attempts * poll_s:.0f}s -- accepted, not applied.",
    ], next_command="skp investigate")


def stop(entries, clients, workflow_id, confirm: bool,
         attempts: int = _ATTEMPTS, poll_s: float = _POLL_S) -> Result:
    if not confirm:
        return Result(EXIT_USAGE,
                      ["skp operate stop writes to the live system.",
                       "re-run with --confirm to stop the workflow."],
                      next_command=(f"skp operate stop --workflow "
                                    f"{workflow_id} --confirm"))

    path = path_for(entries, STOP_ID)
    pattern = root_pattern(entries, workflow_id)
    if path is None or pattern is None:
        return Result(EXIT_NOT_INITIALISED,
                      ["catalog is missing api.orchestration.post_stop or redis.Root"],
                      next_command="skp init --refresh")

    try:
        status, text = clients["baseapi"].http.probe_status("POST", path, workflow_id)
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"POST {path} failed -- {exc}"],
                      next_command="skp doctor")

    if status not in (200, 202, 204):
        return Result(EXIT_VERDICT,
                      [f"stop refused with HTTP {status}: {text[:200]}"],
                      next_command="skp map --component api")

    if _await_root(clients["redis"], pattern, False, attempts, poll_s):
        return Result(EXIT_OK, [f"stopped -- {pattern} is gone from L2."],
                      next_command=f"skp operate verify --workflow {workflow_id}")
    return Result(EXIT_VERDICT, [
        f"accepted with HTTP {status}, but {pattern} is still in L2 after "
        f"{attempts * poll_s:.0f}s -- queued, not applied. Steps already in "
        f"flight resolve before the projection is removed.",
    ], next_command=f"skp operate verify --workflow {workflow_id}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skp-toolkit && python -m unittest tests.test_operate -v`

Expected: PASS (7 tests)

- [ ] **Step 5: Add `run` and register the group**

Append to `skp-toolkit/skp/verbs/operate.py`:

```python
def run(argv: list[str]) -> Result:
    parser = argparse.ArgumentParser(prog="skp operate")
    parser.add_argument("--home", default=str(default_home()))
    sub = parser.add_subparsers(dest="mode", required=True)

    for name in ("start", "stop"):
        p = sub.add_parser(name)
        p.add_argument("--workflow", required=True)
        p.add_argument("--confirm", action="store_true")

    ns = parser.parse_args(argv)
    home = pathlib.Path(ns.home)
    try:
        profile = Profile.load(home)
    except ProfileMissing:
        return Result(EXIT_NOT_INITIALISED, ["no profile in " + str(home)],
                      next_command="skp init")

    entries = load_catalog(home)
    clients = build_clients(profile)

    handler = {"start": start, "stop": stop}[ns.mode]
    result = handler(entries, clients, ns.workflow, ns.confirm)
    if result.code == EXIT_OK:
        state.record(home, "workflow", ns.workflow)
    return result
```

In `skp-toolkit/skp/cli.py` add `from skp.verbs import operate as operate_verb`
and `"operate": operate_verb.run` to `GROUPS`.

- [ ] **Step 6: Run the full suite and check live**

```bash
cd skp-toolkit
python -m unittest discover -s tests -t .
python -m skp operate start --home <TEMP> --workflow 4cd8af45-1295-43db-ab2e-e955dd82b5c5 --confirm
python -m skp operate stop  --home <TEMP> --workflow 4cd8af45-1295-43db-ab2e-e955dd82b5c5 --confirm
```

Expected: suite OK; start reports `projected`, stop reports `gone from L2`.

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/skp/verbs/operate.py skp-toolkit/skp/cli.py skp-toolkit/tests/test_operate.py
git commit -m "feat(skp-toolkit): operate start/stop, each proving it applied rather than trusting 202"
```

---

### Task 6: `skp operate freeze` — the `Never` entry-step freeze

**Files:**
- Modify: `skp-toolkit/skp/verbs/operate.py`
- Test: `skp-toolkit/tests/test_operate.py`

**Interfaces:**
- Consumes: catalogued `api.steps.put_id`; `clients["postgres"].rows(sql) -> list[list[str]]`.
  Note two things about that client: it returns **lists of strings** (psql
  `--csv`), not dicts, so `entry_condition` compares against `"5"`; and it has
  **no parameter binding** — the SQL is interpolated, so ids must be validated
  as UUIDs first.
- Produces: `operate.freeze(entries, clients, step_id, confirm) -> Result` and
  the constant `operate.NEVER = 5`.

**Read `StepEntryCondition.Never` first** —
`src/BaseApi.Service/Features/Step/StepEntryCondition.cs:60`. Two semantics must
not be papered over:

1. It is a **per-entry-step** freeze, not a workflow stop: *"A stop halts a whole
   workflow, which is the wrong instrument when only one of several entry steps
   needs to stand down."*
2. **It is not immediate**: *"The freeze lands on the next start, not
   immediately, because L1 is a projection."*

So the proof of a freeze is **not** that dispatching stopped — it is that the row
reads `5`, plus the instruction to re-issue start. Reporting "frozen" while the
old projection still fires would be a lie the operator acts on.

- [ ] **Step 1: Write the failing test**

Append to `skp-toolkit/tests/test_operate.py`:

```python
FREEZE_ENTRIES = ENTRIES + [
    {"id": "api.steps.put_id", "component": "api",
     "operation": "PUT /api/v1.0/steps/{id}", "detail": "steps"},
]

STEP = "eb42edf2-062d-48be-896e-7860a7370b12"


class FakePg:
    """Mirrors the real client: rows(sql) -> list[list[str]]. Values are
    strings because psql --csv yields text, which is why the verb compares
    against "5" and not 5."""

    def __init__(self, rows):
        self._rows = rows

    def rows(self, sql):
        return self._rows


class FreezeTests(unittest.TestCase):
    def test_freeze_reports_that_it_lands_on_the_next_start(self):
        clients = {"baseapi": FakeApi((204, "")), "postgres": FakePg([["5"]])}
        result = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=True)
        self.assertEqual(result.code, EXIT_OK)
        self.assertIn("NEXT start", result.render())
        self.assertIn("skp operate start", result.render())

    def test_a_row_that_did_not_change_is_a_verdict(self):
        clients = {"baseapi": FakeApi((204, "")), "postgres": FakePg([["1"]])}
        result = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=True)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("entry_condition", result.render())

    def test_freeze_never_claims_dispatching_has_stopped(self):
        """The projection keeps firing until it is replaced, so any wording
        that implies immediate effect is false at the moment it is printed."""
        clients = {"baseapi": FakeApi((204, "")), "postgres": FakePg([["5"]])}
        text = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=True).render()
        self.assertNotIn("stopped dispatching", text)
        self.assertIn("projection", text)

    def test_without_confirmation_it_refuses(self):
        clients = {"baseapi": FakeApi((204, "")), "postgres": FakePg([])}
        result = operate.freeze(FREEZE_ENTRIES, clients, STEP, confirm=False)
        self.assertEqual(result.code, EXIT_USAGE)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_operate -v`

Expected: FAIL — `AttributeError: module 'skp.verbs.operate' has no attribute 'freeze'`

- [ ] **Step 3: Implement `freeze`**

Append to `skp-toolkit/skp/verbs/operate.py`:

```python
NEVER = 5  # StepEntryCondition.Never -- a stored wire value, never renumbered.


def freeze(entries, clients, step_id: str, confirm: bool) -> Result:
    """Sets one entry step's condition to ``Never``.

    Per ``StepEntryCondition.cs`` this is the operator's per-entry-step
    freeze: a stop halts a whole workflow, which is the wrong instrument when
    only one of several entry steps needs to stand down. Setting that one to
    Never and re-issuing start leaves the schedule armed and its siblings
    firing.

    THE FREEZE IS NOT IMMEDIATE. L1 is a projection, so it lands on the next
    start. The proof here is therefore the ROW plus the instruction to
    re-issue start -- never "dispatching has stopped", which would still be
    false at the moment this returns.
    """
    # pg.rows() interpolates SQL into a shell argument and offers no
    # parameter binding, so an id arriving from argv is validated before it
    # can reach the query.
    try:
        uuid.UUID(step_id)
    except ValueError:
        return Result(EXIT_USAGE, [f"{step_id!r} is not a UUID"],
                      next_command="skp observe projected --workflow <id>")

    if not confirm:
        return Result(EXIT_USAGE,
                      ["skp operate freeze writes to the live system.",
                       "re-run with --confirm to set the step to Never."],
                      next_command=f"skp operate freeze --step {step_id} --confirm")

    path = path_for(entries, "api.steps.put_id")
    if path is None:
        return Result(EXIT_NOT_INITIALISED, ["catalog is missing api.steps.put_id"],
                      next_command="skp init --refresh")

    try:
        status, text = clients["baseapi"].http.probe_status(
            "PUT", path.replace("{id}", step_id), {"entryCondition": NEVER})
    except Exception as exc:
        return Result(EXIT_UNREACHABLE, [f"PUT {path} failed -- {exc}"],
                      next_command="skp doctor")

    if status not in (200, 204):
        return Result(EXIT_VERDICT,
                      [f"freeze refused with HTTP {status}: {text[:200]}"],
                      next_command="skp map --component api")

    rows = clients["postgres"].rows(
        f"select entry_condition from steps where id = '{step_id}'")
    observed = rows[0][0] if rows and rows[0] else None
    if observed != str(NEVER):
        return Result(EXIT_VERDICT, [
            f"accepted with HTTP {status}, but steps.entry_condition reads "
            f"{observed!r}, not '{NEVER}' -- the freeze did not land.",
        ], next_command="skp investigate")

    return Result(EXIT_OK, [
        f"frozen -- steps.entry_condition is {NEVER} (Never) for {step_id}.",
        "This takes effect on the NEXT start, not now: L1 is a projection, so "
        "the running projection keeps firing until it is replaced.",
        "Sibling entry steps and the schedule are unaffected.",
    ], next_command="skp operate start --workflow <id> --confirm")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skp-toolkit && python -m unittest tests.test_operate -v`

Expected: PASS (11 tests)

- [ ] **Step 5: Add the subparser**

In `operate.run`, add:

```python
    p = sub.add_parser("freeze")
    p.add_argument("--step", required=True)
    p.add_argument("--confirm", action="store_true")
```

and dispatch it before the `start`/`stop` handler lookup:

```python
    if ns.mode == "freeze":
        return freeze(entries, clients, ns.step, ns.confirm)
```

- [ ] **Step 6: Run the full suite and commit**

Run: `cd skp-toolkit && python -m unittest discover -s tests -t .`

Expected: OK

```bash
git add skp-toolkit/skp/verbs/operate.py skp-toolkit/tests/test_operate.py
git commit -m "feat(skp-toolkit): operate freeze -- Never, and honest that it lands on the next start"
```

---

### Task 7: `skp operate verify` — the seven verdicts

**Files:**
- Modify: `skp-toolkit/skp/verbs/operate.py`
- Test: `skp-toolkit/tests/test_operate.py`

**Interfaces:**
- Consumes: `investigate._es_search(es, template, window, workflow_id, correlation_id, extra=None, size=25, order="asc")`
  and `investigate._original_format_filter(template)` — **reuse, do not rewrite**:
  a template's em dash arrives transformed through the OTel pipeline, so exact
  `term` matching finds zero and the prefix match in that helper is what works.
  `window` is the bare suffix (`"1h"`), because the helper builds `f"now-{window}"`.
  Also `clients["postgres"].rows(sql)`, `clients["rabbitmq"].queues()`, and
  `state.recall(home, "workflow")`.

**Scope by CorrelationId, not WorkflowId.** `_es_search`'s own docstring is
explicit: *"WorkflowId alone cannot identify a run, since a recurring workflow
fires more than once and the control-plane's own start/stop endpoints log the id
too."* Every workflow here is recurring, so scoping the verdicts by workflow
would blend runs — an earlier run's `completed` would mask the current run's
`wedged`, which is a wrong answer delivered confidently. So `observe_run` first
resolves the newest CorrelationId with a `order="desc"` discovery query (exactly
what rung 2 of the ladder does), then scopes every other read to it.
- Produces: `operate.resolve_verdict(observations: dict) -> tuple[str, list[str]]`,
  `operate.observe_run(entries, clients, workflow_id, window) -> dict`, and
  `operate.verify(...) -> Result`.

**Resolution order is fixed and is tested as an order**, because several
observations can hold at once and the most actionable must win:

1. `frozen` — checked first. A frozen workflow is not dispatching, and reporting
   that as `wedged` would send an operator to redeploy a healthy processor.
2. `parked-at-step-X` — `processor-{id}.dead` depth > 0.
3. `wedged-at-step-X` — `processor-{id}` depth > 0 with 0 consumers.
4. `failed-at-step-X` — a completion record whose `{Result}` is Failed.
5. `completed` — a terminal-completed record.
6. `running` — a `running the step` record inside the window.
7. `never-started` — none of the above, and no dispatch record.

- [ ] **Step 1: Write the failing test**

Append to `skp-toolkit/tests/test_operate.py`:

```python
class VerdictTests(unittest.TestCase):
    BASE = {"frozen": False, "parked": [], "wedged": [], "failed": [],
            "completed": False, "running": False, "dispatched": False}

    def obs(self, **kw):
        merged = dict(self.BASE)
        merged.update(kw)
        return merged

    def test_frozen_beats_never_started(self):
        self.assertEqual(operate.resolve_verdict(self.obs(frozen=True))[0],
                         "frozen")

    def test_frozen_beats_wedged(self):
        verdict, _ = operate.resolve_verdict(self.obs(frozen=True, wedged=["s2"]))
        self.assertEqual(verdict, "frozen")

    def test_parked_beats_wedged_and_names_the_step(self):
        verdict, lines = operate.resolve_verdict(
            self.obs(parked=["s1"], wedged=["s2"]))
        self.assertEqual(verdict, "parked-at-s1")
        self.assertTrue(any("dead" in ln for ln in lines))

    def test_wedged_beats_failed(self):
        self.assertEqual(
            operate.resolve_verdict(self.obs(wedged=["s2"], failed=["s3"]))[0],
            "wedged-at-s2")

    def test_failed_beats_completed(self):
        self.assertEqual(
            operate.resolve_verdict(self.obs(failed=["s3"], completed=True))[0],
            "failed-at-s3")

    def test_completed_beats_running(self):
        self.assertEqual(
            operate.resolve_verdict(self.obs(completed=True, running=True))[0],
            "completed")

    def test_running_when_only_steps_are_moving(self):
        self.assertEqual(
            operate.resolve_verdict(self.obs(running=True, dispatched=True))[0],
            "running")

    def test_nothing_at_all_is_never_started(self):
        verdict, lines = operate.resolve_verdict(self.obs())
        self.assertEqual(verdict, "never-started")
        self.assertTrue(any("no dispatch" in ln for ln in lines))

    def test_every_verdict_is_one_of_the_seven(self):
        """The set is closed. A new state must earn its own remedy -- it must
        not be silently folded into a neighbour."""
        flat = {"completed", "running", "frozen", "never-started"}
        prefixes = ("failed-at-", "parked-at-", "wedged-at-")
        for kwargs in ({"frozen": True}, {"parked": ["s"]}, {"wedged": ["s"]},
                       {"failed": ["s"]}, {"completed": True},
                       {"running": True}, {}):
            verdict, lines = operate.resolve_verdict(self.obs(**kwargs))
            self.assertTrue(verdict in flat or verdict.startswith(prefixes),
                            f"{verdict} is outside the closed set")
            self.assertTrue(lines, f"{verdict} carried no evidence")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skp-toolkit && python -m unittest tests.test_operate -v`

Expected: FAIL — `AttributeError: module 'skp.verbs.operate' has no attribute 'resolve_verdict'`

- [ ] **Step 3: Implement `resolve_verdict`**

Append to `skp-toolkit/skp/verbs/operate.py`:

```python
def resolve_verdict(observations: dict) -> tuple[str, list[str]]:
    """The seven verdicts, resolved in a fixed order.

    One verdict per distinct remedy: two states that send the operator to do
    the same thing are one verdict, two that send them somewhere different
    must never be merged. This is the ruling ``skp verify`` already makes for
    NOT_OBSERVED / REFUTED / UNVERIFIABLE -- collapsing them makes a verb cry
    wolf and be ignored.

    The ORDER carries as much weight as the set. Several observations can
    hold at once, and the most actionable has to win: a frozen workflow is
    not dispatching, so checking `frozen` after `wedged` would send an
    operator to redeploy a processor that is working perfectly.
    """
    if observations["frozen"]:
        return "frozen", [
            "every entry step reads steps.entry_condition = 5 (Never).",
            "Nothing is wrong: this workflow was deliberately frozen.",
        ]
    if observations["parked"]:
        step = observations["parked"][0]
        return f"parked-at-{step}", [
            f"processor-{step}.dead holds messages -- deliveries were rejected "
            f"and dead-lettered.",
            "They are recoverable by hand; they are not lost.",
        ]
    if observations["wedged"]:
        step = observations["wedged"][0]
        return f"wedged-at-{step}", [
            f"processor-{step} has queued messages and no consumers -- nothing "
            f"is reading the queue.",
        ]
    if observations["failed"]:
        step = observations["failed"][0]
        return f"failed-at-{step}", [
            f"a completion record for {step} reports Failed.",
        ]
    if observations["completed"]:
        return "completed", ["a terminal step completed and the run ended."]
    if observations["running"]:
        return "running", ["steps are executing inside the window."]
    return "never-started", [
        "no dispatch record inside the window, and nothing queued or parked.",
        "Either start was never issued, or it was rejected at a gate.",
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skp-toolkit && python -m unittest tests.test_operate -v`

Expected: PASS (20 tests)

- [ ] **Step 5: Implement `observe_run` and `verify`**

Append to `skp-toolkit/skp/verbs/operate.py`:

```python
from skp.verbs import investigate

_ENTRY_COMPLETED = "the entry step completed with {Result}"
_TERMINAL_COMPLETED = ("the terminal step completed with {Result} — "
                       "no successor accepts it, the run ends here")
_RUNNING = "running the step"
_DISPATCHED = "dispatched an entry step"


def _newest_correlation(es, workflow_id: str, window: str) -> str | None:
    """The current run's CorrelationId.

    order="desc" because ascending hands back the OLDEST dispatch in the
    window, and every workflow here recurs. Without this, a run that finished
    an hour ago supplies the verdict for the run happening now.
    """
    hits = investigate._es_search(es, _DISPATCHED, window, workflow_id, None,
                                  size=1, order="desc")
    for hit in hits:
        attrs = (hit.get("_source") or {}).get("attributes") or {}
        if attrs.get("CorrelationId"):
            return str(attrs["CorrelationId"])
    return None


def _entry_steps_all_never(clients, workflow_id: str) -> bool:
    """True only when the workflow HAS entry steps and every one is Never.

    A workflow with no entry steps at all is NOT frozen -- it is
    never-started. Conflating them would report "nothing is wrong" about a
    definition that cannot run.
    """
    rows = clients["postgres"].rows(
        "select s.entry_condition from workflow_entry_steps w "
        "join steps s on s.id = w.step_id "
        f"where w.workflow_id = '{workflow_id}'")
    values = [r[0] for r in rows if r]
    return bool(values) and all(v == str(NEVER) for v in values)


def _queue_states(clients) -> tuple[list[str], list[str]]:
    parked, wedged = [], []
    for queue in clients["rabbitmq"].queues():
        name = queue.get("name", "")
        if not name.startswith("processor-"):
            continue
        depth = int(queue.get("messages") or 0)
        if name.endswith(".dead"):
            if depth > 0:
                parked.append(name[len("processor-"):-len(".dead")])
        elif depth > 0 and int(queue.get("consumers") or 0) == 0:
            wedged.append(name[len("processor-"):])
    return sorted(parked), sorted(wedged)


def observe_run(entries, clients, workflow_id: str, window: str = "1h") -> dict:
    """Every field is a read of a catalogued surface. Nothing here recomputes
    a decision the system already made."""
    uuid.UUID(workflow_id)
    es = clients["elasticsearch"]
    correlation = _newest_correlation(es, workflow_id, window)

    def hits(template):
        return investigate._es_search(es, template, window, workflow_id,
                                      correlation)

    failed, completed = [], False
    for template in (_ENTRY_COMPLETED, _TERMINAL_COMPLETED):
        for hit in hits(template):
            attrs = (hit.get("_source") or {}).get("attributes") or {}
            if str(attrs.get("Result", "")).lower() == "failed":
                failed.append(str(attrs.get("StepId", "unknown")))
            elif template == _TERMINAL_COMPLETED:
                completed = True

    parked, wedged = _queue_states(clients)
    return {
        "frozen": _entry_steps_all_never(clients, workflow_id),
        "parked": parked,
        "wedged": wedged,
        "failed": sorted(set(failed)),
        "completed": completed,
        "running": bool(hits(_RUNNING)),
        "dispatched": bool(hits(_DISPATCHED)),
    }
```

Then:

```python
def verify(entries, clients, workflow_id: str, window: str) -> Result:
    observations = observe_run(entries, clients, workflow_id, window)
    verdict, evidence = resolve_verdict(observations)
    code = EXIT_OK if verdict in ("completed", "running", "frozen") else EXIT_VERDICT
    nexts = {
        "completed": "skp observe projected --workflow " + workflow_id,
        "running": "skp operate verify --workflow " + workflow_id,
        "frozen": "skp operate start --workflow " + workflow_id + " --confirm",
    }
    return Result(code, [f"{verdict}"] + evidence,
                  next_command=nexts.get(verdict, "skp investigate"))
```

Add the subparser with `--workflow` **optional**, defaulting from
`state.recall(home, "workflow")` per spec §5 ("`skp operate verify` with no
arguments verifies the run that `skp operate start` just started"), and returning
`EXIT_USAGE` naming `--workflow` when the ledger is empty.

- [ ] **Step 6: Run the full suite and verify live**

```bash
cd skp-toolkit
python -m unittest discover -s tests -t .
python -m skp operate verify --home <TEMP> --workflow 4cd8af45-1295-43db-ab2e-e955dd82b5c5
```

Expected: suite OK. Against the cluster as of 2026-08-31 this should resolve to
`parked-at-...`: `processor-d033b408….dead` holds 16 parked messages from that
day's fault injection, which is the live oracle for that branch. If they have
been purged, produce a `wedged` oracle instead by scaling
`deploy/processor-sample` to 0 with work queued, then restoring it to 4.

- [ ] **Step 7: Commit**

```bash
git add skp-toolkit/skp/verbs/operate.py skp-toolkit/tests/test_operate.py
git commit -m "feat(skp-toolkit): operate verify -- seven verdicts, one per remedy"
```

---

## Phase 3 done-when

Spec §13.2 requires, against the dev cluster:

- **`skp author validate` on a cyclic graph exits non-zero naming the cycle.**
  Apply a spec whose steps form a cycle, then validate with `--confirm-start`:
  expect exit `3`, `rejected at gate 'cycle'`, the offending `stepChain`, and
  `SEE: references/gate-cycle.md`.
- **`skp operate verify` returns `completed` for a completed run and
  `wedged-at-step-X` for a killed processor.** Run a workflow to completion for
  the first; scale `deploy/processor-sample` to 0 with work queued for the second.

Both oracles already exist in the repo's resilience scenarios, so neither needs
new fault-injection machinery.

## Known follow-ups, deliberately not in this plan

- **`skp remediate`** (§9) is a separate leaf and is not part of Phase 3.
- **The skill leaves themselves** are Phase 5. This plan only guarantees the
  inputs they generate from: intents tagged, `NEXT:` targets real, and a
  reference file behind every failure.
- **`author validate` cannot be made side-effect-free** without a validate-only
  endpoint in `src/`, which §14 puts out of scope. If one is ever added, the
  `--confirm-start` gate should collapse to a plain read.
