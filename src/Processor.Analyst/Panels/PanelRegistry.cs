using Messaging.Contracts;

namespace Processor.Analyst.Panels;

/// <summary>Which transport a panel's <see cref="PanelDefinition.Query"/> is written for.</summary>
internal enum PanelKind
{
    Elastic,
    Prometheus,

    /// <summary>One or more ES|QL statements posted to <c>/_query</c>; see <see cref="PanelDefinition.Query"/>.</summary>
    Esql,
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
/// For <see cref="PanelKind.Esql"/>, one or more ES|QL statements separated by a line holding only
/// <c>---</c>, each posted to <c>/_query</c> in order, with the same three placeholders.
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
/// <para>
/// <b>THE MAINTENANCE RULE: a panel added to an operator dashboard needs its counterpart here, or
/// the shared language has a hole. NOTHING ENFORCES THIS.</b> The stated design intent — written on
/// <c>ProcessorRow.description</c>, <c>ContractPrompt</c>, <see cref="PanelDefinition"/>,
/// <c>IPanelReader</c> and <c>AnalystConfig.WindowMinutes</c> — is that the Analyst reads the same
/// panels an operator reads: same query, same data, same window, only the rendering differing. But
/// the agent never reads Kibana or Grafana. Every <see cref="PanelDefinition"/> is a hand-written C#
/// re-expression of a dashboard panel, so this is two clients over one database, agreeing only
/// because a human keeps them agreeing. There is no test, no generator and no schema between them;
/// the failure mode is not a broken build but an agent that reads every board it has, finds them
/// clean, and reports no finding over the one metric that would have explained the incident.
/// </para>
/// <para>
/// <b>Audited 2026-09-26, and the gap is wide.</b> (Every metric named below was confirmed present
/// in the live Prometheus at audit time rather than copied from a note — the whole point of this
/// registry is that a panel naming a series that does not exist reads as a confident all-clear.) The operator has 5 Kibana panels and ~60 Grafana
/// panels over ~14 distinct <c>pipeline_*</c> metrics; this registry has 8. Nine metrics the operator
/// can see still have no counterpart here, and three of them are this agent's own recurring failure
/// modes — it can observe that queue wait rose and cannot see that the L2 gate was shut
/// (<c>pipeline_gate_open_ratio</c>, <c>pipeline_gate_trips_total</c>), that the queue was backed up
/// (<c>pipeline_queue_depth</c>), or that a pod restarted inside the same window
/// (<c>pipeline_process_start_timestamp_seconds</c>). Also absent:
/// <c>pipeline_messages_consumed_total</c> (requeue storms), <c>pipeline_messages_produced_total</c>,
/// <c>pipeline_queue_consumers</c> (a queue with no consumer attached),
/// <c>pipeline_gate_probe_duration_seconds</c> (a histogram — only <c>_bucket</c>, <c>_sum</c> and
/// <c>_count</c> series exist, so the bare name matches nothing, exactly as for queue-wait's
/// instrument), <c>pipeline_leader_ratio</c> /
/// <c>pipeline_hydration_admitted_ratio</c>, and the whole <c>skp-baseapi</c> board (5xx, p95,
/// exception rate). On the business side, Kibana's "Whitelist verdicts by value" has no counterpart
/// either. In priority order the next three are <c>gate-open</c>, <c>queue-depth</c> and
/// <c>restarts</c>: they are the panels that explain what the agent already observes.
/// </para>
/// <para>
/// <b>The pair that closed the first hole is worth copying as a shape.</b>
/// <c>refused-messages</c> was added because the session that gave the operator a Kibana refusals
/// panel left the agent without one — the drift happening in real time, in the same session that
/// documented it. Two things made it safe to add: the selector it matches on is a compiled constant
/// shared with the emitter (<see cref="RefusalTemplates"/>), not a literal retyped into the query;
/// and its query was executed against the live store before shipping, because a panel invented
/// without confirming the field or metric exists is a liability the agent will report on with the
/// same confidence as a real one.
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
                "service_instance_id, to approximate the true broker wait -- both panels use the " +
                "identical estimator and grouping, which makes the subtraction meaningful, but it " +
                "remains an approximation because the two instruments count different message " +
                "populations (consumed versus published) over the same window. An empty reading " +
                "here is never distinguishable from a genuinely idle broker; see " +
                "PanelTrust.NoDataDistinguishable's own caveat for why. The reading also carries " +
                "seriesCount: how many replicas reported at all in this window. A replica missing " +
                "from the response entirely cannot be counted, so seriesCount is a floor, not a " +
                "census -- a drop in it is meaningful, but a steady value is not proof every " +
                "expected replica is present.",
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
                "the same service_instance_id, approximates the time a message actually spent " +
                "waiting in the broker rather than in the sender's own confirm. It is an " +
                "approximation, not an exact join: the two instruments count different message " +
                "populations (published here versus consumed on queue-wait) over the same window, " +
                "not the same individual messages. No workflow dimension: host-level telemetry for " +
                "the replica, not the monitored workflow. An empty reading is never distinguishable " +
                "from a genuinely idle publisher; see PanelTrust.NoDataDistinguishable's own caveat " +
                "for why. The reading also carries seriesCount: how many replicas reported at all in " +
                "this window. A replica missing from the response entirely cannot be counted, so " +
                "seriesCount is a floor, not a census -- a drop in it is meaningful, but a steady " +
                "value is not proof every expected replica is present.",
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
                "genuinely idle replica; see PanelTrust.NoDataDistinguishable's own caveat for why. " +
                "The reading also carries seriesCount: how many replicas reported at all in this " +
                "window. A replica missing from the response entirely cannot be counted, so " +
                "seriesCount is a floor, not a census -- a drop in it is meaningful, but a steady " +
                "value is not proof every expected replica is present.",
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
                "from a genuinely idle series; see PanelTrust.NoDataDistinguishable's own caveat. " +
                "The reading also carries seriesCount: how many replicas reported at all in this " +
                "window. A replica missing from the response entirely cannot be counted, so " +
                "seriesCount is a floor, not a census -- a drop in it is meaningful, but a steady " +
                "value is not proof every expected replica is present.",
            Kind: PanelKind.Prometheus,
            Query: "min by (service_instance_id) (last_over_time(pipeline_identity_ready_ratio[40s]))"),

        // THE ONE PANEL THAT SHOWS WORK THAT WAS THROWN AWAY. Every other panel here reports what
        // the pipeline DID -- an outcome it recorded, a latency it measured. A message refused by
        // GatedQueueConsumer and dead-lettered produced no StepOutcome at all, so it is invisible to
        // step-outcomes and step-failures by construction (both require attributes.Result), and it
        // moves no latency series. Without this panel the agent can read every other board clean and
        // call report_no_finding over a window in which the deployment was silently losing work --
        // which is exactly the "confident quiet result over a blind spot" IPanelReader warns about.
        new PanelDefinition(
            PanelId: "dead-letter-depth",
            Layer: "ops",
            Description:
                "How many messages are sitting in each dead-letter queue right now: work that was " +
                "refused and has not been dealt with, from Prometheus, grouped by queue. This is a " +
                "LEVEL, not a rate -- a parked message stays counted until a human drains the " +
                "queue, so a non-zero value means the loss is still outstanding, however long ago " +
                "it happened. Grouped with max rather than sum because every replica of a role " +
                "probes the SAME shared queue and reports the same number: summing three " +
                "orchestrator replicas turns a depth of 10 into 30. No workflow dimension: a " +
                "dead-letter queue belongs to a queue, not to a workflow, so this panel says work " +
                "was lost but never whose -- the refusal log records carry the workflow id and this " +
                "panel cannot show them. " +
                "ZERO HERE IS A REPORT, WHICH IS THE OPPOSITE OF EVERY OTHER PROMETHEUS PANEL ON " +
                "THIS LIST: the probe publishes 0 explicitly for a queue it read and found empty, " +
                "so a series present and reading 0 IS a confirmed all-clear and is distinguishable " +
                "from a blind spot. A series that is ABSENT is not: it means no process is probing " +
                "that queue at all -- every replica of its owner is down, or the instrument was " +
                "never wired -- which is a gap in the evidence, not an empty queue. Do not read a " +
                "missing queue as a healthy one. In a healthy deployment nearly every series is a " +
                "flat zero; a non-zero series, a rising one, or one that disappears is the signal. " +
                "The reading also carries seriesCount: how many dead-letter queues reported at all " +
                "in this window. It is a floor, not a census -- a queue whose owning process is " +
                "entirely down cannot report and cannot be counted, so a steady seriesCount is not " +
                "proof every expected queue is present. " +
                "The probe behind it runs on a five-minute backstop and is also read immediately " +
                "whenever something is parked, so a new park shows up promptly while a manual drain " +
                "can take up to five minutes to appear.",
            Kind: PanelKind.Prometheus,
            Query: "max by (queue) (pipeline_deadletter_depth)"),

        // THE BUSINESS COUNTERPART TO dead-letter-depth, AND THE ONLY PANEL THAT CAN SAY WHOSE WORK
        // WAS LOST. The two are deliberately not redundant: depth is a level with no attribution,
        // this is an event stream scoped to one workflow. Added because the session that gave the
        // operator a Kibana refusals panel left the agent without a counterpart -- which is exactly
        // the drift this registry has no detector for. See the maintenance rule above.
        new PanelDefinition(
            PanelId: "refused-messages",
            Layer: "business",
            Description:
                "Messages the pipeline REFUSED for the target workflow: work that was thrown away " +
                "rather than completed or failed, from Elasticsearch, counted by queue and split " +
                "into the two outcomes a refusal can have, with up to five of the most recent " +
                "records and the exception that caused each one. A refused message produces no " +
                "StepOutcome at all, so it is invisible to step-outcomes and step-failures by " +
                "construction -- both require attributes.Result and a refusal has none. " +
                "THE TWO OUTCOMES MEAN DIFFERENT THINGS AND THE DIFFERENCE IS ACTIONABLE: " +
                "`parked` means the broker was told, so the message IS in that queue's dead-letter " +
                "queue and can be recovered; `notParked` means the channel died before the broker " +
                "heard the rejection, so the message was REDELIVERED instead and there is nothing " +
                "in a dead-letter queue to go and look at -- do not send anyone hunting for it. " +
                "EVENTS IN THIS WINDOW, NOT A LEVEL, which is the whole difference from " +
                "dead-letter-depth: that panel reports how many messages are sitting in each " +
                "dead-letter queue right now, with no attribution at all, however long ago they " +
                "got there. Read the pair together. Refusals here with depth flat means the parks " +
                "are landing elsewhere or being drained; depth above zero with no refusals here " +
                "means loss that is still outstanding but happened before this window or belonged " +
                "to another workflow; refusals here AND rising depth means this workflow is losing " +
                "work right now. " +
                "A zero here is a genuine all-clear whenever the reading is trusted, because the " +
                "query counts every record for this workflow in the window and narrows to refusals " +
                "only inside the aggregation: totalWorkflowRecords above zero proves the workflow " +
                "was reporting, which makes refusedCount zero a fact rather than a silence. " +
                "Its two limits both make it UNDER-report. A refusal that carries no workflow id " +
                "is invisible here, because the id reaches the record only through the delivery's " +
                "own headers and a message parked before the sender stamped them carries none -- " +
                "that is real lost work this panel cannot see, and dead-letter-depth is the " +
                "cross-check, because a queue depth needs no attribution to be counted. And " +
                "byQueue keeps only the ten busiest queues, so a wide spread of single refusals " +
                "can be undercounted there while refusedCount still totals them all. " +
                "Samples carry the exception type and message -- which is WHY the message was " +
                "refused, and the most useful field on the record -- but never the stack trace.",
            Kind: PanelKind.Elastic,
            Query: WithRefusalTemplates(
                """
                {
                  "size": 0,
                  "track_total_hits": true,
                  "query": {
                    "bool": {
                      "filter": [
                        { "range": { "@timestamp": { "gte": "{{FROM}}", "lte": "{{TO}}" } } },
                        { "term": { "attributes.WorkflowId": "{{WORKFLOW}}" } }
                      ]
                    }
                  },
                  "aggs": {
                    "refusals": {
                      "filter": {
                        "terms": {
                          "attributes.{OriginalFormat}": [ "$PARKED$", "$NOT_PARKED$" ]
                        }
                      },
                      "aggs": {
                        "by_queue": {
                          "terms": {
                            "field": "attributes.Queue",
                            "size": 10,
                            "missing": "(unnamed queue)"
                          }
                        },
                        "by_outcome": {
                          "filters": {
                            "filters": {
                              "parked": {
                                "term": { "attributes.{OriginalFormat}": "$PARKED$" }
                              },
                              "notParked": {
                                "term": { "attributes.{OriginalFormat}": "$NOT_PARKED$" }
                              }
                            }
                          }
                        },
                        "samples": {
                          "top_hits": {
                            "size": 5,
                            "sort": [ { "@timestamp": "desc" } ],
                            "_source": [
                              "@timestamp", "attributes.Queue", "attributes.Type",
                              "attributes.exception.type", "attributes.exception.message",
                              "attributes.StepId", "attributes.ProcessorId",
                              "attributes.{OriginalFormat}"
                            ]
                          }
                        }
                      }
                    },
                    "earliest": { "min": { "field": "@timestamp" } }
                  }
                }
                """)),

        // THE AGENT'S COUNTERPART TO THE OPERATOR'S FUNNEL ON THE KIBANA BOARD. Both count the same
        // thing: for the fires whose entry record falls in the range, the outcome handler's one record
        // per returned outcome (OutcomeTemplates), by the step's StepRole and name. Three ES|QL
        // statements, split on a line holding only "---" and posted to /_query in order: scope and
        // fires (statement 1 counts every record of the workflow, the trust scope), funnel, polls. Keep this in step with the board -- the maintenance rule above is the only
        // thing that detects drift between them.
        new PanelDefinition(
            PanelId: "run-boundaries",
            Layer: "business",
            Description:
                "The workflow's funnel for the fires that entered in this window: how many outcomes " +
                "each step returned, with each step's role in the graph (entry, intermediate, " +
                "terminal). A step's count against its predecessors' is where items dropped — " +
                "failures routed elsewhere, cancellations ending in place. terminal means a step with " +
                "no successors returned an outcome, not that a branch ended. fires is the number of " +
                "fires that entered; pollsThatImported and drainedPolls split the importer's polls. " +
                "A stall is the funnel stopping after entry. A fire still running at the window's end " +
                "has not returned its later outcomes yet. totalWorkflowRecords is every record the " +
                "workflow logged in the window; at zero nothing was reported at all, which cannot be " +
                "told apart from logging that is not reaching the store. roleRecords is how many of " +
                "those carry a StepRole; roleRecords 0 with records present means the workflow has not " +
                "been restarted since StepRole was deployed; its funnel cannot be read.",
            Kind: PanelKind.Esql,
            Query: WithOutcomeTemplates(
                """
                FROM logs-generic.otel-default
                | WHERE @timestamp >= "{{FROM}}" AND @timestamp <= "{{TO}}" AND attributes.WorkflowId == "{{WORKFLOW}}"
                | STATS totalWorkflowRecords = COUNT(*), roleRecords = COUNT(*) WHERE attributes.$ROLE$ IS NOT NULL, fires = COUNT_DISTINCT(attributes.CorrelationId) WHERE attributes.$ROLE$ == "$ENTRY$", earliest = MIN(@timestamp) WHERE attributes.$ROLE$ == "$ENTRY$"
                ---
                FROM logs-generic.otel-default
                | WHERE @timestamp >= "{{FROM}}" AND @timestamp <= "{{TO}}" AND attributes.WorkflowId == "{{WORKFLOW}}" AND attributes.$ROLE$ IS NOT NULL
                | EVAL entered = CASE(attributes.$ROLE$ == "$ENTRY$", 1, 0),
                       counted = CASE(attributes.`{OriginalFormat}` IN ("$BRANCH_ENDS$", "$ADVANCED$"), 1, 0)
                | INLINE STATS fire_entered = MAX(entered) BY attributes.CorrelationId
                | WHERE fire_entered == 1 AND counted == 1
                | STATS outcomes = COUNT(*) BY attributes.$ROLE$, attributes.StepName
                | SORT outcomes DESC
                ---
                FROM logs-generic.otel-default
                | WHERE @timestamp >= "{{FROM}}" AND @timestamp <= "{{TO}}" AND attributes.WorkflowId == "{{WORKFLOW}}" AND attributes.`{OriginalFormat}` == "consumed {Consumed}/{Requested} records; stopped because {Reason}"
                | STATS importerPolls = COUNT(*), drainedPolls = SUM(CASE(attributes.Consumed == 0, 1, 0))
                """)),
    ];

    /// <summary>
    /// Substitutes the refusal templates into a panel query once, at type-initialisation time.
    /// <para>
    /// <b>A different placeholder syntax from <c>{{FROM}}</c>, deliberately.</b> The double-brace
    /// placeholders are substituted per READ by <see cref="ElasticPanelSource"/>, from the dispatch's
    /// own window and target workflow. These are substituted once, here, from a compiled constant --
    /// spelling them the same way would send a reader looking for them in the read path, where they
    /// are not and must never be.
    /// </para>
    /// <para>
    /// <b>Why substituted rather than written out.</b> The refusal templates are the only identifier
    /// a refused message has, and a literal copy here would be one no compiler holds to the emitter:
    /// the panel would go on returning a confident, trusted zero while the consumer logged something
    /// else. See <see cref="RefusalTemplates"/> and <c>RefusalTemplateTests</c>.
    /// </para>
    /// </summary>
    private static string WithRefusalTemplates(string query) => query
        .Replace("$PARKED$", RefusalTemplates.Parked, StringComparison.Ordinal)
        .Replace("$NOT_PARKED$", RefusalTemplates.NotParked, StringComparison.Ordinal);

    /// <summary>
    /// Substitutes the outcome handler's two per-outcome templates, and the step-role key and its
    /// entry value, into a panel query once, at type-initialisation time — the same compile-time
    /// substitution, and for the same reason, as <see cref="WithRefusalTemplates"/>: the orchestrator
    /// writes these values and a dashboard and this panel both select on them, so a literal retyped
    /// here would be a copy no compiler holds to the emitter.
    /// </summary>
    private static string WithOutcomeTemplates(string query) => query
        .Replace("$ROLE$", StepRoles.Key, StringComparison.Ordinal)
        .Replace("$ENTRY$", StepRoles.Entry, StringComparison.Ordinal)
        .Replace("$BRANCH_ENDS$", OutcomeTemplates.BranchEnds, StringComparison.Ordinal)
        .Replace("$ADVANCED$", OutcomeTemplates.Advanced, StringComparison.Ordinal);
}
