namespace Processor.Analyst.Panels;

/// <summary>Which transport a panel's <see cref="PanelDefinition.Query"/> is written for.</summary>
internal enum PanelKind
{
    Elastic,
    Prometheus,
}

/// <summary>
/// One panel: a query plus enough metadata to describe it to the model. The viz half of a real
/// dashboard panel is deliberately absent — only the query and what it means to a reader matter here.
/// </summary>
/// <param name="PanelId">Stable id. This is the tool argument the model sends, so it must never change once shipped.</param>
/// <param name="Layer">"business" (Elasticsearch, what the workflow did) or "ops" (Prometheus, how the pipeline behaved).</param>
/// <param name="Description">
/// Goes into the system prompt verbatim — the only thing telling the model what this panel means, and
/// where every gotcha a reader would otherwise learn by getting burned belongs.
/// </param>
/// <param name="Kind">Which source executes <see cref="Query"/>.</param>
/// <param name="Query">
/// For <see cref="PanelKind.Prometheus"/>, a raw PromQL expression evaluated with <c>query_range</c>.
/// Carries no <c>{{WORKFLOW}}</c> placeholder and never will: <c>pipeline_*</c> series have no
/// workflow label, and a replica ordinarily serves several workflows at once (see §2.2's amendment in
/// the design doc).
/// For <see cref="PanelKind.Elastic"/>, a <c>_search</c> request body against
/// <see cref="PanelRegistry.ElasticIndex"/>, with <c>{{FROM}}</c>, <c>{{TO}}</c> and
/// <c>{{WORKFLOW}}</c> substituted at read time — the window's bounds (<c>o</c>-formatted, UTC) and
/// the target workflow id (<c>"D"</c>-formatted, matching
/// <c>BaseApi.Tests.Live.Resilience.ElasticLogReader</c>'s own use of the same field).
/// </param>
internal sealed record PanelDefinition(
    string PanelId, string Layer, string Description, PanelKind Kind, string Query);

/// <summary>
/// The compiled panel catalog. A panel here is one this processor can honestly read today, not one
/// that would be nice to have — every addition is a correctness improvement to what the agent can
/// see, and every panel invented without knowing the underlying metric or field actually exists is a
/// liability the agent will report on with the same confidence as a real one.
/// <para>
/// <b>Only the business layer is scoped to the target workflow.</b> Both Elasticsearch queries filter
/// on <c>attributes.WorkflowId</c>, which is also what keeps the Analyst's own dispatches out of its
/// own mirror — this processor is `Service:Name "processor"` like every other, so its own step
/// records would otherwise satisfy <c>attributes.Result:* and not service.name:"orchestrator"</c> and
/// count itself. Ops-layer (Prometheus) panels have no workflow dimension to filter on at all; see
/// each ops panel's own description and <c>IPanelReader.ReadAsync</c>'s doc comment.
/// </para>
/// </summary>
internal static class PanelRegistry
{
    /// <summary>
    /// The data stream every business-layer panel reads. Confirmed by
    /// <c>docs/superpowers/specs/2026-09-22-kibana-operator-dashboard-design.md</c> §3.1.
    /// </summary>
    internal const string ElasticIndex = "logs-generic.otel-default";

    /// <summary>
    /// The rate-window every ops-layer <c>rate()</c>/<c>increase()</c> query uses, matching the
    /// telemetry resolution floor (15s scrape, but a 60s window keeps at least 4 samples under it).
    /// </summary>
    private const string RateWindow = "60s";

    internal static IReadOnlyList<PanelDefinition> All { get; } =
    [
        new PanelDefinition(
            PanelId: "step-outcomes",
            Layer: "business",
            Description:
                "Counts of step outcomes (Completed, Failed, Cancelled) for the target workflow " +
                "specifically, scoped by attributes.WorkflowId and excluding the orchestrator's own " +
                "duplicate records, read from Elasticsearch's attributes.Result field. This is the " +
                "business-layer summary of whether the monitored workflow is succeeding, failing, " +
                "or being cancelled by policy. The Analyst's own step records never appear here: " +
                "they carry the monitor workflow's id, not the target workflow's.",
            Kind: PanelKind.Elastic,
            Query:
                """
                {
                  "size": 0,
                  "track_total_hits": true,
                  "query": {
                    "bool": {
                      "filter": [
                        { "range": { "@timestamp": { "gte": "{{FROM}}", "lte": "{{TO}}" } } },
                        { "exists": { "field": "attributes.Result" } },
                        { "term": { "attributes.WorkflowId": "{{WORKFLOW}}" } }
                      ],
                      "must_not": [
                        { "term": { "resource.attributes.service.name": "orchestrator" } }
                      ]
                    }
                  },
                  "aggs": {
                    "by_result": {
                      "filters": {
                        "filters": {
                          "Completed": { "term": { "attributes.Result": "Completed" } },
                          "Failed": { "term": { "attributes.Result": "Failed" } },
                          "Cancelled": { "term": { "attributes.Result": "Cancelled" } }
                        }
                      }
                    },
                    "earliest": { "min": { "field": "@timestamp" } }
                  }
                }
                """),

        new PanelDefinition(
            PanelId: "step-failures",
            Layer: "business",
            Description:
                "Up to five of the most recent Failed-outcome records (message text, emitting " +
                "scope, step id) for the target workflow specifically, scoped by " +
                "attributes.WorkflowId, alongside the total outcome-record count for the window, " +
                "from Elasticsearch. A cancelled branch is logged at Information and is never a " +
                "failure here -- only attributes.Result: \"Failed\" records for this workflow appear.",
            Kind: PanelKind.Elastic,
            Query:
                """
                {
                  "size": 0,
                  "track_total_hits": true,
                  "query": {
                    "bool": {
                      "filter": [
                        { "range": { "@timestamp": { "gte": "{{FROM}}", "lte": "{{TO}}" } } },
                        { "exists": { "field": "attributes.Result" } },
                        { "term": { "attributes.WorkflowId": "{{WORKFLOW}}" } }
                      ],
                      "must_not": [
                        { "term": { "resource.attributes.service.name": "orchestrator" } }
                      ]
                    }
                  },
                  "aggs": {
                    "failed": {
                      "filter": { "term": { "attributes.Result": "Failed" } },
                      "aggs": {
                        "samples": {
                          "top_hits": {
                            "size": 5,
                            "sort": [ { "@timestamp": "desc" } ],
                            "_source": [
                              "body.text", "scope.name", "attributes.Result",
                              "attributes.StepId", "attributes.WorkflowId", "@timestamp"
                            ]
                          }
                        }
                      }
                    },
                    "earliest": { "min": { "field": "@timestamp" } }
                  }
                }
                """),

        // queue-wait and produce-duration are a matched pair: same estimator (a count-weighted mean,
        // rate(sum)/rate(count) -- never avg() of per-series ratios), same single grouping key
        // (service_instance_id alone). "queue" and "destination" are different label spaces with no
        // given mapping between them, so grouping either panel by its own extra label would make the
        // subtraction the two panels exist for undefined. Replica is the one dimension both
        // instruments share, so it is the only one either panel groups by.
        new PanelDefinition(
            PanelId: "queue-wait",
            Layer: "ops",
            Description:
                "Mean seconds a message sat in the broker before a consumer picked it up, from " +
                "Prometheus, grouped by replica only (service_instance_id, never instance -- " +
                "instance is the scrape target). No workflow dimension: this is host-level " +
                "telemetry for whatever the replica is doing, not scoped to the monitored workflow. " +
                "About 12 of every ~13ms in this number is the sender's own publisher confirm, " +
                "double-counted: subtract the produce-duration panel's mean, for the SAME " +
                "service_instance_id, to get the true broker wait -- both panels use the identical " +
                "estimator and grouping so the subtraction lines up exactly. An empty reading here " +
                "is never distinguishable from a genuinely idle broker; see " +
                "PanelTrust.NoDataDistinguishable's own caveat for why.",
            Kind: PanelKind.Prometheus,
            Query:
                $"sum by (service_instance_id) " +
                $"(rate(pipeline_queue_wait_seconds_sum[{RateWindow}])) / " +
                $"sum by (service_instance_id) " +
                $"(rate(pipeline_queue_wait_seconds_count[{RateWindow}]))"),

        new PanelDefinition(
            PanelId: "produce-duration",
            Layer: "ops",
            Description:
                "Mean seconds a publish call spent waiting on its own broker confirm, from " +
                "Prometheus, grouped by replica only (service_instance_id) -- matching queue-wait's " +
                "grouping and estimator exactly, so queue-wait's mean minus this panel's mean, for " +
                "the same service_instance_id, isolates the time a message actually spent waiting " +
                "in the broker rather than in the sender's own confirm. No workflow dimension: " +
                "host-level telemetry for the replica, not the monitored workflow. An empty reading " +
                "is never distinguishable from a genuinely idle publisher; see " +
                "PanelTrust.NoDataDistinguishable's own caveat for why.",
            Kind: PanelKind.Prometheus,
            Query:
                $"sum by (service_instance_id) " +
                $"(rate(pipeline_produce_duration_seconds_sum[{RateWindow}])) / " +
                $"sum by (service_instance_id) " +
                $"(rate(pipeline_produce_duration_seconds_count[{RateWindow}]))"),

        new PanelDefinition(
            PanelId: "consumer-duration-mean",
            Layer: "ops",
            Description:
                "Mean seconds a delivery was held end to end -- from arrival to whatever the " +
                "consumer decided to do with it -- from Prometheus, grouped by queue, disposition " +
                "and replica (service_instance_id). Disposition is not optional to include: " +
                "collapsing it averages a slow success together with a slow requeue into a number " +
                "describing neither, and during a store outage every bounced delivery is requeued, " +
                "which would read as processing latency if disposition were dropped. Read the mean, " +
                "not a quantile: the bucket ladder is coarser than the system at typical sample " +
                "counts. No workflow dimension: host-level telemetry for the replica, not the " +
                "monitored workflow specifically. An empty series is never distinguishable from a " +
                "genuinely idle replica; see PanelTrust.NoDataDistinguishable's own caveat for why.",
            Kind: PanelKind.Prometheus,
            Query:
                $"sum by (queue, disposition, service_instance_id) " +
                $"(rate(pipeline_consumer_duration_seconds_sum[{RateWindow}])) / " +
                $"sum by (queue, disposition, service_instance_id) " +
                $"(rate(pipeline_consumer_duration_seconds_count[{RateWindow}]))"),

        new PanelDefinition(
            PanelId: "processor-liveness",
            Layer: "ops",
            Description:
                "Whether each replica's identity was ready over the trailing 40 seconds (1 = " +
                "ready), from Prometheus, grouped by replica (service_instance_id -- the pod name, " +
                "so never compare it across a restart). No workflow dimension: a replica serves " +
                "whatever workflows are assigned to it. A replica that drops out of this panel's " +
                "series entirely has stopped reporting, which is a different failure than reporting " +
                "unready -- and because this is Prometheus, that silence is never distinguishable " +
                "from a genuinely idle series; see PanelTrust.NoDataDistinguishable's own caveat.",
            Kind: PanelKind.Prometheus,
            Query: "min by (service_instance_id) (last_over_time(pipeline_identity_ready_ratio[40s]))"),
    ];
}
