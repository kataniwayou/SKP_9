import json
import time
import unittest
from datetime import datetime, timedelta, timezone

from skp.clients.http import Unreachable
from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_VERDICT
from skp.verbs import observe


class FakeRedis:
    def __init__(self, present_keys=(), values=None, members=None, fail=None):
        self.present = set(present_keys)
        self.values = values or {}
        self.members = members or {}
        self.fail = fail

    def keys(self, pattern):
        if self.fail:
            raise Unreachable("redis", self.fail)
        return [k for k in self.present if k == pattern]

    def get(self, key):
        if self.fail:
            raise Unreachable("redis", self.fail)
        return self.values.get(key, "")

    def smembers(self, key):
        if self.fail:
            raise Unreachable("redis", self.fail)
        return self.members.get(key, [])


class FakeRabbit:
    def __init__(self, queues=(), fail=None):
        self._queues = list(queues)
        self.fail = fail

    def queues(self):
        if self.fail:
            raise Unreachable("rabbitmq", self.fail)
        return self._queues


ENTRIES = [
    {"id": "redis.ParentIndex", "component": "redis", "operation": "read key", "detail": "skp:"},
    {"id": "redis.Root", "component": "redis", "operation": "read key", "detail": "skp:{workflowId}"},
    {"id": "redis.InstanceIndex", "component": "redis", "operation": "read key",
     "detail": "skp:proc:{processorId}"},
    {"id": "redis.PerInstance", "component": "redis", "operation": "read key",
     "detail": "skp:proc:{processorId}:{instanceId}"},
    {"id": "rabbitmq.orchestrator.Control", "component": "rabbitmq", "operation": "list_queues",
     "detail": "orchestrator-control"},
    {"id": "rabbitmq.orchestrator.Result", "component": "rabbitmq", "operation": "list_queues",
     "detail": "orchestrator-result"},
    {"id": "rabbitmq.orchestrator.ResultPost", "component": "rabbitmq", "operation": "list_queues",
     "detail": "orchestrator-result-post"},
    {"id": "rabbitmq.orchestrator.ControlDead", "component": "rabbitmq", "operation": "list_queues",
     "detail": "orchestrator-control.dead"},
    {"id": "rabbitmq.orchestrator.ResultDead", "component": "rabbitmq", "operation": "list_queues",
     "detail": "orchestrator-result.dead"},
    {"id": "rabbitmq.processor.Work", "component": "rabbitmq", "operation": "list_queues",
     "detail": "processor-{processorId}"},
    {"id": "rabbitmq.processor.Dead", "component": "rabbitmq", "operation": "list_queues",
     "detail": "processor-{processorId}.dead"},
    {"id": "prometheus.pipeline_queue_depth", "component": "prometheus",
     "operation": "instant query on pipeline.queue.depth", "detail": "labels: queue"},
]


class FillTests(unittest.TestCase):
    def test_fills_a_known_placeholder(self):
        self.assertEqual(observe._fill("skp:{workflowId}", workflowId="wf-1"), "skp:wf-1")

    def test_leaves_an_unsupplied_placeholder_alone(self):
        self.assertEqual(observe._fill("skp:proc:{processorId}:{instanceId}", processorId="p1"),
                         "skp:proc:p1:{instanceId}")


class LivenessRuleTests(unittest.TestCase):
    """The 2x-stale / 4x-present rule -- the exact cross-cutting check spec
    section 7 names, and the reason "absent" and "unhealthy" must never
    collapse into one reading.
    """

    def test_within_2x_the_interval_is_fresh(self):
        self.assertEqual(observe.liveness_rule(age_s=10, interval_s=10), "fresh")
        self.assertEqual(observe.liveness_rule(age_s=19, interval_s=10), "fresh")

    def test_between_2x_and_4x_is_stale_but_present(self):
        result = observe.liveness_rule(age_s=30, interval_s=10)
        self.assertIn("stale", result)
        self.assertIn("not yet gone", result)

    def test_past_4x_is_gone(self):
        self.assertIn("gone", observe.liveness_rule(age_s=41, interval_s=10))

    def test_unknown_age_is_reported_as_such_not_guessed(self):
        self.assertEqual(observe.liveness_rule(age_s=None, interval_s=10), "age unknown")

    def test_a_zero_interval_cannot_be_evaluated(self):
        self.assertIn("cannot evaluate", observe.liveness_rule(age_s=5, interval_s=0))


class AgeSecondsTests(unittest.TestCase):
    def test_parses_a_z_suffixed_iso_timestamp(self):
        now = datetime(2026, 8, 30, 12, 0, 0, tzinfo=timezone.utc)
        ts = (now - timedelta(seconds=42)).isoformat().replace("+00:00", "Z")
        age = observe._age_seconds(ts, now.timestamp())
        self.assertAlmostEqual(age, 42, delta=1)

    def test_an_unparseable_timestamp_yields_none_not_an_exception(self):
        self.assertIsNone(observe._age_seconds("not-a-date", time.time()))


class ProjectedTests(unittest.TestCase):
    def test_a_projected_workflow_is_ok(self):
        redis = FakeRedis(present_keys={"skp:wf-1"}, values={"skp:wf-1": '{"state":"running"}'})
        code, lines = observe.projected(ENTRIES, redis, workflow_id="wf-1")
        self.assertEqual(code, EXIT_OK)
        self.assertIn("projected", lines[0])

    def test_an_unprojected_workflow_is_a_verdict_not_an_empty_ok(self):
        redis = FakeRedis()
        code, lines = observe.projected(ENTRIES, redis, workflow_id="wf-ghost")
        self.assertEqual(code, EXIT_VERDICT)
        self.assertIn("NOT projected", lines[0])

    def test_unreachable_redis_is_reported_not_swallowed(self):
        redis = FakeRedis(fail="connection refused")
        code, lines = observe.projected(ENTRIES, redis, workflow_id="wf-1")
        self.assertEqual(code, EXIT_UNREACHABLE)

    def test_listing_all_projected_workflows_uses_the_parent_index(self):
        redis = FakeRedis(members={"skp:": ["wf-1", "wf-2"]})
        code, lines = observe.projected(ENTRIES, redis)
        self.assertEqual(code, EXIT_OK)
        self.assertIn("2 workflow(s)", lines[0])


class LivenessTests(unittest.TestCase):
    def test_no_instance_ever_registered_is_a_verdict(self):
        redis = FakeRedis()
        code, lines = observe.liveness(ENTRIES, redis, "proc-1", time.time())
        self.assertEqual(code, EXIT_VERDICT)

    def test_a_fresh_instance_is_reported_fresh(self):
        now = time.time()
        ts = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()
        value = json.dumps({"timestamp": ts, "interval": 1000, "status": "Healthy"})
        redis = FakeRedis(members={"skp:proc:proc-1": ["inst-1"]},
                          values={"skp:proc:proc-1:inst-1": value})
        code, lines = observe.liveness(ENTRIES, redis, "proc-1", now)
        self.assertEqual(code, EXIT_OK)
        self.assertIn("fresh", "\n".join(lines))

    def test_an_absent_instance_key_is_named_as_absent(self):
        redis = FakeRedis(members={"skp:proc:proc-1": ["inst-1"]})
        code, lines = observe.liveness(ENTRIES, redis, "proc-1", time.time())
        self.assertEqual(code, EXIT_OK)
        self.assertIn("absent", "\n".join(lines))


class QueuesTests(unittest.TestCase):
    def test_concrete_queues_report_depth_and_consumers(self):
        rabbit = FakeRabbit(queues=[{"name": "orchestrator-control", "messages": 2, "consumers": 1},
                                    {"name": "orchestrator-result", "messages": 0, "consumers": 3}])
        code, lines = observe.queues(ENTRIES, rabbit)
        self.assertEqual(code, EXIT_OK)
        joined = "\n".join(lines)
        self.assertIn("orchestrator-control", joined)
        self.assertIn("depth=2", joined)

    def test_a_processor_queue_is_included_when_asked_for(self):
        rabbit = FakeRabbit(queues=[{"name": "processor-p1", "messages": 0, "consumers": 1}])
        code, lines = observe.queues(ENTRIES, rabbit, processor_id="p1")
        self.assertIn("processor-p1", "\n".join(lines))

    def test_a_missing_queue_is_named_not_found(self):
        rabbit = FakeRabbit(queues=[])
        code, lines = observe.queues(ENTRIES, rabbit)
        self.assertIn("NOT FOUND", "\n".join(lines))


if __name__ == "__main__":
    unittest.main()
