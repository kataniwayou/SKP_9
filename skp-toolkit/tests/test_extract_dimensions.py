import unittest

from skp.compile.catalog import CatalogError
from skp.compile.extract import (log_attributes, metric_label_gaps, metric_labels, metrics,
                                 resource_labels)

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

# C1: a pushed method whose body ends in PipelineAmbientTag.AppendTo(ref tags) before
# the .Add call -- EgressMetrics.Record / IngressMetrics' three RecordXxx methods'
# real shape. `role` carries no string literal of its own, so only recognising this
# exact call by name can find it.
PUSHED_WITH_AMBIENT_ROLE_TAG = '''
public static class EgressMetrics
{
    private static readonly Counter<long> Produced = Meter.CreateCounter<long>(
        "pipeline.messages.produced", unit: "{message}", description: "x");

    private static void Record(string route, string type, string outcome)
    {
        var tags = new TagList
        {
            { "route", route },
            { "type", type },
            { "outcome", outcome },
        };

        // The host's process-wide tag, if it installed one.
        PipelineAmbientTag.AppendTo(ref tags);

        Produced.Add(1, tags);
    }
}
'''

# C1 precision guard: a second instrument in the SAME FILE resolved at file scope
# (via the lambda fallback), while an unrelated method elsewhere in that file calls
# AppendTo. The file-scope instrument must NOT inherit "role" -- only a method that
# itself makes the call may carry it, exactly the gate.open/gate.probe.duration
# precision the reviewer verified must not be destroyed.
FILE_SCOPE_DOES_NOT_INHERIT_AMBIENT_TAG = '''
public static class MixedMetrics
{
    internal const string DepthInstrument = "pipeline.queue.depth";

    static MixedMetrics()
    {
        Meter.CreateObservableGauge(
            DepthInstrument,
            () => Snapshot(s => s.Depth),
            unit: "{message}",
            description: "x");
    }

    private static IEnumerable<Measurement<long>> Snapshot(Func<Stats, long> select) =>
        Observed.Select(e => new Measurement<long>(
            select(e.Value), new KeyValuePair<string, object?>("queue", e.Key)));

    private static void RecordSomethingElse()
    {
        var tags = new TagList();
        PipelineAmbientTag.AppendTo(ref tags);
    }
}
'''

# I2: a char literal containing a bare double quote, immediately before real tagged
# code -- the reviewer's demonstrated regression. Without recognising char literals,
# the stray `"` inside `'"'` desynchronises quote parity and the TagList/`.Record`
# call past it is blanked as if it were inside a string.
BROKEN_QUOTE_CHAR_LITERAL = r'''
public static class BrokenQuoteMetrics
{
    internal const string DepthInstrument = "pipeline.queue.depth";
    private static readonly Histogram<double> Depth = Meter.CreateHistogram<double>(
        DepthInstrument, unit: "s", description: "x");

    private static void Record(string queue)
    {
        var sep = '"';
        var url = "http://example/x"; var tags = new TagList { { "queue", queue } }; Depth.Record(1.0, tags);
    }
}
'''

# I2: a verbatim string ending in a backslash right before its closing quote -- the
# backslash is not an escape inside `@"..."`, so a plain string regex reads past the
# real closing quote hunting for one, desynchronising parity the same way.
BROKEN_QUOTE_VERBATIM_STRING = r'''
public static class VerbatimPathMetrics
{
    internal const string DepthInstrument = "pipeline.queue.depth";
    private static readonly Histogram<double> Depth = Meter.CreateHistogram<double>(
        DepthInstrument, unit: "s", description: "x");

    private static void Record(string queue)
    {
        var path = @"C:\dir\";
        var tags = new TagList { { "queue", queue } };
        Depth.Record(1.0, tags);
    }
}
'''

# Minor: two methods in one file both call .Record( on the same field -- there is no
# single method scope to pick without arbitrarily choosing one.
TWO_CALL_SITES_FOR_ONE_FIELD = '''
public static class DoubleRecordMetrics
{
    internal const string DepthInstrument = "pipeline.queue.depth";
    private static readonly Histogram<double> Depth = Meter.CreateHistogram<double>(
        DepthInstrument, unit: "s", description: "x");

    private static void RecordA(string queue)
    {
        var tags = new TagList { { "queue", queue } };
        Depth.Record(1.0, tags);
    }

    private static void RecordB(string route)
    {
        var tags = new TagList { { "route", route } };
        Depth.Record(1.0, tags);
    }
}
'''

# Minor: two overloads sharing one method name in one file -- _method_bodies must not
# let the second silently overwrite the first.
DUPLICATE_METHOD_NAME = '''
public static class OverloadMetrics
{
    internal const string DepthInstrument = "pipeline.queue.depth";
    private static readonly Histogram<double> Depth = Meter.CreateHistogram<double>(
        DepthInstrument, unit: "s", description: "x");

    private static void Record(string queue)
    {
        var tags = new TagList { { "queue", queue } };
        Depth.Record(1.0, tags);
    }

    private static void Record(string queue, string type)
    {
        var tags = new TagList { { "queue", queue }, { "type", type } };
        Depth.Record(1.0, tags);
    }
}
'''

# Minor: two files declaring the same instrument name with different labels -- the
# real shape L2GateMetrics.cs's aliasing of GateMetrics' constants could take.
FILE_ONE_GATE_TRIPS = '''
public static class GateMetrics
{
    public const string TripsInstrument = "pipeline.gate.trips";

    static GateMetrics()
    {
        Meter.CreateObservableCounter(TripsInstrument, ObserveTrips, unit: "1", description: "x");
    }

    private static IEnumerable<Measurement<long>> ObserveTrips() => [];
}
'''

FILE_TWO_GATE_TRIPS_WITH_LABEL = '''
public static class AliasGateMetrics
{
    public const string TripsInstrument = "pipeline.gate.trips";

    static AliasGateMetrics()
    {
        Meter.CreateObservableCounter(TripsInstrument, ObserveTrips, unit: "1", description: "x");
    }

    private static IEnumerable<Measurement<long>> ObserveTrips() =>
        [new Measurement<long>(1, new KeyValuePair<string, object?>("outcome", "x"))];
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

    def test_file_scope_detail_explains_its_own_imprecision(self):
        # I3: "(file scope)" alone is an undefined token to a lookup-driven model.
        by_id = {s.id: s for s in metrics([OBSERVABLE_LAMBDA_CALLBACK])}
        detail = by_id["prometheus.pipeline_queue_depth"].detail
        self.assertIn("file scope", detail)
        self.assertIn("union of every tag key", detail)
        self.assertIn("may not carry all of them", detail)


class AmbientRoleTagTests(unittest.TestCase):
    """C1: PipelineAmbientTag.AppendTo(ref tags) appends a real runtime `role`
    tag no literal scan can see."""

    def test_a_method_calling_appendto_gains_the_role_label(self):
        labels = metric_labels({"a.cs": PUSHED_WITH_AMBIENT_ROLE_TAG})
        self.assertEqual(labels["pipeline.messages.produced"],
                         ["outcome", "role", "route", "type"])

    def test_the_scope_stays_method_when_role_is_added(self):
        by_id = {s.id: s for s in metrics([PUSHED_WITH_AMBIENT_ROLE_TAG])}
        self.assertIn("method scope", by_id["prometheus.pipeline_messages_produced"].detail)

    def test_a_method_with_no_appendto_call_does_not_gain_role(self):
        # Negative control: PUSHED_SINGLE_KVP's RecordProbe never calls AppendTo.
        labels = metric_labels({"a.cs": PUSHED_SINGLE_KVP})
        self.assertEqual(labels["pipeline.gate.probe.duration"], ["outcome"])

    def test_role_is_not_inherited_by_a_file_scope_fallback_instrument(self):
        # The precision the reviewer verified must survive: only the method that
        # itself calls AppendTo carries role, never a sibling resolved at file scope.
        labels = metric_labels({"a.cs": FILE_SCOPE_DOES_NOT_INHERIT_AMBIENT_TAG})
        self.assertEqual(labels["pipeline.queue.depth"], ["queue"])
        self.assertNotIn("role", labels["pipeline.queue.depth"])


class CommentStrippingQuoteParityTests(unittest.TestCase):
    """I2: _strip_comments must not lose real code to a char literal or verbatim
    string desynchronising quote parity."""

    def test_a_char_literal_quote_does_not_desync_comment_stripping(self):
        labels = metric_labels({"a.cs": BROKEN_QUOTE_CHAR_LITERAL})
        self.assertEqual(labels["pipeline.queue.depth"], ["queue"])

    def test_a_verbatim_string_trailing_backslash_does_not_desync_comment_stripping(self):
        labels = metric_labels({"a.cs": BROKEN_QUOTE_VERBATIM_STRING})
        self.assertEqual(labels["pipeline.queue.depth"], ["queue"])


class SilentLossGuardTests(unittest.TestCase):
    """Minors: three shapes that used to pick one of several candidates
    silently now raise instead."""

    def test_two_call_sites_for_one_instrument_raise_rather_than_pick_the_first(self):
        with self.assertRaises(CatalogError):
            metric_labels({"a.cs": TWO_CALL_SITES_FOR_ONE_FIELD})

    def test_a_duplicate_method_name_raises_rather_than_silently_dropping_a_body(self):
        with self.assertRaises(CatalogError):
            metric_labels({"a.cs": DUPLICATE_METHOD_NAME})

    def test_two_files_declaring_the_same_instrument_with_different_labels_raise(self):
        with self.assertRaises(CatalogError):
            metric_labels({"a.cs": FILE_ONE_GATE_TRIPS, "b.cs": FILE_TWO_GATE_TRIPS_WITH_LABEL})

    def test_metrics_also_raises_on_a_conflicting_cross_file_redefinition(self):
        with self.assertRaises(CatalogError):
            metrics([FILE_ONE_GATE_TRIPS, FILE_TWO_GATE_TRIPS_WITH_LABEL])

    def test_identical_redeclaration_across_files_does_not_raise(self):
        # Not every repeat is a conflict -- only a disagreement is. Two files
        # producing the exact same dims for a name is (currently) harmless.
        labels = metric_labels({"a.cs": FILE_ONE_GATE_TRIPS, "b.cs": FILE_ONE_GATE_TRIPS})
        self.assertEqual(labels["pipeline.gate.trips"], [])


class MetricLabelGapTests(unittest.TestCase):
    """Minor: the names == set(labels) completeness check, promoted from a
    unit-test-only assertion into a function collect_surfaces can call."""

    def test_a_name_with_no_resolvable_call_site_is_reported(self):
        gaps = metric_label_gaps(['internal const string DepthInstrument = "pipeline.queue.depth";'])
        self.assertEqual(len(gaps), 1)
        self.assertIn("pipeline_queue_depth", gaps[0])

    def test_no_gaps_when_every_name_resolves(self):
        self.assertEqual(metric_label_gaps([PUSHED_SHARED_METHOD]), [])


class ResourceLabelsTests(unittest.TestCase):
    def test_the_six_resource_and_structural_labels_are_hand_listed_surfaces(self):
        # I1: le, service_version and source were live labels missing from the
        # catalog -- le on every histogram, service_version/source as resource
        # attributes alongside the three already catalogued.
        ids = {s.id for s in resource_labels()}
        self.assertEqual(ids, {"prometheus.label.service_name",
                               "prometheus.label.service_instance_id",
                               "prometheus.label.processorId",
                               "prometheus.label.service_version",
                               "prometheus.label.source",
                               "prometheus.label.le"})

    def test_the_instance_vs_replica_trap_is_on_service_instance_id(self):
        by_id = {s.id: s for s in resource_labels()}
        detail = by_id["prometheus.label.service_instance_id"].detail
        self.assertIn("replica", detail.lower())

    def test_le_is_annotated_as_a_bucket_boundary_required_for_quantiles(self):
        # I1: le is structural to the histogram type, not a TagList entry --
        # the detail must say so, name histogram_quantile, and warn it is not
        # a useful grouping key.
        by_id = {s.id: s for s in resource_labels()}
        detail = by_id["prometheus.label.le"].detail.lower()
        self.assertIn("bucket", detail)
        self.assertIn("histogram_quantile", detail)
        self.assertIn("grouping key", detail)

    def test_service_version_and_source_cite_the_same_addservice_call(self):
        by_id = {s.id: s for s in resource_labels()}
        self.assertIn("service.version", by_id["prometheus.label.service_version"].operation)
        self.assertIn("elasticsearch.attr.source", by_id["prometheus.label.source"].detail)


# ---- log_attributes ----------------------------------------------------------------

TEMPLATES = '''
internal static class Templates
{
    public const string StepReturned = "the step returned after {ElapsedMs}ms";
    public const string EntryStepCompleted = "the entry step completed with {Result}";
    public const string AdvancedSuccessors = "advanced {SuccessorCount} successor(s) in {ElapsedMs}ms";
    public const string HostShuttingDown = "Application is shutting down...";
}
'''

SCOPE = '''
public static class ExecutionLogScope
{
    public const string WorkflowId  = "WorkflowId";
    public const string StepId      = "StepId";

    public static void BuildScope(Guid workflowId, Guid stepId)
    {
        state[WorkflowId] = workflowId.ToString("D");
        state[StepId]     = stepId.ToString("D");
    }
}
'''

CORRELATION = '''
public static class CorrelationKeys
{
    public const string LogScope = "CorrelationId";
    public static string Render(Guid correlationId) => correlationId.ToString("N");
}
'''


class LogAttributesTests(unittest.TestCase):
    def test_every_placeholder_becomes_its_own_attribute_surface(self):
        surfaces = log_attributes(TEMPLATES, "", "")
        ids = {s.id for s in surfaces}
        self.assertIn("elasticsearch.attr.ElapsedMs", ids)
        self.assertIn("elasticsearch.attr.Result", ids)
        self.assertIn("elasticsearch.attr.SuccessorCount", ids)

    def test_a_template_with_no_placeholders_contributes_no_attribute(self):
        surfaces = log_attributes(TEMPLATES, "", "")
        ids = {s.id for s in surfaces}
        # HostShuttingDown has no {Placeholder}; nothing named after it should appear.
        self.assertFalse(any("HostShuttingDown" in i for i in ids))

    def test_scope_ids_are_keyed_by_value_not_by_member_name(self):
        surfaces = log_attributes("", SCOPE, "")
        ids = {s.id for s in surfaces}
        self.assertIn("elasticsearch.attr.WorkflowId", ids)
        self.assertIn("elasticsearch.attr.StepId", ids)

    def test_correlation_id_is_keyed_by_its_value_not_the_logscope_member_name(self):
        surfaces = log_attributes("", "", CORRELATION)
        ids = {s.id for s in surfaces}
        self.assertIn("elasticsearch.attr.CorrelationId", ids)
        self.assertNotIn("elasticsearch.attr.LogScope", ids)

    def test_the_n_versus_d_format_trap_is_recorded_as_data_on_both_sides(self):
        by_id = {s.id: s for s in log_attributes("", SCOPE, CORRELATION)}
        workflow_detail = by_id["elasticsearch.attr.WorkflowId"].detail
        correlation_detail = by_id["elasticsearch.attr.CorrelationId"].detail
        self.assertIn('"D"', workflow_detail)
        self.assertIn('"N"', correlation_detail)
        # And each one names the other's different format, not just its own.
        self.assertIn("CorrelationId", workflow_detail)
        self.assertIn("ExecutionLogScope", correlation_detail)

    def test_the_envelope_is_always_present_regardless_of_input(self):
        surfaces = log_attributes("", "", "")
        ids = {s.id for s in surfaces}
        self.assertEqual(ids, {
            "elasticsearch.attr.timestamp", "elasticsearch.attr.body_text",
            "elasticsearch.attr.original_format", "elasticsearch.attr.service_name",
            # I5: service.instance.id and Source close the per-replica gap this
            # envelope used to leave -- attr.service_name's own never_for named
            # service_instance_id as the fix with no surface to point at.
            "elasticsearch.attr.service_instance_id", "elasticsearch.attr.source",
            "elasticsearch.attr.scope_name",
        })
        for surface in surfaces:
            self.assertIn("hand-listed", surface.detail)

    def test_the_two_resource_fields_LogRecord_does_not_read_name_their_real_authority(self):
        # I5: LogRecord.cs (FromSource) never reads service.instance.id or Source, so
        # claiming it as their authority (the old uniform wording) would be exactly
        # the kind of unverifiable claim this wave exists to remove.
        by_id = {s.id: s for s in log_attributes("", "", "")}
        self.assertIn("BaseConsoleObservabilityExtensions.cs",
                      by_id["elasticsearch.attr.service_instance_id"].detail)
        self.assertIn("BaseConsoleObservabilityExtensions.cs",
                      by_id["elasticsearch.attr.source"].detail)
        self.assertIn("LogRecord.cs", by_id["elasticsearch.attr.service_name"].detail)


if __name__ == "__main__":
    unittest.main()
