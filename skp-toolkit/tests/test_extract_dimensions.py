import unittest

from skp.compile.extract import metric_labels, metrics, resource_labels

# ---- metric_labels / metrics() label extraction -----------------------------------

# Two instruments sharing one push method's TagList -- EgressMetrics' real shape.
PUSHED_SHARED_METHOD = '''
public static class EgressMetrics
{
    private static readonly Counter<long> Produced = Meter.CreateCounter<long>(
        "pipeline.messages.produced", unit: "{message}", description: "x");
    private static readonly Histogram<double> Duration = Meter.CreateHistogram<double>(
        "pipeline.produce.duration", unit: "s", description: "x");

    internal const string RouteQueue = "queue";
    internal const string RouteFanout = "fanout";

    private static void Record(string route, string destination, string type, string outcome)
    {
        var tags = new TagList
        {
            { "route", route },
            { "destination", destination },
            { "type", type },
            { "outcome", outcome },
        };
        Produced.Add(1, tags);
        Duration.Record(1.0, tags);
    }
}
'''

# A single KeyValuePair tag, push shape -- GateMetrics.RecordProbe's real shape.
PUSHED_SINGLE_KVP = '''
public static class GateMetrics
{
    public const string ProbeDurationInstrument = "pipeline.gate.probe.duration";
    private static readonly Histogram<double> ProbeDuration = Meter.CreateHistogram<double>(
        ProbeDurationInstrument, unit: "s", description: "x");

    public static void RecordProbe(TimeSpan elapsed, string outcome) =>
        ProbeDuration.Record(elapsed.TotalSeconds, new KeyValuePair<string, object?>("outcome", outcome));
}
'''

# An observable gauge whose callback is a bare method-group reference -- LoopMetrics' shape.
OBSERVABLE_BARE_CALLBACK = '''
public static class LoopMetrics
{
    public const string IterationsInstrument = "pipeline.loop.iterations";
    private static readonly Meter Meter = new(MeterName);

    static LoopMetrics()
    {
        Meter.CreateObservableCounter(
            IterationsInstrument,
            Observe,
            unit: "{iteration}",
            description: "x");
    }

    private static IEnumerable<Measurement<long>> Observe() =>
        Loops.Select(entry => new Measurement<long>(
            Interlocked.Read(ref entry.Value.Value),
            new KeyValuePair<string, object?>("loop", entry.Key)));
}
'''

# An observable gauge whose callback delegates through a lambda to a third method --
# QueueDepthMetrics' shape, and the case the brief calls out for the file-scope fallback.
OBSERVABLE_LAMBDA_CALLBACK = '''
public static class QueueDepthMetrics
{
    internal const string DepthInstrument = "pipeline.queue.depth";
    internal const string ConsumersInstrument = "pipeline.queue.consumers";

    static QueueDepthMetrics()
    {
        Meter.CreateObservableGauge(
            DepthInstrument,
            () => Snapshot(s => s.Depth),
            unit: "{message}",
            description: "x");

        Meter.CreateObservableGauge(
            ConsumersInstrument,
            () => Snapshot(s => s.Consumers),
            unit: "{consumer}",
            description: "x");
    }

    private static IEnumerable<Measurement<long>> Snapshot(Func<Stats, long> select) =>
        Observed.Select(e => new Measurement<long>(
            select(e.Value), new KeyValuePair<string, object?>("queue", e.Key)));
}
'''

# A comment sitting between the callback argument and `unit:` -- the exact shape that
# silently broke the observable-call regex against DeadLetterDepthMetrics.cs before the
# comment-stripping fix. Regression fixture, not a hypothetical.
OBSERVABLE_WITH_INTERVENING_COMMENT = '''
public static class DeadLetterDepthMetrics
{
    internal const string DepthInstrument = "pipeline.deadletter.depth";

    static DeadLetterDepthMetrics()
    {
        Meter.CreateObservableGauge(
            DepthInstrument,
            Observe,
            // a multi-line rationale, with a "quoted" phrase and a bare comma,
            // sitting between the callback and the unit: keyword argument.
            unit: "{message}",
            description: "x");
    }

    private static IEnumerable<Measurement<long>> Observe() =>
        Depths.Select(e => new Measurement<long>(
            e.Value, new KeyValuePair<string, object?>("queue", e.Key)));
}
'''

# No tags at all -- ProcessStartMetrics' shape: a genuinely label-less instrument.
NO_LABELS = '''
public static class ProcessStartMetrics
{
    public const string StartTimestampInstrument = "pipeline.process.start.timestamp";

    static ProcessStartMetrics()
    {
        Meter.CreateObservableGauge(StartTimestampInstrument, Observe, unit: "s", description: "x");
    }

    private static IEnumerable<Measurement<long>> Observe()
    {
        return stamped == 0 ? [] : [new Measurement<long>(stamped)];
    }
}
'''


class MetricLabelsTests(unittest.TestCase):
    def test_two_instruments_sharing_one_push_method_get_the_same_labels(self):
        labels = metric_labels({"a.cs": PUSHED_SHARED_METHOD})
        self.assertEqual(labels["pipeline.messages.produced"],
                         ["destination", "outcome", "route", "type"])
        self.assertEqual(labels["pipeline.produce.duration"],
                         ["destination", "outcome", "route", "type"])

    def test_a_single_keyvaluepair_tag_is_found_at_method_scope(self):
        labels = metric_labels({"a.cs": PUSHED_SINGLE_KVP})
        self.assertEqual(labels["pipeline.gate.probe.duration"], ["outcome"])

    def test_an_observable_bare_callback_is_resolved_at_method_scope(self):
        labels = metric_labels({"a.cs": OBSERVABLE_BARE_CALLBACK})
        self.assertEqual(labels["pipeline.loop.iterations"], ["loop"])

    def test_an_observable_lambda_delegating_to_a_third_method_falls_back_to_file_scope(self):
        labels = metric_labels({"a.cs": OBSERVABLE_LAMBDA_CALLBACK})
        self.assertEqual(labels["pipeline.queue.depth"], ["queue"])
        self.assertEqual(labels["pipeline.queue.consumers"], ["queue"])

    def test_a_comment_between_the_callback_and_unit_does_not_hide_the_call(self):
        labels = metric_labels({"a.cs": OBSERVABLE_WITH_INTERVENING_COMMENT})
        self.assertEqual(labels["pipeline.deadletter.depth"], ["queue"])

    def test_an_instrument_with_no_tags_reports_an_empty_list_not_an_absence(self):
        labels = metric_labels({"a.cs": NO_LABELS})
        self.assertIn("pipeline.process.start.timestamp", labels)
        self.assertEqual(labels["pipeline.process.start.timestamp"], [])

    def test_the_scope_that_resolved_a_label_is_recorded_in_the_surface_detail(self):
        by_id = {s.id: s for s in metrics([PUSHED_SHARED_METHOD])}
        self.assertIn("method scope", by_id["prometheus.pipeline_messages_produced"].detail)
        by_id = {s.id: s for s in metrics([OBSERVABLE_LAMBDA_CALLBACK])}
        self.assertIn("file scope", by_id["prometheus.pipeline_queue_depth"].detail)

    def test_a_const_declared_domain_is_recorded_on_the_label(self):
        by_id = {s.id: s for s in metrics([PUSHED_SHARED_METHOD])}
        detail = by_id["prometheus.pipeline_messages_produced"].detail
        self.assertIn("route={fanout|queue}", detail)
        # A label with no const-declared values (type, outcome, destination here) must
        # not be presented as if it had a complete domain.
        self.assertNotIn("type={", detail)

    def test_a_genuinely_empty_label_set_says_so_rather_than_reading_as_an_absence(self):
        by_id = {s.id: s for s in metrics([NO_LABELS])}
        detail = by_id["prometheus.pipeline_process_start_timestamp"].detail
        self.assertIn("no labels", detail)
        self.assertIn("method scope", detail)


class ResourceLabelsTests(unittest.TestCase):
    def test_the_three_resource_attributes_are_hand_listed_surfaces(self):
        ids = {s.id for s in resource_labels()}
        self.assertEqual(ids, {"prometheus.label.service_name",
                               "prometheus.label.service_instance_id",
                               "prometheus.label.processorId"})

    def test_the_instance_vs_replica_trap_is_on_service_instance_id(self):
        by_id = {s.id: s for s in resource_labels()}
        detail = by_id["prometheus.label.service_instance_id"].detail
        self.assertIn("replica", detail.lower())




if __name__ == "__main__":
    unittest.main()
