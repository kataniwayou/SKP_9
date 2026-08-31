import json
import pathlib
import re
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
    def __init__(self, queue_names=(), exchange_names=(), fail=None, exchanges_fail=None):
        self._names = list(queue_names)
        self._exchange_names = list(exchange_names)
        self._fail = fail
        self._exchanges_fail = exchanges_fail

    def ping(self):
        return True

    def queues(self):
        if self._fail:
            raise Unreachable("rabbitmq", self._fail)
        return [{"name": n, "messages": 0, "consumers": 1} for n in self._names]

    def exchanges(self):
        if self._exchanges_fail:
            raise Unreachable("rabbitmq", self._exchanges_fail)
        return [{"name": n} for n in self._exchange_names]


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


def _flatten(obj, prefix=""):
    """Test-side twin of the real (now-retired) verify._flatten_paths --
    still needed here so FakeElastic.exists() can answer an ``exists``
    filter against a nested hit the same way the real per-document flatten
    used to."""
    paths = {}
    if isinstance(obj, dict):
        for key, value in obj.items():
            path = f"{prefix}.{key}" if prefix else key
            paths[path] = value
            paths.update(_flatten(value, path))
    return paths


class FakeElastic:
    """Deliberately shallow for ``term``/``prefix`` clauses (any non-empty
    ``hits`` confirms a template -- these tests pin wire-level behaviour, not
    real ES matching semantics) but does honour ``exists`` clauses by field
    path, because the fault-path-attribute tests specifically need "hits
    present, but not for *this* field" to distinguish CONFIRMED from
    NOT_OBSERVED.
    """
    def __init__(self, http, hits=()):
        self.http = http
        self._hits = list(hits)

    def ready(self):
        return True

    def search(self, body):
        return self._hits

    def exists(self, filter_clauses):
        for clause in filter_clauses:
            if "exists" in clause:
                field = clause["exists"]["field"]
                if not any(field in _flatten(hit) for hit in self._hits):
                    return False
            elif not self._hits:
                return False
        return True


class FakePrometheus:
    def __init__(self, series_by_prefix=None, range_series_by_prefix=None):
        self._series_by_prefix = series_by_prefix or {}
        # Answered only by a count_over_time(...) query -- the range existence
        # fallback check_prometheus makes when the instant query above finds
        # nothing, so a test can tell "never observed" apart from "not at
        # this instant" without hand-parsing the expr.
        self._range_series_by_prefix = range_series_by_prefix or {}

    def ready(self):
        return True

    def query(self, expr):
        table = self._range_series_by_prefix if expr.startswith("count_over_time(") \
            else self._series_by_prefix
        for prefix, series in table.items():
            if prefix in expr:
                return series
        return []


class RegexAwarePrometheus:
    """Answers a query by actually running its ``__name__=~"..."`` selector
    as a regex against a fixed table of live series names, rather than a
    substring match on the raw expr text -- the only fake faithful enough to
    pin the OTel unit-suffix regression (a real Prometheus series name like
    ``pipeline_consumer_duration_seconds_bucket`` was invisible to a query
    that only alternated the Prometheus type suffix)."""

    def __init__(self, series_by_name: dict[str, list[dict]]):
        self._series_by_name = series_by_name

    def ready(self):
        return True

    def query(self, expr):
        match = re.search(r'__name__=~"([^"]+)"', expr)
        if not match:
            return []
        # A real Prometheus server unescapes the PromQL string literal (Go
        # string rules) before handing the result to the regex engine, so a
        # literal single-backslash \w for the regex has to arrive doubled on
        # the wire (\\w) -- collapse that the same way here, or this fake
        # would accept a query real Prometheus 400s on (confirmed live,
        # 2026-08-30: an un-doubled \w in the query text is a parse error,
        # not a working-but-different regex).
        pattern = re.compile(match.group(1).replace("\\\\", "\\"))
        result = []
        for name, label_sets in self._series_by_name.items():
            if pattern.match(name):
                for labels in label_sets:
                    result.append({"metric": {"__name__": name, **labels}})
        return result


class RangeOnlyPrometheus(RegexAwarePrometheus):
    """Like RegexAwarePrometheus, but only for a count_over_time(...) query --
    every plain instant query finds nothing, pinning the range-existence
    fallback itself rather than the regex fix."""

    def query(self, expr):
        if not expr.startswith("count_over_time("):
            return []
        return super().query(expr)


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
        "baseapi": FakeBaseApi(FakeHttp()),  # placeholder swapped by tests that need it
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

    def test_a_templated_name_with_no_resolvable_ids_is_unverifiable(self):
        """processor_ids=None means the caller (verify_all) could not resolve
        any real id at all -- both the API and Postgres were unreachable.
        That is a gap in what this run could check, not a skip."""
        entries = [self.entry("Work", "processor-{processorId}")]
        claims = verify.check_rabbitmq(entries, FakeRabbit(queue_names=[]), processor_ids=None)
        self.assertEqual(claims[0].verdict, verify.UNVERIFIABLE)

    def test_a_templated_name_with_zero_registered_processors_is_not_observed(self):
        entries = [self.entry("Work", "processor-{processorId}")]
        claims = verify.check_rabbitmq(entries, FakeRabbit(queue_names=[]), processor_ids=[])
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)

    def test_a_resolved_templated_name_present_for_every_processor_is_confirmed(self):
        entries = [self.entry("Work", "processor-{processorId}")]
        rabbit = FakeRabbit(queue_names=["processor-abc", "processor-def"])
        claims = verify.check_rabbitmq(entries, rabbit, processor_ids=["abc", "def"])
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_resolved_templated_name_genuinely_absent_is_refuted_not_a_skip(self):
        """The whole point of resolving a template: once it names a real,
        concrete queue, an absent one is a real defect, not NOT_APPLICABLE."""
        entries = [self.entry("Work", "processor-{processorId}")]
        rabbit = FakeRabbit(queue_names=["processor-abc"])  # "def" never registered
        claims = verify.check_rabbitmq(entries, rabbit, processor_ids=["abc", "def"])
        self.assertEqual(claims[0].verdict, verify.REFUTED)
        self.assertIn("processor-def", claims[0].message)

    def test_a_live_dead_letter_exchange_is_confirmed(self):
        entries = [self.entry("DeadLetterExchange", "orchestrator-dlx")]
        rabbit = FakeRabbit(queue_names=[], exchange_names=["orchestrator-dlx"])
        claims = verify.check_rabbitmq(entries, rabbit)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_missing_dead_letter_exchange_is_refuted(self):
        entries = [self.entry("DeadLetterExchange", "orchestrator-dlx")]
        rabbit = FakeRabbit(queue_names=[], exchange_names=[])
        claims = verify.check_rabbitmq(entries, rabbit)
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_list_exchanges_failing_is_unverifiable_not_refuted(self):
        entries = [self.entry("DeadLetterExchange", "orchestrator-dlx")]
        rabbit = FakeRabbit(queue_names=[], exchanges_fail="permission denied")
        claims = verify.check_rabbitmq(entries, rabbit)
        self.assertEqual(claims[0].verdict, verify.UNVERIFIABLE)


# ---------------------------------------------------------------------
# rabbitmq -- Gap 3: actionable REFUTED (orphans + deployment status)
# ---------------------------------------------------------------------

PID1 = "11111111-1111-1111-1111-111111111111"
PID2 = "22222222-2222-2222-2222-222222222222"
ORPHAN_GUID = "99999999-9999-9999-9999-999999999999"


class RabbitOrphanAndDeploymentTests(unittest.TestCase):
    def entry(self, local_id, detail):
        return {"id": f"rabbitmq.processor.{local_id}", "component": "rabbitmq",
               "operation": "list_queues", "detail": detail}

    def test_broker_side_orphan_queues_are_named_in_a_confirmed_claim(self):
        """Both live processors have their queue, but a stray queue on the
        broker matches no processors row at all -- the reverse of the usual
        catalog-side check, and it must not be silently dropped just because
        every catalogued claim itself confirms."""
        entries = [self.entry("Work", "processor-{processorId}")]
        rabbit = FakeRabbit(queue_names=[f"processor-{PID1}", f"processor-{PID2}",
                                         f"processor-{ORPHAN_GUID}.dead"])
        claims = verify.check_rabbitmq(entries, rabbit, processor_ids=[PID1, PID2])
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)
        self.assertIn(f"processor-{ORPHAN_GUID}.dead", claims[0].message)
        self.assertIn("no processors row", claims[0].message)

    def test_broker_side_orphan_queues_are_named_alongside_a_refuted_claim(self):
        entries = [self.entry("Work", "processor-{processorId}")]
        rabbit = FakeRabbit(queue_names=[f"processor-{ORPHAN_GUID}"])  # PID1 missing entirely
        claims = verify.check_rabbitmq(entries, rabbit, processor_ids=[PID1])
        self.assertEqual(claims[0].verdict, verify.REFUTED)
        self.assertIn(f"processor-{ORPHAN_GUID}", claims[0].message)
        self.assertIn("no processors row", claims[0].message)

    def test_a_missing_queue_for_a_never_registered_processor_says_so(self):
        """No skp:proc:<id> key anywhere -- this processor row has never
        seen a live replica, so the remedy is deploy, not investigate."""
        entries = [self.entry("Work", "processor-{processorId}")]
        rabbit = FakeRabbit(queue_names=[])
        redis = FakeRedis(keys_by_pattern={})
        claims = verify.check_rabbitmq(entries, rabbit, processor_ids=[PID1], redis_client=redis)
        self.assertEqual(claims[0].verdict, verify.REFUTED)
        self.assertIn("never registered a replica", claims[0].message)
        self.assertIn("never deployed", claims[0].message)

    def test_a_missing_queue_for_a_previously_registered_processor_says_so(self):
        """skp:proc:<id> exists -- a replica registered at some point, so the
        queue existed and was removed; the remedy is cleanup, not deploy."""
        entries = [self.entry("Work", "processor-{processorId}")]
        rabbit = FakeRabbit(queue_names=[])
        redis = FakeRedis(keys_by_pattern={f"skp:proc:{PID1}": [f"skp:proc:{PID1}:pod-1"]})
        claims = verify.check_rabbitmq(entries, rabbit, processor_ids=[PID1], redis_client=redis)
        self.assertEqual(claims[0].verdict, verify.REFUTED)
        self.assertIn("registered at least one replica", claims[0].message)
        self.assertIn("its queue existed and was removed", claims[0].message)

    def test_deployment_status_is_unknown_when_redis_is_unreachable(self):
        entries = [self.entry("Work", "processor-{processorId}")]
        rabbit = FakeRabbit(queue_names=[])
        claims = verify.check_rabbitmq(entries, rabbit, processor_ids=[PID1], redis_client=None)
        self.assertEqual(claims[0].verdict, verify.REFUTED)
        self.assertIn("deployment status unknown", claims[0].message)


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

    def test_a_message_template_seen_at_least_once_is_confirmed(self):
        entries = [{"id": "elasticsearch.EntryDispatched", "component": "elasticsearch",
                   "operation": "search by attributes.{OriginalFormat}",
                   "detail": "entry step {StepId} dispatched"}]
        client = FakeElastic(FakeHttp(), hits=[{"attributes": {"StepId": "s1"}}])
        claims = verify.check_elasticsearch(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_message_template_never_seen_is_not_observed_not_applicable(self):
        """22 of 26 templates fire on a healthy system; a handful (fault-path
        records like RefusingAndParking) legitimately never do -- absence is
        a fact worth reporting, not a reason to skip the check."""
        entries = [{"id": "elasticsearch.RefusingAndParking", "component": "elasticsearch",
                   "operation": "search by attributes.{OriginalFormat}",
                   "detail": "refusing and parking {EntryId}"}]
        client = FakeElastic(FakeHttp(), hits=[])
        claims = verify.check_elasticsearch(entries, client)
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)

    def test_an_em_dash_template_is_queried_with_a_prefix_not_an_exact_term(self):
        """Pins the reuse of investigate._original_format_filter: TerminalCompleted's
        em dash arrives mangled through the OTel pipeline, so an exact term match
        silently finds nothing even though the record is right there."""
        captured = []

        class RecordingElastic:
            def exists(self, filter_clauses):
                captured.append(filter_clauses)
                return False

        entries = [{"id": "elasticsearch.TerminalCompleted", "component": "elasticsearch",
                   "operation": "search by attributes.{OriginalFormat}",
                   "detail": "the workflow terminated — completed"}]
        verify.check_elasticsearch(entries, RecordingElastic())
        self.assertEqual(len(captured), 1)
        query = captured[0][0]
        self.assertIn("prefix", query)
        self.assertEqual(query["prefix"]["attributes.{OriginalFormat}"], "the workflow terminated ")

    def test_message_template_existence_query_uses_the_full_template_as_a_term(self):
        """check_elasticsearch delegates the existence question to
        Elastic.exists() -- itself pinned bounded (size=0, track_total_hits=1)
        in ElasticTests -- rather than building a search body here, so this
        only needs to pin the filter clause shape it hands over."""
        captured = []

        class RecordingElastic:
            def exists(self, filter_clauses):
                captured.append(filter_clauses)
                return False

        entries = [{"id": "elasticsearch.EntryDispatched", "component": "elasticsearch",
                   "operation": "search by attributes.{OriginalFormat}",
                   "detail": "entry step {StepId} dispatched"}]
        verify.check_elasticsearch(entries, RecordingElastic())
        self.assertEqual(captured[0], [{"term": {"attributes.{OriginalFormat}":
                                                  "entry step {StepId} dispatched"}}])

    def test_a_template_never_found_across_full_retention_names_the_window(self):
        entries = [{"id": "elasticsearch.RefusingAndParking", "component": "elasticsearch",
                   "operation": "search by attributes.{OriginalFormat}",
                   "detail": "refusing and parking {EntryId}"}]

        class NeverFound:
            def exists(self, filter_clauses):
                return False

        claims = verify.check_elasticsearch(entries, NeverFound())
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)
        self.assertIn(verify.RETENTION_NOTE, claims[0].message)

    def test_an_attribute_existence_query_uses_the_attribute_path(self):
        captured = []

        class RecordingElastic:
            def exists(self, filter_clauses):
                captured.append(filter_clauses)
                return True

        entries = [{"id": "elasticsearch.attr.Queue", "component": "elasticsearch",
                   "operation": "search by attributes.Queue", "detail": "x"}]
        claims = verify.check_elasticsearch(entries, RecordingElastic())
        self.assertEqual(captured[0], [{"exists": {"field": "attributes.Queue"}}])
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_an_elasticsearch_existence_query_failure_is_unverifiable(self):
        class Failing:
            def exists(self, filter_clauses):
                raise Unreachable("elasticsearch", "timeout")

        entries = [{"id": "elasticsearch.attr.Queue", "component": "elasticsearch",
                   "operation": "search by attributes.Queue", "detail": "x"}]
        claims = verify.check_elasticsearch(entries, Failing())
        self.assertEqual(claims[0].verdict, verify.UNVERIFIABLE)

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

    def test_an_otel_unit_suffixed_series_name_is_matched(self):
        """Pins the regression this file exists to catch: the OTel Prometheus
        exporter inserts a unit segment (unit 's' -> '_seconds') between the
        base name and the type suffix, e.g. pipeline.consumer.duration really
        exports as pipeline_consumer_duration_seconds_bucket -- a regex that
        only alternates the type suffix never matches it, and 9 of 16
        instruments were misreported NOT_OBSERVED for exactly this reason."""
        entries = [{"id": "prometheus.pipeline_consumer_duration", "component": "prometheus",
                   "operation": "instant query on pipeline.consumer.duration",
                   "detail": "pipeline.consumer.duration | labels: queue, le (method scope)"}]
        client = RegexAwarePrometheus({
            "pipeline_consumer_duration_seconds_bucket": [{"queue": "q", "le": "0.1"}],
        })
        claims = verify.check_prometheus(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_ratio_unit_suffixed_series_name_is_matched(self):
        entries = [{"id": "prometheus.pipeline_gate_open", "component": "prometheus",
                   "operation": "instant query on pipeline.gate.open",
                   "detail": "pipeline.gate.open | no labels (method scope -- this instrument carries no tags)"}]
        client = RegexAwarePrometheus({"pipeline_gate_open_ratio": [{}]})
        claims = verify.check_prometheus(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_no_sample_at_the_instant_but_present_in_a_1h_range_is_confirmed(self):
        """An instant query only sees a series with a sample inside
        Prometheus's own 5-minute lookback window -- an instrument that
        fires less often than that is invisible to it even though it truly
        exists. The 1h range existence check tells the two cases apart."""
        entries = [{"id": "prometheus.pipeline_leader", "component": "prometheus",
                   "operation": "instant query on pipeline.leader",
                   "detail": "pipeline.leader | no labels (method scope -- this instrument carries no tags)"}]
        client = RangeOnlyPrometheus({"pipeline_leader_ratio": [{}]})
        claims = verify.check_prometheus(entries, client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)
        self.assertIn("range existence check", claims[0].message)

    def test_absent_from_both_instant_and_range_is_not_observed(self):
        entries = [{"id": "prometheus.pipeline_leader", "component": "prometheus",
                   "operation": "instant query on pipeline.leader",
                   "detail": "pipeline.leader | no labels (method scope -- this instrument carries no tags)"}]
        client = RangeOnlyPrometheus({})
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
        api_client = FakeBaseApi(FakeHttp(ok_paths={"/api/v1.0/workflows"}))
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_404_get_is_refuted(self):
        entries = [self.entry("workflows", "get", "GET /api/v1.0/workflows")]
        api_client = FakeBaseApi(FakeHttp(status_by_path={"/api/v1.0/workflows": 404}))
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_a_post_route_is_not_applicable_and_names_the_write_verb(self):
        entries = [self.entry("workflows", "post", "POST /api/v1.0/workflows")]
        api_client = FakeBaseApi(FakeHttp())
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)
        self.assertIn("write verb", claims[0].message)
        self.assertIn("POST", claims[0].message)

    def test_a_put_route_is_not_applicable(self):
        entries = [self.entry("workflows", "put_id", "PUT /api/v1.0/workflows/{id}")]
        api_client = FakeBaseApi(FakeHttp())
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)

    def test_a_delete_route_is_not_applicable(self):
        entries = [self.entry("workflows", "delete_id", "DELETE /api/v1.0/workflows/{id}")]
        api_client = FakeBaseApi(FakeHttp())
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)

    def test_get_id_resolves_the_first_real_id_from_the_list_route_and_confirms(self):
        entries = [self.entry("workflows", "get_id", "GET /api/v1.0/workflows/{id}")]
        api_client = FakeBaseApi(
            FakeHttp(ok_paths={"/api/v1.0/workflows/wf-1"}),
            items_by_entity={"workflows": [{"id": "wf-1"}, {"id": "wf-2"}]})
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)
        self.assertIn("wf-1", claims[0].message)

    def test_get_id_resolved_to_a_404_is_refuted(self):
        entries = [self.entry("workflows", "get_id", "GET /api/v1.0/workflows/{id}")]
        api_client = FakeBaseApi(
            FakeHttp(status_by_path={"/api/v1.0/workflows/wf-1": 404}),
            items_by_entity={"workflows": [{"id": "wf-1"}]})
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_get_id_with_zero_rows_to_resolve_from_is_not_observed(self):
        entries = [self.entry("workflows", "get_id", "GET /api/v1.0/workflows/{id}")]
        api_client = FakeBaseApi(FakeHttp(), items_by_entity={"workflows": []})
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)

    def test_get_id_when_the_list_route_itself_fails_is_unverifiable(self):
        entries = [self.entry("workflows", "get_id", "GET /api/v1.0/workflows/{id}")]
        api_client = FakeBaseApi(
            FakeHttp(), items_by_entity={"workflows": Unreachable("http", "connection refused")})
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.UNVERIFIABLE)

    def test_source_hash_placeholder_is_lowercased_before_substitution(self):
        """The catalogued trap: matching is byte-exact against a stored
        lowercase hex string."""
        entries = [self.entry("processors", "get_by_source_hash_sourcehash",
                              "GET /api/v1.0/processors/by-source-hash/{sourceHash}")]
        api_client = FakeBaseApi(
            FakeHttp(ok_paths={"/api/v1.0/processors/by-source-hash/abcdef"}),
            items_by_entity={"processors": [{"id": "p1", "sourceHash": "ABCDEF"}]})
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)
        self.assertIn("abcdef", claims[0].message)

    def test_more_than_one_path_parameter_stays_not_applicable(self):
        entries = [self.entry("widgets", "get_ab", "GET /api/v1.0/widgets/{a}/{b}")]
        api_client = FakeBaseApi(FakeHttp())
        claims = verify.check_api(entries, api_client)
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)


class FakeBaseApi:
    def __init__(self, http, items_by_entity=None):
        self.http = http
        self._items_by_entity = items_by_entity or {}

    def ready(self):
        return True

    def list(self, entity):
        items = self._items_by_entity.get(entity, [])
        if isinstance(items, Unreachable):
            raise items
        return items


class FakeProbeHttp:
    """Backs ``--probe-writes`` tests. ``responses`` is one entry per
    expected ``probe_status`` call, in order -- an ``(status, body)`` tuple,
    a bare status (body defaults to ``""``), or an exception instance to
    raise (mirroring ``probe_status``'s real contract: 2xx through 5xx are
    all returned as data, never raised; only a transport failure raises).
    Every call actually made is recorded in ``calls`` so a test can assert
    on the generated path (e.g. that an ``{id}`` placeholder was replaced
    with a well-formed, freshly generated guid) and the body (always
    ``{}``).
    """

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[tuple[str, str, object]] = []

    def probe_status(self, method, path, body):
        self.calls.append((method, path, body))
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if isinstance(response, tuple):
            return response
        return response, ""  # bare status, convenience for the empty-body cases


_UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)


_PROBLEM_DETAILS_BODY = ('{"type":"https://tools.ietf.org/html/rfc9110","title":"Not Found",'
                         '"status":404,"detail":"WorkflowEntity w..."}')


class ProblemDetailsBodyTests(unittest.TestCase):
    """``_looks_like_problem_details`` is what tells the two 404s apart --
    pinned directly against bodies shaped like what was actually observed
    live."""

    def test_a_problem_details_body_is_recognised(self):
        self.assertTrue(verify._looks_like_problem_details(_PROBLEM_DETAILS_BODY))

    def test_an_empty_body_is_not(self):
        self.assertFalse(verify._looks_like_problem_details(""))

    def test_whitespace_only_is_not(self):
        self.assertFalse(verify._looks_like_problem_details("   " + chr(10) + "  "))

    def test_non_json_text_is_not(self):
        self.assertFalse(verify._looks_like_problem_details("Not Found"))

    def test_json_missing_title_or_status_is_not(self):
        self.assertFalse(verify._looks_like_problem_details('{"detail": "nope"}'))

    def test_a_json_array_is_not_a_problem_details_object(self):
        self.assertFalse(verify._looks_like_problem_details('["title", "status"]'))


class WriteStatusClassificationTests(unittest.TestCase):
    """``_classify_write_status`` is the whole assumption this probe rests
    on, reduced to a pure function of (status, body) -- no HTTP client
    needed to pin it down. The body, not any fact from the catalog (like
    whether the route has an ``{id}`` placeholder), is what a 404 is
    classified by -- see ``test_404_with_no_id_and_a_problem_details_body_...``
    below for why the id-placeholder heuristic this used to use was wrong.
    """

    def test_400_is_confirmed(self):
        verdict, _, mutation = verify._classify_write_status(400, "")
        self.assertEqual(verdict, verify.CONFIRMED)
        self.assertFalse(mutation)

    def test_405_is_confirmed(self):
        verdict, _, _ = verify._classify_write_status(405, "")
        self.assertEqual(verdict, verify.CONFIRMED)

    def test_422_is_confirmed(self):
        verdict, _, _ = verify._classify_write_status(422, "")
        self.assertEqual(verdict, verify.CONFIRMED)

    def test_404_with_a_problem_details_body_is_confirmed(self):
        """The important case: proof routing matched and the action ran --
        the route is wired, even though this particular id was never
        going to be found."""
        verdict, reason, mutation = verify._classify_write_status(404, _PROBLEM_DETAILS_BODY)
        self.assertEqual(verdict, verify.CONFIRMED)
        self.assertFalse(mutation)
        self.assertIn("ProblemDetails", reason)

    def test_404_with_an_empty_body_is_refuted(self):
        """The other important case, and the one that would have failed
        under the old id-placeholder heuristic: an id-bearing route that
        was actually removed from the API also 404s, and an empty body is
        exactly what routing itself returns when nothing matched -- this
        must not be waved through as CONFIRMED just because the catalogued
        route happens to carry an {id}."""
        verdict, reason, mutation = verify._classify_write_status(404, "")
        self.assertEqual(verdict, verify.REFUTED)
        self.assertFalse(mutation)
        self.assertIn("does not exist", reason)

    def test_404_with_a_non_problem_details_body_is_also_refuted(self):
        verdict, reason, mutation = verify._classify_write_status(404, "plain text, not JSON")
        self.assertEqual(verdict, verify.REFUTED)
        self.assertFalse(mutation)

    def test_a_2xx_is_refuted_with_the_mutation_flag_set(self):
        """The important case: this is the one signal that the probe's own
        assumption -- model-state validation always short-circuits before
        the action runs -- did not hold."""
        verdict, reason, mutation = verify._classify_write_status(202, "")
        self.assertEqual(verdict, verify.REFUTED)
        self.assertTrue(mutation)
        self.assertIn("mutated state", reason)

    def test_a_2xx_with_a_body_is_also_refuted_with_the_mutation_flag_set(self):
        verdict, reason, mutation = verify._classify_write_status(200, '{"id": "abc"}')
        self.assertEqual(verdict, verify.REFUTED)
        self.assertTrue(mutation)

    def test_a_5xx_is_unverifiable(self):
        verdict, _, mutation = verify._classify_write_status(500, "")
        self.assertEqual(verdict, verify.UNVERIFIABLE)
        self.assertFalse(mutation)


class ProbeWritesTests(unittest.TestCase):
    def entry(self, entity, verb_id, operation):
        return {"id": f"api.{entity}.{verb_id}", "component": "api",
               "operation": operation, "detail": entity}

    def test_probe_writes_off_by_default_names_the_remedy(self):
        entries = [self.entry("workflows", "post", "POST /api/v1.0/workflows")]
        api_client = FakeBaseApi(FakeProbeHttp([]))
        claims = verify.check_api(entries, api_client)  # probe_writes defaults False
        self.assertEqual(claims[0].verdict, verify.NOT_APPLICABLE)
        self.assertIn("--probe-writes", claims[0].message)

    def test_a_400_on_a_post_route_is_confirmed(self):
        entries = [self.entry("workflows", "post", "POST /api/v1.0/workflows")]
        http = FakeProbeHttp([400])
        claims = verify.check_api(entries, FakeBaseApi(http), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)
        self.assertEqual(http.calls, [("POST", "/api/v1.0/workflows", {})])

    def test_a_404_on_a_no_id_route_is_refuted(self):
        entries = [self.entry("orchestration", "post_start", "POST /api/v1.0/orchestration/start")]
        claims = verify.check_api(entries, FakeBaseApi(FakeProbeHttp([404])), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_a_404_on_a_put_id_route_with_a_problem_details_body_is_confirmed(self):
        entries = [self.entry("workflows", "put_id", "PUT /api/v1.0/workflows/{id}")]
        http = FakeProbeHttp([(404, _PROBLEM_DETAILS_BODY)])
        claims = verify.check_api(entries, FakeBaseApi(http), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_404_on_a_delete_id_route_with_a_problem_details_body_is_confirmed(self):
        entries = [self.entry("workflows", "delete_id", "DELETE /api/v1.0/workflows/{id}")]
        http = FakeProbeHttp([(404, _PROBLEM_DETAILS_BODY)])
        claims = verify.check_api(entries, FakeBaseApi(http), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)

    def test_a_404_on_an_id_route_with_an_empty_body_is_refuted_not_confirmed(self):
        """The regression this whole fix exists for: an id-bearing route
        that was actually removed from the API also 404s. Classifying by
        "does the catalogued route have an {id} placeholder" instead of by
        the response body would confirm a route that no longer exists --
        this must REFUTE instead."""
        entries = [self.entry("workflows", "delete_id", "DELETE /api/v1.0/workflows/{id}")]
        http = FakeProbeHttp([(404, "")])
        claims = verify.check_api(entries, FakeBaseApi(http), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.REFUTED)

    def test_a_2xx_is_refuted_with_a_mutation_warning_in_the_message(self):
        entries = [self.entry("workflows", "post", "POST /api/v1.0/workflows")]
        claims = verify.check_api(entries, FakeBaseApi(FakeProbeHttp([201])), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.REFUTED)
        self.assertIn("MUTATION WARNING", claims[0].message)

    def test_a_5xx_is_unverifiable(self):
        entries = [self.entry("workflows", "post", "POST /api/v1.0/workflows")]
        claims = verify.check_api(entries, FakeBaseApi(FakeProbeHttp([503])), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.UNVERIFIABLE)

    def test_a_transport_failure_is_unverifiable(self):
        entries = [self.entry("workflows", "post", "POST /api/v1.0/workflows")]
        http = FakeProbeHttp([Unreachable("http", "connection refused")])
        claims = verify.check_api(entries, FakeBaseApi(http), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.UNVERIFIABLE)

    def test_an_id_route_is_filled_with_a_freshly_generated_guid_not_a_real_one(self):
        entries = [self.entry("workflows", "delete_id", "DELETE /api/v1.0/workflows/{id}")]
        http = FakeProbeHttp([404])
        verify.check_api(entries, FakeBaseApi(http), probe_writes=True)
        method, path, body = http.calls[0]
        self.assertEqual(method, "DELETE")
        self.assertEqual(body, {})
        prefix, _, guid = path.rpartition("/")
        self.assertEqual(prefix, "/api/v1.0/workflows")
        self.assertRegex(guid, _UUID4)

    def test_an_empty_body_is_sent_for_every_write_route(self):
        entries = [self.entry("workflows", "post", "POST /api/v1.0/workflows")]
        http = FakeProbeHttp([400])
        verify.check_api(entries, FakeBaseApi(http), probe_writes=True)
        self.assertEqual(http.calls[0][2], {})

    def test_orchestration_start_is_probed_like_any_other_no_id_write_route(self):
        """start/stop take a bare workflow guid as the body, not an object --
        ``{}`` still fails binding against it, and the generic status-code
        mapping (not a route-specific special case) is what decides the
        verdict either way."""
        entries = [self.entry("orchestration", "post_start", "POST /api/v1.0/orchestration/start")]
        http = FakeProbeHttp([400])
        claims = verify.check_api(entries, FakeBaseApi(http), probe_writes=True)
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)
        self.assertEqual(http.calls, [("POST", "/api/v1.0/orchestration/start", {})])


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

    def test_an_absent_key_family_never_carries_an_exclusion_marker(self):
        entries = [{"id": "redis.Root", "component": "redis", "operation": "read key",
                   "detail": "skp:{workflowId}"}]
        client = FakeRedis(keys_by_pattern={})
        claims = verify.check_redis(entries, client)
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)
        self.assertNotIn("PERMANENT EXCLUSION", claims[0].message)


class FakePostHttp:
    """Backs ``--probe-runs`` tests: records every ``post_json`` call and
    either returns ``None`` (a 202-with-no-body success) or raises
    ``Unreachable`` when constructed with ``fail=``."""

    def __init__(self, fail=None):
        self.posts: list[tuple[str, object]] = []
        self._fail = fail

    def post_json(self, path, body):
        self.posts.append((path, body))
        if self._fail:
            raise Unreachable("baseapi", self._fail)
        return None


class ProbeRunsTests(unittest.TestCase):
    ORCH_ENTRY = {"id": "api.orchestration.post_start", "component": "api",
                 "operation": "POST /api/v1.0/orchestration/start", "detail": "orchestration"}
    NOT_OBSERVED_DATA_CLAIM = verify.Claim("redis", "redis.ExecutionData", verify.NOT_OBSERVED,
                                           "no live keys matching skp:data:*")

    def _with_probe_run_timing(self, attempts, poll, fn):
        original = (verify._PROBE_RUN_ATTEMPTS, verify._PROBE_RUN_POLL_S)
        verify._PROBE_RUN_ATTEMPTS, verify._PROBE_RUN_POLL_S = attempts, poll
        try:
            return fn()
        finally:
            verify._PROBE_RUN_ATTEMPTS, verify._PROBE_RUN_POLL_S = original

    def test_start_workflow_for_probe_uses_an_existing_id_and_the_catalogued_route(self):
        http = FakePostHttp()
        baseapi = FakeBaseApi(http, items_by_entity={"workflows": [{"id": "wf-1"}]})
        workflow_id, note = verify.start_workflow_for_probe(
            [self.ORCH_ENTRY], {"baseapi": baseapi})
        self.assertEqual(workflow_id, "wf-1")
        self.assertEqual(http.posts[0], ("/api/v1.0/orchestration/start", "wf-1"))
        self.assertIn("wf-1", note)

    def test_start_workflow_for_probe_with_no_workflows_registered_says_so(self):
        baseapi = FakeBaseApi(FakePostHttp(), items_by_entity={"workflows": []})
        workflow_id, note = verify.start_workflow_for_probe(
            [self.ORCH_ENTRY], {"baseapi": baseapi})
        self.assertIsNone(workflow_id)
        self.assertIn("no workflow registered", note)

    def test_start_workflow_for_probe_with_no_catalogued_route_says_so(self):
        baseapi = FakeBaseApi(FakePostHttp(), items_by_entity={"workflows": [{"id": "wf-1"}]})
        workflow_id, note = verify.start_workflow_for_probe([], {"baseapi": baseapi})
        self.assertIsNone(workflow_id)
        self.assertIn("route not found", note)

    def test_apply_probe_runs_confirms_when_the_key_appears_in_flight(self):
        class EventuallyPopulated:
            def __init__(self):
                self.calls = 0

            def keys(self, pattern):
                self.calls += 1
                return ["skp:data:e1"] if self.calls >= 2 else []

        baseapi = FakeBaseApi(FakePostHttp(), items_by_entity={"workflows": [{"id": "wf-1"}]})
        clients = {"baseapi": baseapi, "redis": EventuallyPopulated()}
        claims = self._with_probe_run_timing(5, 0.001, lambda: verify.apply_probe_runs(
            [self.NOT_OBSERVED_DATA_CLAIM], [self.ORCH_ENTRY], clients, {"baseapi": True}))
        self.assertEqual(claims[0].verdict, verify.CONFIRMED)
        self.assertIn("caught in flight", claims[0].message)

    def test_apply_probe_runs_leaves_unrelated_claims_untouched(self):
        other = verify.Claim("redis", "redis.Root", verify.CONFIRMED, "1 key(s)")
        claims = verify.apply_probe_runs([other], [], {}, {"baseapi": True})
        self.assertEqual(claims, [other])

    def test_apply_probe_runs_leaves_already_confirmed_data_claim_untouched(self):
        """A --probe-writes/--probe-runs combined run, or a race where a real
        run happened to be in flight already, must never start a second
        workflow just because the flag is set."""
        confirmed = verify.Claim("redis", "redis.ExecutionData", verify.CONFIRMED, "1 key(s)")
        http = FakePostHttp()
        baseapi = FakeBaseApi(http, items_by_entity={"workflows": [{"id": "wf-1"}]})
        claims = verify.apply_probe_runs(
            [confirmed], [self.ORCH_ENTRY], {"baseapi": baseapi}, {"baseapi": True})
        self.assertEqual(claims, [confirmed])
        self.assertEqual(http.posts, [])

    def test_apply_probe_runs_without_baseapi_reachable_says_so_and_does_not_start_anything(self):
        http = FakePostHttp()
        baseapi = FakeBaseApi(http, items_by_entity={"workflows": [{"id": "wf-1"}]})
        claims = verify.apply_probe_runs(
            [self.NOT_OBSERVED_DATA_CLAIM], [self.ORCH_ENTRY],
            {"baseapi": baseapi}, {"baseapi": False})
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)
        self.assertIn("baseapi unreachable", claims[0].message)
        self.assertEqual(http.posts, [])

    def test_apply_probe_runs_that_never_catches_the_key_says_so(self):
        baseapi = FakeBaseApi(FakePostHttp(), items_by_entity={"workflows": [{"id": "wf-1"}]})
        clients = {"baseapi": baseapi, "redis": FakeRedis(keys_by_pattern={})}
        claims = self._with_probe_run_timing(2, 0.001, lambda: verify.apply_probe_runs(
            [self.NOT_OBSERVED_DATA_CLAIM], [self.ORCH_ENTRY], clients, {"baseapi": True}))
        self.assertEqual(claims[0].verdict, verify.NOT_OBSERVED)
        self.assertIn("--probe-runs", claims[0].message)
        self.assertIn("never appeared", claims[0].message)
        self.assertIn("no live keys matching skp:data:*", claims[0].message)  # original reason kept


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

    def test_probe_runs_off_by_default_leaves_an_empty_data_family_not_observed(self):
        entries = self.CATALOG + [{"id": "redis.ExecutionData", "component": "redis",
                                   "operation": "read key", "detail": "skp:data:{id}"}]
        clients = make_clients(redis=FakeRedis(keys_by_pattern={"skp:*": ["k"]}))
        claims = verify.verify_all(entries, clients)
        by_id = {c.surface_id: c for c in claims}
        self.assertEqual(by_id["redis.ExecutionData"].verdict, verify.NOT_OBSERVED)
        self.assertNotIn("--probe-runs", by_id["redis.ExecutionData"].message)

    def test_probe_runs_flows_through_and_can_confirm_the_data_family(self):
        entries = self.CATALOG + [
            {"id": "redis.ExecutionData", "component": "redis", "operation": "read key",
             "detail": "skp:data:{id}"},
            {"id": "api.orchestration.post_start", "component": "api",
             "operation": "POST /api/v1.0/orchestration/start", "detail": "orchestration"},
        ]

        class EventuallyPopulated:
            def __init__(self):
                self.calls = 0

            def keys(self, pattern):
                if pattern != "skp:data:*":
                    return []
                self.calls += 1
                return ["skp:data:e1"] if self.calls >= 2 else []

            def ping(self):
                return True

        baseapi = FakeBaseApi(FakePostHttp(), items_by_entity={"workflows": [{"id": "wf-1"}]})
        clients = make_clients(redis=EventuallyPopulated(), baseapi=baseapi)
        original = (verify._PROBE_RUN_ATTEMPTS, verify._PROBE_RUN_POLL_S)
        verify._PROBE_RUN_ATTEMPTS, verify._PROBE_RUN_POLL_S = 5, 0.001
        try:
            claims = verify.verify_all(entries, clients, probe_runs=True)
        finally:
            verify._PROBE_RUN_ATTEMPTS, verify._PROBE_RUN_POLL_S = original
        by_id = {c.surface_id: c for c in claims}
        self.assertEqual(by_id["redis.ExecutionData"].verdict, verify.CONFIRMED)
        self.assertIn("caught in flight", by_id["redis.ExecutionData"].message)


# ---------------------------------------------------------------------
# render_report -- every skip enumerable (Part 2)
# ---------------------------------------------------------------------

class RenderReportTests(unittest.TestCase):
    CLAIMS = [
        verify.Claim("postgres", "postgres.workflows", verify.CONFIRMED, "table workflows: 3 row(s)"),
        verify.Claim("redis", "redis.Root", verify.CONFIRMED, "1 key(s) matching skp:*"),
        verify.Claim("redis", "redis.ExecutionData", verify.NOT_OBSERVED, "no live keys matching skp:data:*"),
        verify.Claim("api", "api.workflows.post", verify.NOT_APPLICABLE,
                    "POST -- write verb, cannot be exercised read-only"),
    ]

    def test_the_confirmation_ratio_is_printed_explicitly(self):
        lines = verify.render_report(self.CLAIMS)
        self.assertIn("confirmed 2/4 (50%)", lines)

    def test_skips_are_hidden_by_default_behind_a_pointer(self):
        lines = verify.render_report(self.CLAIMS)
        text = "\n".join(lines)
        self.assertNotIn("redis.ExecutionData", text)
        self.assertNotIn("api.workflows.post", text)
        self.assertIn("2 claim(s) not confirmed", text)
        self.assertIn("--skips", text)

    def test_skips_flag_enumerates_every_one_by_id_with_its_reason(self):
        lines = verify.render_report(self.CLAIMS, show_skips=True)
        text = "\n".join(lines)
        self.assertIn("redis.ExecutionData", text)
        self.assertIn("no live keys matching skp:data:*", text)
        self.assertIn("api.workflows.post", text)
        self.assertIn("write verb, cannot be exercised read-only", text)

    def test_no_skips_at_all_prints_no_pointer(self):
        lines = verify.render_report(self.CLAIMS[:2])
        text = "\n".join(lines)
        self.assertNotIn("--skips", text)
        self.assertIn("confirmed 2/2 (100%)", text)

    def test_the_ratio_states_an_explicit_ceiling_when_refuted_or_permanently_excluded(self):
        claims = [
            verify.Claim("postgres", "postgres.workflows", verify.CONFIRMED, "3 row(s)"),
            verify.Claim("rabbitmq", "rabbitmq.processor.Work", verify.REFUTED, "missing: x"),
            verify.Claim("rabbitmq", "rabbitmq.processor.Dead", verify.REFUTED, "missing: y"),
            verify.Claim("redis", "redis.HypotheticalUnobservable", verify.NOT_OBSERVED,
                        "PERMANENT EXCLUSION: no call site writes this key"),
        ]
        lines = verify.render_report(claims)
        text = "\n".join(lines)
        self.assertIn("confirmed 1/4 (25%)", text)
        self.assertIn("2 refuted", text)
        self.assertIn("1 permanently excluded", text)
        self.assertIn("maximum achievable 1/4", text)

    def test_the_ratio_has_no_ceiling_clause_with_neither_refuted_nor_permanent(self):
        lines = verify.render_report(self.CLAIMS[:2])
        text = "\n".join(lines)
        self.assertNotIn("maximum achievable", text)
        self.assertNotIn("refuted", text)


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

    def test_skips_flag_is_a_recognised_argument(self):
        # No profile.json here -- run() returns not_initialised() before ever
        # touching build_clients()/the network, so this pins only that
        # argparse accepts --skips without raising SystemExit, cheaply.
        with tempfile.TemporaryDirectory() as tmp:
            result = verify.run(["--home", str(pathlib.Path(tmp) / ".skp"), "--skips"])
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
