using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Messaging.Contracts;

namespace Processor.Analyst.Panels;

/// <summary>
/// Executes a business-layer <see cref="PanelDefinition"/> against Elasticsearch and turns the
/// response into a <see cref="PanelReading"/> with its trust flags computed.
/// <para>
/// <b>The trust decision this class makes:</b> every panel query here is written against the SAME
/// broad scope -- every outcome record for the target workflow (<c>attributes.Result</c> present,
/// <c>attributes.WorkflowId</c> matching, emitter not the orchestrator) in the window -- and only
/// narrows to the panel's specific interest inside an aggregation. That is what lets
/// <c>hits.total.value</c> answer "did anything get reported at all" independently of whether the
/// panel's own slice of it happens to be zero:
/// </para>
/// <list type="bullet">
/// <item><description>
/// <c>hits.total.value == 0</c> -- no outcome record of any kind in the window. Indistinguishable
/// from a blind spot (nothing reported), so <c>SeriesPresent</c>, <c>WindowFullyCovered</c> and
/// <c>NoDataDistinguishable</c> are all <c>false</c> -- matching the same-panel convention
/// <c>FixturePanelReader.MissingSeries</c> already uses for an absent series.
/// </description></item>
/// <item><description>
/// <c>hits.total.value > 0</c> -- the pipeline is reporting outcomes in this window, so a
/// panel-specific bucket reading zero (no failures; a Cancelled bucket with no hits) is a genuine
/// zero, not a gap. <c>SeriesPresent</c> and <c>NoDataDistinguishable</c> are both <c>true</c>.
/// </description></item>
/// </list>
/// <para>
/// This is the case the brief calls out as "generally drawable" on Elasticsearch, unlike Prometheus
/// (see <see cref="PrometheusPanelSource"/>): a clean zero-count aggregation differs structurally
/// from an absent index or a query error, both of which are transport failures here and become
/// <see cref="PanelUnavailableException"/> rather than a poor-trust reading.
/// </para>
/// </summary>
internal sealed class ElasticPanelSource
{
    /// <summary>
    /// How far the earliest document in the window may sit after <c>range.From</c> and still count
    /// as the window being fully covered. Generous relative to ingest lag (memory: the live suite's
    /// two-minute window is already tight) -- this is asking "did the data stream actually reach
    /// back to the start of what was requested", not policing second-level precision.
    /// </summary>
    private static readonly TimeSpan CoverageTolerance = TimeSpan.FromMinutes(2);

    private readonly HttpClient _http;

    public ElasticPanelSource(HttpClient httpClient, IOptions<PanelSourceOptions> options)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ArgumentNullException.ThrowIfNull(options);

        _http = httpClient;

        var baseUrl = options.Value.ElasticBaseUrl;
        if (!string.IsNullOrWhiteSpace(baseUrl))
        {
            try
            {
                _http.BaseAddress = new Uri(baseUrl, UriKind.Absolute);
            }
            catch (UriFormatException ex)
            {
                // F3: consistent with LivePanelReader.Find -- a configuration problem that means
                // this source cannot be used is the same domain failure as one it cannot reach, so
                // it is this same exception type rather than a raw framework one.
                throw new PanelUnavailableException(
                    "elasticsearch", $"Analyst:Panels:ElasticBaseUrl is malformed: {ex.Message}");
            }
        }
    }

    internal async Task<PanelReading> ReadAsync(
        PanelDefinition definition, Guid targetWorkflowId, TimeRange range, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(definition);

        if (definition.Kind == PanelKind.Esql)
        {
            return await ReadEsqlAsync(definition, targetWorkflowId, range, ct).ConfigureAwait(false);
        }

        var body = Substitute(definition.Query, targetWorkflowId, range);
        var text = await PostAsync(definition, $"/{PanelRegistry.ElasticIndex}/_search", body, ct).ConfigureAwait(false);

        return Parse(definition, range, text);
    }

    /// <summary>
    /// Reads a <see cref="PanelKind.Esql"/> panel: each statement in <see cref="PanelDefinition.Query"/>
    /// (separated by a line holding only <c>---</c>) is posted to <c>/_query</c> in order, through the
    /// same transport and failure mapping as the <c>_search</c> path, and its
    /// <c>{"columns":[...],"values":[[...]]}</c> response is read by COLUMN NAME, never by position.
    /// </summary>
    internal async Task<PanelReading> ReadEsqlAsync(
        PanelDefinition definition, Guid targetWorkflowId, TimeRange range, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(definition);

        var statements = definition.Query
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split("\n---\n");

        var tables = new List<IReadOnlyList<IReadOnlyDictionary<string, JsonElement>>>(statements.Length);
        foreach (var statement in statements)
        {
            // Serialized, not spliced: the statement carries double quotes and the backticked
            // {OriginalFormat} field, and must reach Elasticsearch as one JSON string.
            var body = JsonSerializer.Serialize(new { query = Substitute(statement.Trim(), targetWorkflowId, range) });
            // allow_partial_results=false: a shard that cannot answer fails the request instead of
            // silently shrinking the counts. ParseEsqlRows still refuses is_partial as a second guard.
            var text = await PostAsync(definition, "/_query?allow_partial_results=false", body, ct).ConfigureAwait(false);
            tables.Add(ParseEsqlRows(definition.PanelId, text));
        }

        return definition.PanelId switch
        {
            "run-boundaries" => BuildEdges(definition, range, tables),
            "failure-causes" => BuildFailureCauses(definition, range, tables),
            _ => throw new PanelUnavailableException(
                definition.PanelId, $"no ES|QL response parser registered for panel '{definition.PanelId}'"),
        };
    }

    /// <summary>
    /// The bucket width that keeps a range within 48 buckets, never below a minute (spec 4.3).
    /// <para>
    /// Divides by 47, not 48: DATE_TRUNC aligns buckets to the clock, not to the range start, so a range
    /// that does not begin on a bucket boundary spans one bucket more than range/width. 47 intervals keep
    /// any alignment within 48. The same rule as the Prometheus history step.
    /// </para>
    /// </summary>
    internal static string BucketFor(TimeRange range)
    {
        var minutes = (int)Math.Max(1, Math.Ceiling((range.To - range.From).TotalMinutes / 47));
        return minutes == 1 ? "1 minute" : $"{minutes} minutes";
    }

    private static string Substitute(string query, Guid targetWorkflowId, TimeRange range) => query
        .Replace("{{FROM}}", range.From.UtcDateTime.ToString("o"), StringComparison.Ordinal)
        .Replace("{{TO}}", range.To.UtcDateTime.ToString("o"), StringComparison.Ordinal)
        .Replace("{{WORKFLOW}}", targetWorkflowId.ToString("D"), StringComparison.Ordinal)
        .Replace("{{BUCKET}}", BucketFor(range), StringComparison.Ordinal);

    private static PanelReading BuildFailureCauses(
        PanelDefinition definition, TimeRange range,
        IReadOnlyList<IReadOnlyList<IReadOnlyDictionary<string, JsonElement>>> tables)
    {
        var id = definition.PanelId;
        if (tables.Count != 2)
        {
            throw new PanelUnavailableException(id, $"expected 2 ES|QL statements (causes, buckets), got {tables.Count}");
        }

        var causes = tables[0].Select(r => new
        {
            step = Text(id, r, "attributes.StepName"),
            logged = Text(id, r, "logged"),
            cause = Text(id, r, "cause"),
            count = Long(id, r, "count"),
            firstSeen = Date(id, r, "first_seen"),
            lastSeen = Date(id, r, "last_seen"),
        }).ToList();

        var buckets = tables[1].Select(r =>
        {
            var imported = Long(id, r, "imported");
            var failed = Long(id, r, "failed");
            return new
            {
                start = Date(id, r, "bucket"),
                imported,
                failed,
                cancelled = Long(id, r, "cancelled"),
                failedShare = imported == 0 ? 0.0 : Math.Round((double)failed / imported, 3),
            };
        }).ToList();

        var valueJson = JsonSerializer.Serialize(new { bucket = BucketFor(range), causes, buckets });
        var failures = (int)causes.Sum(c => c.count);
        var reporting = buckets.Count > 0;

        return new PanelReading(id, definition.Layer, valueJson, SampleCount: failures,
            new PanelTrust(SeriesPresent: reporting, WindowFullyCovered: reporting, NoDataDistinguishable: reporting));
    }

    /// <summary>
    /// One POST to Elasticsearch, with every transport failure and every non-success status turned
    /// into <see cref="PanelUnavailableException"/>. Shared by the <c>_search</c> and ES|QL paths.
    /// </summary>
    private async Task<string> PostAsync(PanelDefinition definition, string path, string body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            // DNS, TCP, TLS, connection refused -- including the dead-port-forward case, where the
            // socket is bound but refuses the connection outright.
            throw new PanelUnavailableException(definition.PanelId, $"elasticsearch could not be reached: {ex.Message}");
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // The request's own timeout, not the caller's cancellation -- that case propagates
            // untouched so the loop's own cancellation handling still sees it as such.
            throw new PanelUnavailableException(definition.PanelId, $"elasticsearch timed out: {ex.Message}");
        }
        catch (InvalidOperationException ex)
        {
            // HttpClient throws this -- not HttpRequestException -- when it is handed a relative URI
            // and has no BaseAddress: a null or blank Analyst:Panels:ElasticBaseUrl. That is exactly
            // as much "the source could not be reached" as a refused connection, and must land in the
            // same domain channel rather than escaping the loop as a raw framework exception.
            throw new PanelUnavailableException(definition.PanelId, $"elasticsearch is not configured: {ex.Message}");
        }

        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                throw new PanelUnavailableException(
                    definition.PanelId, $"elasticsearch returned {(int)response.StatusCode}: {Truncate(text)}");
            }

            return text;
        }
    }

    /// <summary>
    /// The response-to-reading translation, split out from <see cref="ReadAsync"/> so
    /// <c>PanelTrustTests</c> can drive it directly from a committed fixture without any HTTP
    /// machinery in the way.
    /// </summary>
    internal static PanelReading Parse(PanelDefinition definition, TimeRange range, string responseJson)
    {
        ArgumentNullException.ThrowIfNull(definition);
        ArgumentNullException.ThrowIfNull(responseJson);

        using var doc = ParseJson(definition.PanelId, responseJson);
        var root = doc.RootElement;

        if (root.TryGetProperty("error", out var errorElement))
        {
            throw new PanelUnavailableException(
                definition.PanelId, $"elasticsearch reported an error: {Truncate(errorElement.ToString())}");
        }

        var timedOut = root.TryGetProperty("timed_out", out var timedOutElement) && timedOutElement.GetBoolean();
        var shardsFailed = root.TryGetProperty("_shards", out var shardsElement)
            && shardsElement.TryGetProperty("failed", out var failedElement)
            && failedElement.GetInt32() > 0;

        if (timedOut || shardsFailed)
        {
            // A degraded 200 -- partial shard failure or a timeout mid-aggregation. The counts in a
            // response like this cannot be told apart from an undercount, so this is a transport
            // failure, not a poor-trust reading.
            throw new PanelUnavailableException(
                definition.PanelId, "elasticsearch returned a partial or timed-out response");
        }

        long total;
        try
        {
            total = root.GetProperty("hits").GetProperty("total").GetProperty("value").GetInt64();
        }
        catch (KeyNotFoundException ex)
        {
            throw new PanelUnavailableException(definition.PanelId, $"unexpected elasticsearch response shape: {ex.Message}");
        }

        if (total == 0)
        {
            // Not one record in the window that this panel's scope admits -- indistinguishable from a
            // blind spot. Matches FixturePanelReader.MissingSeries: all three flags false together.
            //
            // Named per panel rather than shared, because the panels do not all count the same thing.
            // step-outcomes and step-failures scope to outcome records; refused-messages scopes to
            // every record for the workflow, since a refusal has no attributes.Result to require and
            // a scope narrowed to refusals could not tell an all-clear from an ingest outage. Calling
            // that 0 "outcome records" would be a small dishonesty the model has no way to check.
            return new PanelReading(
                definition.PanelId, definition.Layer,
                $"{{\"{ScopeCountName(definition.PanelId)}\":0}}", SampleCount: 0,
                new PanelTrust(SeriesPresent: false, WindowFullyCovered: false, NoDataDistinguishable: false));
        }

        var aggregations = root.GetProperty("aggregations");
        var windowFullyCovered = IsWindowFullyCovered(aggregations, range);

        return definition.PanelId switch
        {
            "step-outcomes" => BuildStepOutcomes(definition, total, aggregations, windowFullyCovered),
            "step-failures" => BuildStepFailures(definition, total, aggregations, windowFullyCovered),
            "refused-messages" => BuildRefusedMessages(definition, total, aggregations, windowFullyCovered),
            _ => throw new PanelUnavailableException(
                definition.PanelId, $"no elasticsearch response parser registered for panel '{definition.PanelId}'"),
        };
    }

    private static bool IsWindowFullyCovered(JsonElement aggregations, TimeRange range)
    {
        if (!aggregations.TryGetProperty("earliest", out var earliest)
            || !earliest.TryGetProperty("value", out var earliestValue)
            || earliestValue.ValueKind != JsonValueKind.Number)
        {
            return false;
        }

        var earliestMs = earliestValue.GetDouble();
        var fromMs = range.From.ToUnixTimeMilliseconds();

        return earliestMs <= fromMs + CoverageTolerance.TotalMilliseconds;
    }

    private static PanelReading BuildStepOutcomes(
        PanelDefinition definition, long total, JsonElement aggregations, bool windowFullyCovered)
    {
        var buckets = aggregations.GetProperty("by_result").GetProperty("buckets");

        var completed = BucketCount(buckets, "Completed");
        var failed = BucketCount(buckets, "Failed");
        var cancelled = BucketCount(buckets, "Cancelled");

        var valueJson = JsonSerializer.Serialize(new
        {
            totalOutcomeRecords = total,
            completed,
            failed,
            cancelled,
        });

        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: checked((int)total),
            new PanelTrust(SeriesPresent: true, windowFullyCovered, NoDataDistinguishable: true));
    }

    private static PanelReading BuildStepFailures(
        PanelDefinition definition, long total, JsonElement aggregations, bool windowFullyCovered)
    {
        var failedAgg = aggregations.GetProperty("failed");
        var failedCount = failedAgg.GetProperty("doc_count").GetInt64();

        var samples = new List<JsonElement>();
        if (failedAgg.TryGetProperty("samples", out var samplesAgg)
            && samplesAgg.TryGetProperty("hits", out var hitsWrapper)
            && hitsWrapper.TryGetProperty("hits", out var hitsArray))
        {
            foreach (var hit in hitsArray.EnumerateArray())
            {
                if (hit.TryGetProperty("_source", out var source))
                {
                    samples.Add(source.Clone());
                }
            }
        }

        var valueJson = JsonSerializer.Serialize(new
        {
            totalOutcomeRecords = total,
            failedCount,
            samples,
        });

        // SampleCount is the total outcome-record count, matching BuildStepOutcomes -- not
        // failedCount. A healthy window with zero failures genuinely returned "total" records; using
        // failedCount here would record it in the trace as a panel that returned nothing.
        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: checked((int)total),
            new PanelTrust(SeriesPresent: true, windowFullyCovered, NoDataDistinguishable: true));
    }

    /// <summary>
    /// What <c>hits.total</c> counts for a given panel, as the name the model sees on a reading.
    /// <para>
    /// Every Elastic panel here queries a BROAD scope and narrows inside an aggregation -- that is
    /// what lets <c>hits.total</c> answer "was anything reported at all" independently of whether the
    /// panel's own slice is zero. But the broad scope is not the same scope for every panel, and the
    /// reading has to say which one it is.
    /// </para>
    /// </summary>
    private static string ScopeCountName(string panelId) => panelId switch
    {
        "refused-messages" => "totalWorkflowRecords",
        _ => "totalOutcomeRecords",
    };

    /// <summary>
    /// The refusals reading: how much work this workflow lost in the window, split by queue and by
    /// whether the park actually landed, with the exceptions that caused the most recent five.
    /// <para>
    /// <b>The outcome split comes from a <c>filters</c> aggregation, not a <c>terms</c> one.</b> The
    /// two refusal templates share a long prefix and differ only past it, and the Kibana panel found
    /// the expensive way that a terms aggregation's bucket label gets truncated to that shared prefix
    /// -- collapsing the only distinction the split exists to make, silently and identically for both
    /// variants. A filters aggregation names its own buckets, so nothing can truncate them.
    /// </para>
    /// </summary>
    private static PanelReading BuildRefusedMessages(
        PanelDefinition definition, long total, JsonElement aggregations, bool windowFullyCovered)
    {
        var refusals = aggregations.GetProperty("refusals");
        var refusedCount = refusals.GetProperty("doc_count").GetInt64();

        var byQueue = new Dictionary<string, long>(StringComparer.Ordinal);
        if (refusals.TryGetProperty("by_queue", out var byQueueAgg)
            && byQueueAgg.TryGetProperty("buckets", out var queueBuckets))
        {
            foreach (var bucket in queueBuckets.EnumerateArray())
            {
                byQueue[bucket.GetProperty("key").GetString() ?? "(unnamed queue)"] =
                    bucket.GetProperty("doc_count").GetInt64();
            }
        }

        var outcomes = refusals.GetProperty("by_outcome").GetProperty("buckets");

        var samples = new List<JsonElement>();
        if (refusals.TryGetProperty("samples", out var samplesAgg)
            && samplesAgg.TryGetProperty("hits", out var hitsWrapper)
            && hitsWrapper.TryGetProperty("hits", out var hitsArray))
        {
            foreach (var hit in hitsArray.EnumerateArray())
            {
                if (hit.TryGetProperty("_source", out var source))
                {
                    samples.Add(source.Clone());
                }
            }
        }

        var valueJson = JsonSerializer.Serialize(new
        {
            totalWorkflowRecords = total,
            refusedCount,
            parked = BucketCount(outcomes, "parked"),
            notParked = BucketCount(outcomes, "notParked"),
            byQueue,
            samples,
        });

        // The scope total, matching both other Elastic panels -- NOT refusedCount. Four refusals out
        // of 612 records is not a panel that returned four things, and recording it that way would
        // put a healthy window in the trace as a panel that returned almost nothing.
        return new PanelReading(
            definition.PanelId, definition.Layer, valueJson, SampleCount: checked((int)total),
            new PanelTrust(SeriesPresent: true, windowFullyCovered, NoDataDistinguishable: true));
    }

    /// <summary>
    /// The run-boundaries edges: for the fires that entered in the window, the StepRole records by
    /// role and step -- entry dispatches and terminal outcomes -- plus the importer's polls and the
    /// items it took in. Built from the panel's three ES|QL statements in order: fires, edges, polls.
    /// <para>
    /// <b>Trust, as the <c>_search</c> panels draw it.</b> totalWorkflowRecords -- every record of the
    /// workflow in the window -- is the scope count. At zero nothing was reported at all, and every
    /// flag is false. Above zero the workflow is reporting, so <c>SeriesPresent</c> and
    /// <c>NoDataDistinguishable</c> are true and entry records with no terminal records are a trusted
    /// reading (a quiet window when nothing was imported, or work that never reached an exit edge),
    /// not a gap. terminal is a Completed outcome no successor accepts, or any outcome of a step with
    /// no successors (see StepRoles). The window is fully
    /// covered only when the earliest entry record sits within <see cref="CoverageTolerance"/> of the
    /// window's start; no entry at all is not covered.
    /// </para>
    /// <para>
    /// <b>pollsThatImported is the subtraction done here rather than by the model.</b> Read the other
    /// way round, drainedPolls=0 sounds like "every poll was empty" -- it means the opposite -- and the
    /// model made exactly that inversion in replay. A count stated positively cannot be inverted.
    /// </para>
    /// </summary>
    private static PanelReading BuildEdges(
        PanelDefinition definition, TimeRange range,
        IReadOnlyList<IReadOnlyList<IReadOnlyDictionary<string, JsonElement>>> tables)
    {
        var id = definition.PanelId;
        if (tables.Count != 3)
        {
            throw new PanelUnavailableException(id, $"expected 3 ES|QL statements (fires, edges, polls), got {tables.Count}");
        }

        var firesRow = SingleRow(id, tables[0]);
        var totalWorkflowRecords = Long(id, firesRow, "totalWorkflowRecords");
        var fires = Long(id, firesRow, "fires");
        var earliest = Date(id, firesRow, "earliest");

        var edges = tables[1]
            .Select(row => new EdgeRow(
                Text(id, row, $"attributes.{StepRoles.Key}"),
                Text(id, row, "attributes.StepName"),
                Long(id, row, "records")))
            .ToList();

        // SUM over no polls answers null; Long reads a null cell as 0, for both sums.
        var pollsRow = SingleRow(id, tables[2]);
        var importerPolls = Long(id, pollsRow, "importerPolls");
        var drainedPolls = Long(id, pollsRow, "drainedPolls");
        var recordsImported = Long(id, pollsRow, "recordsImported");

        var valueJson = JsonSerializer.Serialize(new
        {
            totalWorkflowRecords,
            fires,
            importerPolls,
            pollsThatImported = importerPolls - drainedPolls,
            drainedPolls,
            recordsImported,
            byStep = edges.Select(r => new { role = r.Role, step = r.Step, records = r.Records }),
        });
        if (totalWorkflowRecords == 0)
        {
            // Not one record of the workflow in the window: indistinguishable from a blind spot, the
            // same as the _search panels' hits.total == 0 -- all three flags false together.
            return new PanelReading(definition.PanelId, definition.Layer, valueJson, SampleCount: 0,
                new PanelTrust(SeriesPresent: false, WindowFullyCovered: false, NoDataDistinguishable: false));
        }

        var covered = earliest is { } e && e <= range.From + CoverageTolerance;
        return new PanelReading(definition.PanelId, definition.Layer, valueJson,
            SampleCount: checked((int)edges.Sum(r => r.Records)),
            new PanelTrust(SeriesPresent: true, WindowFullyCovered: covered, NoDataDistinguishable: true));
    }

    private sealed record EdgeRow(string Role, string Step, long Records);

    /// <summary>
    /// An ES|QL <c>_query</c> response as rows keyed by column name. Column order is whatever the
    /// statement's STATS produced, so nothing downstream may read by position.
    /// </summary>
    private static IReadOnlyList<IReadOnlyDictionary<string, JsonElement>> ParseEsqlRows(string panelId, string responseJson)
    {
        using var doc = ParseJson(panelId, responseJson);
        var root = doc.RootElement;

        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var errorElement))
        {
            throw new PanelUnavailableException(
                panelId, $"elasticsearch reported an error: {Truncate(errorElement.ToString())}");
        }

        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("is_partial", out var partial) && partial.ValueKind == JsonValueKind.True)
        {
            // The ES|QL counterpart of a _search response with failed shards or timed_out: the counts
            // cannot be told apart from an undercount, so this is a transport failure, not a reading.
            throw new PanelUnavailableException(panelId, "elasticsearch returned a partial ES|QL response");
        }

        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("columns", out var columns) || columns.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("values", out var values) || values.ValueKind != JsonValueKind.Array)
        {
            throw new PanelUnavailableException(panelId, "unexpected elasticsearch response shape: no ES|QL columns/values");
        }

        var names = columns.EnumerateArray()
            .Select(c => c.TryGetProperty("name", out var name) ? name.GetString() ?? string.Empty : string.Empty)
            .ToArray();
        var rows = new List<IReadOnlyDictionary<string, JsonElement>>();
        foreach (var value in values.EnumerateArray())
        {
            var cells = value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : [];
            if (cells.Length != names.Length)
            {
                throw new PanelUnavailableException(panelId, "unexpected elasticsearch response shape: a row does not match its columns");
            }

            var row = new Dictionary<string, JsonElement>(names.Length, StringComparer.Ordinal);
            for (var i = 0; i < names.Length; i++)
            {
                row[names[i]] = cells[i].Clone();
            }

            rows.Add(row);
        }

        return rows;
    }

    private static IReadOnlyDictionary<string, JsonElement> SingleRow(
        string panelId, IReadOnlyList<IReadOnlyDictionary<string, JsonElement>> table)
        => table.Count == 1
            ? table[0]
            : throw new PanelUnavailableException(panelId, $"unexpected elasticsearch response shape: expected one row, got {table.Count}");

    private static JsonElement Cell(string panelId, IReadOnlyDictionary<string, JsonElement> row, string column)
        => row.TryGetValue(column, out var cell)
            ? cell
            : throw new PanelUnavailableException(panelId, $"unexpected elasticsearch response shape: no column '{column}'");

    /// <summary>A count column; null (an aggregate such as SUM over no rows) reads as zero.</summary>
    private static long Long(string panelId, IReadOnlyDictionary<string, JsonElement> row, string column)
    {
        var cell = Cell(panelId, row, column);
        return cell.ValueKind switch
        {
            JsonValueKind.Null => 0,
            JsonValueKind.Number => cell.GetInt64(),
            _ => throw new PanelUnavailableException(panelId, $"unexpected elasticsearch response shape: '{column}' is not a number"),
        };
    }

    private static string Text(string panelId, IReadOnlyDictionary<string, JsonElement> row, string column)
    {
        var cell = Cell(panelId, row, column);
        return cell.ValueKind == JsonValueKind.String
            ? cell.GetString()!
            : throw new PanelUnavailableException(panelId, $"unexpected elasticsearch response shape: '{column}' is not a string");
    }

    /// <summary>A date column; null (MIN over no rows) is no date at all.</summary>
    private static DateTimeOffset? Date(string panelId, IReadOnlyDictionary<string, JsonElement> row, string column)
    {
        var cell = Cell(panelId, row, column);
        if (cell.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        return cell.ValueKind == JsonValueKind.String
               && DateTimeOffset.TryParse(cell.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed
            : throw new PanelUnavailableException(panelId, $"unexpected elasticsearch response shape: '{column}' is not a date");
    }

    private static long BucketCount(JsonElement buckets, string name)
        => buckets.TryGetProperty(name, out var bucket) && bucket.TryGetProperty("doc_count", out var count)
            ? count.GetInt64()
            : 0;

    private static JsonDocument ParseJson(string panelId, string responseJson)
    {
        try
        {
            return JsonDocument.Parse(responseJson);
        }
        catch (JsonException ex)
        {
            throw new PanelUnavailableException(panelId, $"elasticsearch response could not be parsed: {ex.Message}");
        }
    }

    private static string Truncate(string text) => text.Length <= 500 ? text : string.Concat(text.AsSpan(0, 500), "...");
}
