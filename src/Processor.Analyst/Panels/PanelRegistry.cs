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
/// For <see cref="PanelKind.Elastic"/>, a <c>_search</c> request body against
/// <see cref="PanelRegistry.ElasticIndex"/>, with <c>{{FROM}}</c> and <c>{{TO}}</c> substituted at
/// read time with the requested window's bounds (<c>o</c>-formatted, UTC).
/// </param>
internal sealed record PanelDefinition(
    string PanelId, string Layer, string Description, PanelKind Kind, string Query);

/// <summary>
/// The compiled panel catalog. A panel here is one this processor can honestly read today, not one
/// that would be nice to have — every addition is a correctness improvement to what the agent can
/// see, and every panel invented without knowing the underlying metric or field actually exists is a
/// liability the agent will report on with the same confidence as a real one.
/// <para>
/// <b>Not scoped to a specific workflow.</b> <see cref="IPanelReader.ReadAsync"/> takes only a panel
/// id and a <see cref="TimeRange"/> — <c>AnalystConfig.TargetWorkflowId</c> never reaches a panel
/// source, only the model's own transcript (see <c>InvestigationLoop.RunAsync</c>'s opening user
/// turn). The business-layer panels below therefore read every workflow's outcomes in the window, not
/// only the monitored one. That is a real limitation of the frozen <c>IPanelReader</c> contract, not
/// an oversight in these queries — narrowing it needs a signature change to a Task 6 interface, which
/// is out of this task's scope. See the Task 14 report.
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
                "Counts of step outcomes (Completed, Failed, Cancelled) emitted by every " +
                "non-orchestrator processor in the window, read from Elasticsearch's " +
                "attributes.Result field. This is the business-layer summary of whether the " +
                "monitored workflow is succeeding, failing, or being cancelled by policy.",
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
                        { "exists": { "field": "attributes.Result" } }
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
                "scope, step id and workflow id) alongside the total failure count for the window, " +
                "from Elasticsearch. A cancelled branch is logged at Information and is never a " +
                "failure here -- only attributes.Result: \"Failed\" records appear.",
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
                        { "exists": { "field": "attributes.Result" } }
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

        new PanelDefinition(
            PanelId: "queue-wait",
            Layer: "ops",
            Description:
                "Mean seconds a message sat in the broker before a consumer picked it up, from " +
                "Prometheus, grouped by queue and replica (service_instance_id, never instance -- " +
                "instance is the scrape target). About 12 of every ~13ms in this number is the " +
                "sender's own publisher confirm, double-counted: subtract the produce-duration " +
                "panel's mean from this one, for the same queue/replica, to get the true broker wait.",
            Kind: PanelKind.Prometheus,
            Query:
                $"avg by (queue, service_instance_id) " +
                $"(rate(pipeline_queue_wait_seconds_sum[{RateWindow}]) / " +
                $"rate(pipeline_queue_wait_seconds_count[{RateWindow}]))"),

        new PanelDefinition(
            PanelId: "produce-duration",
            Layer: "ops",
            Description:
                "Mean seconds a publish call spent waiting on its own broker confirm, from " +
                "Prometheus, grouped by destination and replica. This is the value to subtract " +
                "from queue-wait's mean, for the same replica, to isolate the time a message " +
                "actually spent waiting in the broker rather than in the sender's own confirm.",
            Kind: PanelKind.Prometheus,
            Query:
                $"sum by (destination, service_instance_id) " +
                $"(rate(pipeline_produce_duration_seconds_sum[{RateWindow}])) / " +
                $"sum by (destination, service_instance_id) " +
                $"(rate(pipeline_produce_duration_seconds_count[{RateWindow}]))"),

        new PanelDefinition(
            PanelId: "arrival-mean",
            Layer: "ops",
            Description:
                "Mean seconds a delivery was held end to end -- from arrival to whatever the " +
                "consumer decided to do with it (acked, requeued or parked) -- from Prometheus, " +
                "grouped by replica. Read the mean, not a quantile: the bucket ladder is coarser " +
                "than the system at typical sample counts, so a quantile panel on this instrument " +
                "flips between two adjacent buckets rather than measuring anything real.",
            Kind: PanelKind.Prometheus,
            Query:
                $"sum by (service_instance_id) " +
                $"(rate(pipeline_consumer_duration_seconds_sum[{RateWindow}])) / " +
                $"sum by (service_instance_id) " +
                $"(rate(pipeline_consumer_duration_seconds_count[{RateWindow}]))"),

        new PanelDefinition(
            PanelId: "processor-liveness",
            Layer: "ops",
            Description:
                "Whether each replica's identity was ready over the trailing 40 seconds (1 = " +
                "ready), from Prometheus, grouped by replica (service_instance_id -- the pod name, " +
                "so never compare it across a restart). A replica that drops out of this panel's " +
                "series entirely has stopped reporting, which is a different failure than reporting " +
                "unready and must not be read as the same thing.",
            Kind: PanelKind.Prometheus,
            Query: "min by (service_instance_id) (last_over_time(pipeline_identity_ready_ratio[40s]))"),
    ];
}
