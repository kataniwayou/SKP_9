import pathlib
import unittest

from skp.compile.extract import (log_attributes, metric_labels, metrics, pg_tables, queues,
                                 redis_keys, rest_endpoints, templates)

SRC = pathlib.Path(__file__).resolve().parents[2] / "src"


def read(rel: str) -> str:
    return (SRC / rel).read_text(encoding="utf-8")


def _metrics_texts() -> dict[str, str]:
    return {p.name: p.read_text(encoding="utf-8") for p in SRC.rglob("*Metrics.cs")
            if "obj" not in p.parts and "bin" not in p.parts}


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class RealSourceTests(unittest.TestCase):
    def test_the_seven_documented_key_families_are_all_found(self):
        found = {s.id for s in redis_keys(
            read("Messaging.Contracts/Projections/L2ProjectionKeys.cs"))}
        self.assertEqual(found, {
            "redis.ParentIndex", "redis.Root", "redis.Step",
            "redis.PerInstance", "redis.InstanceIndex", "redis.ExecutionData",
            "redis.KeeperProbe",
        })

    def test_the_execution_blob_key_carries_the_documented_shape(self):
        by_id = {s.id: s for s in redis_keys(
            read("Messaging.Contracts/Projections/L2ProjectionKeys.cs"))}
        self.assertTrue(by_id["redis.ExecutionData"].detail.startswith("skp:data:"))

    def test_the_three_orchestrator_queues_are_found(self):
        found = {s.detail for s in queues(
            read("Messaging.Contracts/ProcessorQueues.cs"),
            read("Messaging.Contracts/OrchestratorQueues.cs"))}
        for name in ("orchestrator-control", "orchestrator-result",
                     "orchestrator-result-post", "processor-identity-query"):
            self.assertIn(name, found)

    def test_the_ten_ledger_templates_are_found(self):
        found = {s.detail for s in templates(
            read("tests/BaseApi.Tests/Live/Resilience/Templates.cs"))}
        for text in ("running the step", "the step returned after {ElapsedMs}ms",
                     "dispatched an entry step",
                     "the entry step completed with {Result}"):
            self.assertIn(text, found)

    def test_no_two_surfaces_share_an_id(self):
        surfaces = (
            redis_keys(read("Messaging.Contracts/Projections/L2ProjectionKeys.cs"))
            + queues(read("Messaging.Contracts/ProcessorQueues.cs"),
                     read("Messaging.Contracts/OrchestratorQueues.cs"))
            + templates(read("tests/BaseApi.Tests/Live/Resilience/Templates.cs"))
        )
        ids = [s.id for s in surfaces]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        self.assertEqual(duplicates, [], f"ids must be unique; collided: {duplicates}")


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class RealSurfaceTests(unittest.TestCase):
    def test_the_five_entity_tables_and_three_junctions_are_found(self):
        found = {s.id for s in pg_tables(read("BaseApi.Service/AppDbContext.cs"))}
        self.assertEqual(found, {
            "postgres.Schemas", "postgres.Processors", "postgres.Steps",
            "postgres.Assignments", "postgres.Workflows",
            "postgres.StepNextSteps", "postgres.WorkflowEntrySteps",
            "postgres.WorkflowAssignments",
        })

    def test_documented_instruments_are_all_present(self):
        texts = [p.read_text(encoding="utf-8") for p in SRC.rglob("*Metrics.cs")
                 if "obj" not in p.parts and "bin" not in p.parts]
        found = {s.id for s in metrics(texts)}
        for name in ("pipeline.queue.depth", "pipeline.deadletter.depth",
                     "pipeline.messages.produced", "pipeline.gate.open"):
            self.assertIn(f"prometheus.{name.replace('.', '_')}", found)

    def test_the_five_entity_controllers_and_orchestration_are_routed(self):
        texts = {p.name: p.read_text(encoding="utf-8")
                 for p in (SRC / "BaseApi.Service" / "Features").rglob("*Controller.cs")}
        operations = {s.operation for s in rest_endpoints(texts)}
        self.assertIn("GET /api/v1.0/workflows", operations)
        self.assertIn("POST /api/v1.0/orchestration/start", operations)
        self.assertIn("GET /api/v1.0/processors/by-source-hash/{sourceHash}", operations)


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class MetricLabelRealSourceTests(unittest.TestCase):
    """Pins the brief's Part 1 real-source assertions against the actual
    ``*Metrics.cs`` files, not a fixture standing in for them."""

    def test_pipeline_queue_depth_carries_queue(self):
        labels = metric_labels(_metrics_texts())
        self.assertIn("queue", labels["pipeline.queue.depth"])

    def test_pipeline_messages_consumed_carries_at_least_queue(self):
        labels = metric_labels(_metrics_texts())
        self.assertIn("queue", labels["pipeline.messages.consumed"])

    def test_the_five_ambient_role_instruments_carry_role(self):
        # C1: PipelineAmbientTag.AppendTo(ref tags) is called at the end of exactly
        # five method bodies (EgressMetrics.Record; IngressMetrics.RecordConsumed,
        # RecordArrival, RecordConsumerDuration -- the last of those two instruments
        # by way of two different methods). Pinned against the real source, not a
        # fixture, because this is the finding no prior assertion caught.
        labels = metric_labels(_metrics_texts())
        for name in ("pipeline.messages.produced", "pipeline.produce.duration",
                     "pipeline.messages.consumed", "pipeline.queue.wait",
                     "pipeline.consumer.duration"):
            self.assertIn("role", labels[name], f"{name} is missing role")

    def test_role_does_not_leak_onto_instruments_that_never_call_appendto(self):
        # The precision the reviewer verified: gate.open and gate.trips carry no
        # labels at all, gate.probe.duration carries only outcome. None of GateMetrics
        # calls PipelineAmbientTag.AppendTo, so widening to file scope would have been
        # visible here first.
        labels = metric_labels(_metrics_texts())
        self.assertNotIn("role", labels["pipeline.gate.open"])
        self.assertNotIn("role", labels["pipeline.gate.trips"])
        self.assertEqual(labels["pipeline.gate.probe.duration"], ["outcome"])

    def test_every_label_key_the_brief_names_is_attached_to_some_instrument(self):
        # queue, type, outcome, disposition, route, reason, loop, destination -- the
        # vocabulary the brief gives as a cross-check on the scan, not the list to
        # hardcode. Every one of them must land on at least one real instrument, or
        # the extractor dropped something the grep found.
        labels = metric_labels(_metrics_texts())
        attached = {label for labels_ in labels.values() for label in labels_}
        for expected in ("queue", "type", "outcome", "disposition",
                         "route", "reason", "loop", "destination"):
            self.assertIn(expected, attached)

    def test_a_genuinely_label_less_instrument_is_distinguishable_from_a_missed_one(self):
        # pipeline.leader and pipeline.gate.open carry nothing by design (single
        # process-wide/host-wide gauges); metric_labels must say so explicitly rather
        # than merely omitting them from the dict.
        labels = metric_labels(_metrics_texts())
        for name in ("pipeline.leader", "pipeline.gate.open", "pipeline.gate.trips",
                     "pipeline.hydration.admitted", "pipeline.identity.ready",
                     "pipeline.process.start.timestamp"):
            self.assertIn(name, labels)
            self.assertEqual(labels[name], [])

    def test_no_instrument_is_silently_missing_from_the_dimension_map(self):
        # All 16 documented pipeline.* instruments must resolve to a dimension entry,
        # empty or not -- a name present in metrics() but absent from metric_labels()
        # would be a surface whose detail silently fell back to "no labels" for the
        # wrong reason (lookup miss, not a real absence of tags).
        texts = _metrics_texts()
        names = set()
        for text in texts.values():
            from skp.compile.csharp import literals_matching
            names.update(literals_matching(text, "pipeline."))
        labels = metric_labels(texts)
        self.assertEqual(names, set(labels))

    def test_route_domain_is_exactly_queue_and_fanout(self):
        by_id = {s.id: s for s in metrics(list(_metrics_texts().values()))}
        detail = by_id["prometheus.pipeline_messages_produced"].detail
        self.assertIn("route={fanout|queue}", detail)


@unittest.skipUnless(SRC.exists(), "run from inside the repo")
class LogAttributeRealSourceTests(unittest.TestCase):
    """Pins the brief's Part 2 real-source assertions."""

    def _surfaces(self):
        return log_attributes(
            read("tests/BaseApi.Tests/Live/Resilience/Templates.cs"),
            read("Messaging.Contracts/ExecutionLogScope.cs"),
            read("Messaging.Contracts/CorrelationKeys.cs"))

    def test_all_five_execution_log_scope_ids_are_present(self):
        ids = {s.id for s in self._surfaces()}
        for name in ("WorkflowId", "StepId", "ProcessorId", "ExecutionId", "EntryId"):
            self.assertIn(f"elasticsearch.attr.{name}", ids)

    def test_correlation_id_is_present_with_the_non_hyphenated_format(self):
        by_id = {s.id: s for s in self._surfaces()}
        self.assertIn("elasticsearch.attr.CorrelationId", by_id)
        self.assertIn('"N"', by_id["elasticsearch.attr.CorrelationId"].detail)

    def test_correlation_id_format_is_distinct_from_workflow_id_format(self):
        # The single most valuable fact this wave adds, verified against the real
        # ToString() calls rather than trusted from the brief's prose.
        by_id = {s.id: s for s in self._surfaces()}
        self.assertIn('"D"', by_id["elasticsearch.attr.WorkflowId"].detail)
        self.assertIn('"N"', by_id["elasticsearch.attr.CorrelationId"].detail)

    def test_result_is_present(self):
        ids = {s.id for s in self._surfaces()}
        self.assertIn("elasticsearch.attr.Result", ids)

    def test_placeholder_derived_attributes_include_elapsedms_and_successorcount(self):
        ids = {s.id for s in self._surfaces()}
        self.assertIn("elasticsearch.attr.ElapsedMs", ids)
        self.assertIn("elasticsearch.attr.SuccessorCount", ids)

    def test_no_two_surfaces_share_an_id_across_placeholders_scope_and_envelope(self):
        surfaces = self._surfaces()
        ids = [s.id for s in surfaces]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        self.assertEqual(duplicates, [], f"ids must be unique; collided: {duplicates}")
