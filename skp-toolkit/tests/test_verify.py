import json
import pathlib
import tempfile
import unittest

from skp.clients.http import Unreachable
from skp.profile import Profile
from skp.result import EXIT_OK, EXIT_UNREACHABLE, EXIT_VERDICT
from skp.verbs import verify


# ---------------------------------------------------------------------
# fakes
# ---------------------------------------------------------------------

class FakePostgres:
    def __init__(self, table_counts=None, errors=None):
        self.table_counts = table_counts or {}
        self.errors = errors or {}

    def ping(self):
        return True

    def rows(self, sql):
        # Matched on the quoted identifier deliberately: verify.check_postgres
        # must emit `FROM "table"`, not `FROM table` -- unquoted, Postgres
        # folds to lowercase and a PascalCase regression would silently pass.
        for table, err in self.errors.items():
            if f'"{table}"' in sql:
                raise Unreachable("postgres", err)
        for table, count in self.table_counts.items():
            if f'"{table}"' in sql:
                return [[str(count)]]
        raise Unreachable("postgres", f'ERROR:  relation "?" does not exist' + chr(10) + sql)


class FakeRabbit:
    def __init__(self, queue_names=(), fail=None):
        self._names = list(queue_names)
        self._fail = fail

    def ping(self):
        return True

    def queues(self):
        if self._fail:
            raise Unreachable("rabbitmq", self._fail)
        return [{"name": n, "messages": 0, "consumers": 1} for n in self._names]


class FakeHttp:
    def __init__(self, ok_paths=(), status_by_path=None):
        self.ok_paths = set(ok_paths)
        self.status_by_path = status_by_path or {}

    def get_json(self, path, params=None):
        if path in self.status_by_path:
            raise Unreachable("http", f"HTTP {self.status_by_path[path]} for {path}")
        if path in self.ok_paths:
            return {}
        raise Unreachable("http", f"connection refused for {path}")


class FakeElastic:
    def __init__(self, http, hits=()):
        self.http = http
        self._hits = list(hits)

    def ready(self):
        return True

    def search(self, body):
        return self._hits


class FakePrometheus:
    def __init__(self, series_by_prefix=None):
        self._series_by_prefix = series_by_prefix or {}

    def ready(self):
        return True

    def query(self, expr):
        for prefix, series in self._series_by_prefix.items():
            if prefix in expr:
                return series
        return []


class FakeRedis:
    def __init__(self, keys_by_pattern=None, fail=None):
        self._keys_by_pattern = keys_by_pattern or {}
        self._fail = fail

    def ping(self):
        return True

    def keys(self, pattern):
        if self._fail:
            raise Unreachable("redis", self._fail)
        return self._keys_by_pattern.get(pattern, [])


class FakeRawCluster:
    def __init__(self, outputs=None, fail_on=()):
        self._outputs = outputs or {}
        self._fail_on = set(fail_on)
        self.calls = []

    def run(self, argv, target="cluster"):
        self.calls.append(argv)
        key = argv[0]
        if key in self._fail_on:
            raise Unreachable(target, f"{key} failed")
        return self._outputs.get(key, "")


class FakeClusterProbe:
    """Matches init.ClusterProbe's shape: .ping() plus a .cluster attribute
    verify.check_cluster reaches through to issue read-only commands."""

    def __init__(self, raw, ok=True):
        self.cluster = raw
        self._ok = ok

    def ping(self):
        return self._ok


class Probeable:
    def __init__(self, ok=True, detail=""):
        self._ok = ok
        self.last_error = detail

    def ping(self):
        return self._ok

    ready = ping


def make_clients(**overrides):
    base = {
        "cluster": FakeClusterProbe(FakeRawCluster()),
        "postgres": FakePostgres(),
        "redis": FakeRedis(),
        "rabbitmq": FakeRabbit(),
        "elasticsearch": FakeElastic(FakeHttp()),
        "prometheus": FakePrometheus(),
        "baseapi": FakeElastic(FakeHttp()),  # placeholder swapped by tests that need it
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------
# parse_metric_detail
# ---------------------------------------------------------------------

class ParseMetricDetailTests(unittest.TestCase):
    def test_labels_are_recovered_with_domains_stripped(self):
        detail = ("pipeline.consumer.duration | labels: queue, type, "
                  "disposition={acked|requeued|parked}, role (method scope)")
        name, labels = verify.parse_metric_detail(detail)
        self.assertEqual(name, "pipeline.consumer.duration")
        self.assertEqual(labels, ["queue", "type", "disposition", "role"])

    def test_no_labels_is_an_empty_list_not_None(self):
        detail = "pipeline.gate.open | no labels (method scope -- this instrument carries no tags)"
        name, labels = verify.parse_metric_detail(detail)
        self.assertEqual(name, "pipeline.gate.open")
        self.assertEqual(labels, [])

    def test_no_call_site_found_is_None_not_empty(self):
        detail = "pipeline.something | no call site found -- labels not determined"
        name, labels = verify.parse_metric_detail(detail)
        self.assertEqual(name, "pipeline.something")
        self.assertIsNone(labels)


# ---------------------------------------------------------------------
# postgres
# ---------------------------------------------------------------------

class PostgresChecksTests(unittest.TestCase):
    def entry(self, table):
        return {"id": f"postgres.{table}", "component": "postgres",
               "operation": f"SELECT ... FROM {table}", "detail": "x"}

    def test_a_real_table_is_confirmed_with_its_row_count(self):
        claims = verify.check_postgres([self.entry("workflows")],
                                       FakePostgres(table_counts={"workflows": 7}))
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)
        self.assertIn("7", claims[0].message)

    def test_a_missing_relation_is_refuted_not_unverifiable(self):
        client = FakePostgres(errors={"assignments": 'ERROR:  relation "assignments" does not exist'})
        claims = verify.check_postgres([self.entry("assignments")], client)
        self.assertEqual(claims[0].verdict, verify.REFUTED)
        self.assertIn("assignments", claims[0].message)

    def test_a_non_relation_error_is_unverifiable_not_refuted(self):
        client = FakePostgres(errors={"steps": "ERROR:  permission denied for table steps"})
        claims = verify.check_postgres([self.entry("steps")], client)
        self.assertEqual(claims[0].verdict, verify.UNVERIFIABLE)

    def test_a_pascalcase_regression_is_refuted_not_confirmed(self):
        """The C1 defect this verb exists to catch: if the catalog ever
        regressed to the PascalCase DbSet property name, an unquoted query
        would have Postgres fold it to lowercase and silently CONFIRM the
        wrong claim. FakePostgres mirrors real Postgres's own case-sensitive
        quoted-identifier behaviour: it only recognises "assignments"
        (lowercase, the real table), never "Assignments" -- so this table
        counts as absent, and a quoted query for "Assignments" must be
        REFUTED, not CONFIRMED via a case-insensitive fold."""
        client = FakePostgres(table_counts={"assignments": 23})
        claims = verify.check_postgres([self.entry("Assignments")], client)
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_the_emitted_sql_quotes_the_identifier(self):
        """Pins the fix itself: a future edit that drops the quoting and
        restores the blind spot must fail this test even if every fake
        happens to still pass."""
        captured = []

        class RecordingPostgres:
            def rows(self, sql):
                captured.append(sql)
                return [["1"]]

        verify.check_postgres([self.entry("workflows")], RecordingPostgres())
        self.assertEqual(len(captured), 1)
        self.assertIn('"workflows"', captured[0])
        self.assertNotIn("FROM workflows", captured[0])


# ---------------------------------------------------------------------
# rabbitmq
# ---------------------------------------------------------------------

class RabbitChecksTests(unittest.TestCase):
    def entry(self, local_id, detail):
        return {"id": f"rabbitmq.orchestrator.{local_id}", "component": "rabbitmq",
               "operation": "list_queues", "detail": detail}

    def test_a_live_queue_is_confirmed(self):
        entries = [self.entry("Control", "orchestrator-control")]
        claims = verify.check_rabbitmq(entries, FakeRabbit(queue_names=["orchestrator-control"]))
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_missing_queue_is_refuted(self):
        entries = [self.entry("Control", "orchestrator-control")]
        claims = verify.check_rabbitmq(entries, FakeRabbit(queue_names=[]))
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_a_templated_name_is_skipped_as_not_applicable(self):
        entries = [self.entry("Work", "processor-{processorId}")]
        claims = verify.check_rabbitmq(entries, FakeRabbit(queue_names=[]))
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)

    def test_a_dead_letter_exchange_is_skipped_as_not_applicable(self):
        entries = [self.entry("DeadLetterExchange", "orchestrator-dlx")]
        claims = verify.check_rabbitmq(entries, FakeRabbit(queue_names=[]))
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)


# ---------------------------------------------------------------------
# elasticsearch
# ---------------------------------------------------------------------

class ElasticsearchChecksTests(unittest.TestCase):
    def test_the_index_is_confirmed_when_it_exists(self):
        entries = [{"id": "elasticsearch.index", "component": "elasticsearch",
                   "operation": "default data stream: logs-generic.otel-default", "detail": "x"}]
        client = FakeElastic(FakeHttp(ok_paths={"/logs-generic.otel-default"}))
        claims = verify.check_elasticsearch(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_404_index_is_refuted(self):
        entries = [{"id": "elasticsearch.index", "component": "elasticsearch",
                   "operation": "default data stream: logs-generic-default", "detail": "x"}]
        client = FakeElastic(FakeHttp(status_by_path={"/logs-generic-default": 404}))
        claims = verify.check_elasticsearch(entries, client)
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_an_attribute_present_in_the_sample_is_confirmed(self):
        entries = [{"id": "elasticsearch.attr.WorkflowId", "component": "elasticsearch",
                   "operation": "search by attributes.WorkflowId", "detail": "x"}]
        client = FakeElastic(FakeHttp(), hits=[{"attributes": {"WorkflowId": "abc"}}])
        claims = verify.check_elasticsearch(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_fault_path_attribute_absent_from_the_sample_is_not_observed_not_refuted(self):
        entries = [{"id": "elasticsearch.attr.Queue", "component": "elasticsearch",
                   "operation": "search by attributes.Queue", "detail": "x"}]
        client = FakeElastic(FakeHttp(), hits=[{"attributes": {"WorkflowId": "abc"}}])
        claims = verify.check_elasticsearch(entries, client)
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)

    def test_a_message_template_is_not_applicable(self):
        entries = [{"id": "elasticsearch.EntryDispatched", "component": "elasticsearch",
                   "operation": "search by attributes.{OriginalFormat}",
                   "detail": "entry step {StepId} dispatched"}]
        client = FakeElastic(FakeHttp(), hits=[])
        claims = verify.check_elasticsearch(entries, client)
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)

    def test_a_nested_resource_attribute_path_is_resolved(self):
        entries = [{"id": "elasticsearch.attr.service_instance_id", "component": "elasticsearch",
                   "operation": "read resource.attributes.service.instance.id", "detail": "x"}]
        hit = {"resource": {"attributes": {"service.instance.id": "replica-1"}}}
        client = FakeElastic(FakeHttp(), hits=[hit])
        claims = verify.check_elasticsearch(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)


# ---------------------------------------------------------------------
# prometheus
# ---------------------------------------------------------------------

class PrometheusChecksTests(unittest.TestCase):
    def test_every_claimed_label_present_is_confirmed(self):
        entries = [{"id": "prometheus.pipeline_consumer_duration", "component": "prometheus",
                   "operation": "instant query on pipeline.consumer.duration",
                   "detail": "pipeline.consumer.duration | labels: queue, type (method scope)"}]
        series = [{"metric": {"__name__": "pipeline_consumer_duration_bucket",
                              "queue": "orchestrator-control", "type": "start", "le": "0.1"}}]
        client = FakePrometheus(series_by_prefix={"pipeline_consumer_duration": series})
        claims = verify.check_prometheus(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_claimed_but_absent_label_is_refuted(self):
        entries = [{"id": "prometheus.pipeline_consumer_duration", "component": "prometheus",
                   "operation": "instant query on pipeline.consumer.duration",
                   "detail": "pipeline.consumer.duration | labels: queue, source (method scope)"}]
        series = [{"metric": {"__name__": "pipeline_consumer_duration_bucket", "queue": "q"}}]
        client = FakePrometheus(series_by_prefix={"pipeline_consumer_duration": series})
        claims = verify.check_prometheus(entries, client)
        self.assertEqual(claims[0].verdict, verify.REFUTED)
        self.assertIn("source", claims[0].message)

    def test_zero_live_series_is_not_observed_not_refuted(self):
        entries = [{"id": "prometheus.pipeline_gate_open", "component": "prometheus",
                   "operation": "instant query on pipeline.gate.open",
                   "detail": "pipeline.gate.open | no labels (method scope -- this instrument carries no tags)"}]
        client = FakePrometheus(series_by_prefix={})
        claims = verify.check_prometheus(entries, client)
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)

    def test_a_resource_label_seen_on_an_instrument_series_is_confirmed(self):
        entries = [
            {"id": "prometheus.pipeline_consumer_duration", "component": "prometheus",
             "operation": "instant query on pipeline.consumer.duration",
             "detail": "pipeline.consumer.duration | labels: queue (method scope)"},
            {"id": "prometheus.label.service_instance_id", "component": "prometheus",
             "operation": "resource attribute service.instance.id", "detail": "x"},
        ]
        series = [{"metric": {"__name__": "pipeline_consumer_duration_bucket",
                              "queue": "q", "service_instance_id": "r1"}}]
        client = FakePrometheus(series_by_prefix={"pipeline_consumer_duration": series})
        claims = verify.check_prometheus(entries, client)
        by_id = {c.surface_id: c for c in claims}
        self.assertEqual(by_id["prometheus.label.service_instance_id"].verdict, verify.CONFIRMED)

    def test_a_resource_label_never_seen_is_not_observed(self):
        entries = [{"id": "prometheus.label.processorId", "component": "prometheus",
                   "operation": "resource attribute processorId", "detail": "x"}]
        client = FakePrometheus(series_by_prefix={})
        claims = verify.check_prometheus(entries, client)
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)


# ---------------------------------------------------------------------
# api
# ---------------------------------------------------------------------

class ApiChecksTests(unittest.TestCase):
    def entry(self, entity, verb_id, operation):
        return {"id": f"api.{entity}.{verb_id}", "component": "api",
               "operation": operation, "detail": entity}

    def test_a_200_get_is_confirmed(self):
        entries = [self.entry("workflows", "get", "GET /api/v1.0/workflows")]
        api_client = _ApiFake(FakeHttp(ok_paths={"/api/v1.0/workflows"}))
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_404_get_is_refuted(self):
        entries = [self.entry("workflows", "get", "GET /api/v1.0/workflows")]
        api_client = _ApiFake(FakeHttp(status_by_path={"/api/v1.0/workflows": 404}))
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_a_get_with_a_path_parameter_is_not_applicable(self):
        entries = [self.entry("workflows", "get_id", "GET /api/v1.0/workflows/{id}")]
        api_client = _ApiFake(FakeHttp())
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)

    def test_a_post_route_is_not_applicable(self):
        entries = [self.entry("workflows", "post", "POST /api/v1.0/workflows")]
        api_client = _ApiFake(FakeHttp())
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)


class _ApiFake:
    def __init__(self, http):
        self.http = http

    def ready(self):
        return True


# ---------------------------------------------------------------------
# redis
# ---------------------------------------------------------------------

class RedisChecksTests(unittest.TestCase):
    def test_a_populated_key_family_is_confirmed(self):
        entries = [{"id": "redis.Root", "component": "redis", "operation": "read key",
                   "detail": "skp:{workflowId}"}]
        client = FakeRedis(keys_by_pattern={"skp:*": ["skp:1"]})
        claims = verify.check_redis(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_an_empty_key_family_is_not_observed_not_refuted(self):
        entries = [{"id": "redis.ExecutionData", "component": "redis", "operation": "read key",
                   "detail": "skp:data:{stepId}"}]
        client = FakeRedis(keys_by_pattern={})
        claims = verify.check_redis(entries, client)
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)


# ---------------------------------------------------------------------
# cluster
# ---------------------------------------------------------------------

class ClusterChecksTests(unittest.TestCase):
    ENTRIES = [
        {"id": "cluster.get_pods", "component": "cluster", "operation": "x", "detail": "x"},
        {"id": "cluster.get_json", "component": "cluster", "operation": "x", "detail": "x"},
        {"id": "cluster.rollout_status", "component": "cluster", "operation": "x", "detail": "x"},
        {"id": "cluster.logs", "component": "cluster", "operation": "x", "detail": "x"},
    ]

    def test_a_healthy_cluster_confirms_every_operation(self):
        raw = FakeRawCluster(outputs={"get": "pod/postgres-0"})
        claims = verify.check_cluster(self.ENTRIES, raw)
        by_id = {c.surface_id: c for c in claims}
        for entry in self.ENTRIES:
            self.assertEqual(by_id[entry["id"]].verdict, verify.CONFIRMED, entry["id"])

    def test_a_failing_operation_is_unverifiable_not_refuted(self):
        raw = FakeRawCluster(outputs={"get": "pod/postgres-0"}, fail_on={"logs"})
        claims = verify.check_cluster(self.ENTRIES, raw)
        by_id = {c.surface_id: c for c in claims}
        self.assertEqual(by_id["cluster.logs"].verdict, verify.UNVERIFIABLE)


# ---------------------------------------------------------------------
# verify_all -- component-level reachability gating
# ---------------------------------------------------------------------

class ExplodingPostgres:
    def rows(self, sql):
        raise AssertionError("an unreachable component must not be queried at all")


class VerifyAllTests(unittest.TestCase):
    CATALOG = [
        {"id": "postgres.workflows", "component": "postgres",
         "operation": "SELECT ... FROM workflows", "detail": "x"},
        {"id": "redis.Root", "component": "redis", "operation": "read key", "detail": "skp:{id}"},
    ]

    def test_an_unreachable_component_marks_every_one_of_its_claims_unverifiable_without_querying(self):
        clients = make_clients(redis=FakeRedis(keys_by_pattern={"skp:*": ["k"]}))
        # ExplodingPostgres exposes neither ping() nor ready(): probe() reports it
        # unreachable (see init.probe's own AttributeError branch) without ever calling
        # .rows() -- so a real query only happens if verify_all skipped the gate.
        clients["postgres"] = ExplodingPostgres()
        claims = verify.verify_all(self.CATALOG, clients)
        pg_claims = [c for c in claims if c.component == "postgres"]
        self.assertTrue(pg_claims)
        self.assertTrue(all(c.verdict == verify.UNVERIFIABLE for c in pg_claims))

    def test_a_reachable_component_is_actually_queried(self):
        clients = make_clients(postgres=FakePostgres(table_counts={"workflows": 3}),
                               redis=FakeRedis(keys_by_pattern={"skp:*": ["k"]}))
        claims = verify.verify_all(self.CATALOG, clients)
        by_id = {c.surface_id: c for c in claims}
        self.assertEqual(by_id["postgres.workflows"].verdict, verify.CONFIRMED)
        self.assertEqual(by_id["redis.Root"].verdict, verify.CONFIRMED)

    def test_component_filter_checks_only_the_named_component(self):
        clients = make_clients(postgres=FakePostgres(table_counts={"workflows": 3}))
        claims = verify.verify_all(self.CATALOG, clients, component="postgres")
        self.assertTrue(all(c.component == "postgres" for c in claims))


# ---------------------------------------------------------------------
# run_with -- the exit-code contract
# ---------------------------------------------------------------------

class RunWithExitCodeTests(unittest.TestCase):
    def test_not_observed_alone_does_not_fail_the_command(self):
        """The central guarantee: collapsing NOT_OBSERVED into REFUTED would make this
        verb cry wolf. An empty (but reachable) key family must exit clean."""
        catalog = [{"id": "redis.ExecutionData", "component": "redis", "operation": "read key",
                   "detail": "skp:data:{stepId}"}]
        clients = make_clients(redis=FakeRedis(keys_by_pattern={}))
        result = verify.run_with(catalog, clients)
        self.assertEqual(result.code, EXIT_OK)

    def test_a_refutation_fails_the_command(self):
        catalog = [{"id": "postgres.assignments", "component": "postgres",
                   "operation": "SELECT ... FROM assignments", "detail": "x"}]
        clients = make_clients(postgres=FakePostgres(
            errors={"assignments": 'ERROR:  relation "assignments" does not exist'}))
        result = verify.run_with(catalog, clients)
        self.assertEqual(result.code, EXIT_VERDICT)
        self.assertIn("NEXT:", result.render())

    def test_an_unreachable_store_with_no_refutation_is_unverifiable_not_verdict(self):
        catalog = [{"id": "postgres.workflows", "component": "postgres",
                   "operation": "SELECT ... FROM workflows", "detail": "x"}]
        clients = make_clients(postgres=Probeable(False, "connection refused"))
        result = verify.run_with(catalog, clients)
        self.assertEqual(result.code, EXIT_UNREACHABLE)
        self.assertIn("NEXT:", result.render())

    def test_a_refutation_beats_an_unrelated_unreachable_component(self):
        """REFUTED must win the exit code even when another component is down --
        a real defect is more actionable than a store being offline."""
        catalog = [
            {"id": "postgres.assignments", "component": "postgres",
             "operation": "SELECT ... FROM assignments", "detail": "x"},
            {"id": "redis.Root", "component": "redis", "operation": "read key", "detail": "skp:{id}"},
        ]
        clients = make_clients(
            postgres=FakePostgres(errors={"assignments": 'ERROR:  relation "assignments" does not exist'}),
            redis=Probeable(False, "connection refused"))
        result = verify.run_with(catalog, clients)
        self.assertEqual(result.code, EXIT_VERDICT)


# ---------------------------------------------------------------------
# run() -- argv wiring
# ---------------------------------------------------------------------

class RunTests(unittest.TestCase):
    def test_no_memory_folder_is_not_initialised(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = verify.run(["--home", str(pathlib.Path(tmp) / ".skp")])
        from skp.result import EXIT_NOT_INITIALISED
        self.assertEqual(result.code, EXIT_NOT_INITIALISED)

    def test_a_profile_with_no_compiled_catalog_is_not_compiled(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp) / ".skp"
            Profile(home=home, source_root="/src", cluster_url="https://c",
                    project="skp", endpoints={}).save(token="")
            result = verify.run(["--home", str(home)])
        from skp.result import EXIT_NOT_INITIALISED
        self.assertEqual(result.code, EXIT_NOT_INITIALISED)

    def test_an_unknown_component_is_a_usage_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp) / ".skp"
            Profile(home=home, source_root="/src", cluster_url="https://c",
                    project="skp", endpoints={}).save(token="")
            (home / "model" / "catalog.json").write_text("[]", encoding="utf-8")
            with self.assertRaises(SystemExit):
                verify.run(["--home", str(home), "--component", "nope"])


if __name__ == "__main__":
    unittest.main()
