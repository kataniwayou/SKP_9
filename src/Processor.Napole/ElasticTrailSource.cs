using System.Globalization;
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Microsoft.Extensions.Options;

namespace Processor.Napole;

/// <summary>
/// The trails, from two ES|QL statements against <see cref="TrailRecords.Index"/>, both filtered to
/// the watched workflow so Napole's own records and every other workflow's stay out.
/// <para>
/// <b>A</b> selects the executions this tick owns -- the kafka-importer's import lines in the window.
/// <b>B</b> counts each one's trail: imports, terminal records, Failed and Cancelled outcomes, and the
/// branches dispatched whose outcome the orchestrator has not handled yet. Spec §4.3 had a third
/// statement for the outcomes; the report needs no reasons or step names, so they fold into B as counts.
/// </para>
/// <para>
/// <b>Open branches come from the orchestrator's outcome contract.</b> It writes exactly one
/// <see cref="OutcomeTemplates.Advanced"/> or <see cref="OutcomeTemplates.BranchEnds"/> record per
/// outcome it handles, and <c>Advanced</c> says how many successors it dispatched. So the steps
/// dispatched are the entry step (its import) plus every <c>SuccessorCount</c>, the outcomes handled are
/// the two records counted, and the difference is what is still in flight. A branch counts as returned
/// only once the orchestrator has handled it -- after any Failed record and any further hand-off are
/// written, so a late failure cannot hide behind an early "returned". A duplicated outcome makes the
/// difference negative, which reads as closed; a duplicated dispatch leaves it positive, so the run is
/// left out rather than miscounted.
/// </para>
/// <para>
/// <b>Transport and failure mapping as <c>Processor.Analyst</c>'s <c>ElasticPanelSource</c></b>, with
/// <see cref="FailedException"/> as the one failure: every way an answer could be short fails the
/// tick, because a report built on it would look plausible and be wrong.
/// </para>
/// </summary>
public sealed class ElasticTrailSource : IExecutionTrailSource
{
    private const string Path = "/_query?allow_partial_results=false";

    private readonly HttpClient _http;
    private readonly string? _misconfigured;

    public ElasticTrailSource(HttpClient http, IOptions<NapoleOptions> options)
    {
        ArgumentNullException.ThrowIfNull(http);
        ArgumentNullException.ThrowIfNull(options);

        _http = http;

        // Recorded, not thrown: a typed client is constructed by DI, where a throw is a raw resolution
        // fault, not the failed tick that names the cause.
        if (Uri.TryCreate(options.Value.ElasticBaseUrl, UriKind.Absolute, out var baseUri))
        {
            _http.BaseAddress = baseUri;
        }
        else
        {
            _misconfigured = $"{NapoleOptions.Section}:{nameof(NapoleOptions.ElasticBaseUrl)} '{options.Value.ElasticBaseUrl}' is not an absolute URL";
        }
    }

    public async Task<IReadOnlyList<ExecutionTrail>> ReadAsync(
        Guid workflowId, ReportWindow window, TimeSpan trail, CancellationToken ct)
    {
        if (_misconfigured is not null)
        {
            throw new FailedException(_misconfigured);
        }

        var imported = await QueryAsync("imports", Imports(), ct,
            ("workflow", workflowId.ToString("D")), ("from", Iso(window.From)), ("to", Iso(window.To))).ConfigureAwait(false);

        var ids = imported.Select(r => Guid.Parse(Text(r, "attributes.ExecutionId"))).ToList();
        if (ids.Count == 0)
        {
            return [];
        }

        var (trailFrom, trailTo) = window.TrailSpan(trail);
        var rows = await QueryAsync("trails", Trails(ids), ct,
            ("workflow", workflowId.ToString("D")), ("trailFrom", Iso(trailFrom)), ("trailTo", Iso(trailTo)),
            ("advanced", OutcomeTemplates.Advanced), ("branchEnds", OutcomeTemplates.BranchEnds),
            ("terminal", StepRoles.Terminal)).ConfigureAwait(false);

        var found = rows.ToDictionary(
            r => Guid.Parse(Text(r, "attributes.ExecutionId")),
            r => new ExecutionTrail(
                Guid.Parse(Text(r, "attributes.ExecutionId")),
                Long(r, "imports"), Long(r, "openBranches"), Long(r, "terminals"), Long(r, "failed"), Long(r, "cancelled")));

        return [.. ids.Select(id => found.TryGetValue(id, out var t) ? t : new ExecutionTrail(id, 0, 0, 0, 0, 0))];
    }

    private static string Imports() => $"""
        FROM {TrailRecords.Index}
        | WHERE resource.attributes.service.name == "kafka-importer" AND attributes.Record IS NOT NULL
          AND attributes.WorkflowId == ?workflow AND @timestamp >= ?from AND @timestamp < ?to
        | STATS BY attributes.ExecutionId
        | LIMIT {TrailRecords.RowLimit}
        """;

    // The IN list is spliced, not a param: every element is a Guid this method formatted itself.
    private static string Trails(IEnumerable<Guid> ids) => $$"""
        FROM {{TrailRecords.Index}}
        | WHERE attributes.WorkflowId == ?workflow AND attributes.ExecutionId IN ({{string.Join(", ", ids.Select(i => $"\"{i:D}\""))}})
          AND @timestamp >= ?trailFrom AND @timestamp < ?trailTo
        | EVAL svc = resource.attributes.service.name, fmt = TO_STRING(`attributes.{OriginalFormat}`)
        | EVAL isImport = CASE(svc == "kafka-importer" AND attributes.Record IS NOT NULL, 1, 0),
               isAdvanced = CASE(svc == "orchestrator" AND fmt == ?advanced, 1, 0),
               isEnded = CASE(svc == "orchestrator" AND fmt == ?branchEnds, 1, 0),
               successors = CASE(svc == "orchestrator" AND fmt == ?advanced, TO_LONG(attributes.SuccessorCount), 0),
               isTerminal = CASE(attributes.StepRole == ?terminal, 1, 0),
               isFailed = CASE(svc == "orchestrator" AND attributes.Result == "Failed", 1, 0),
               isCancelled = CASE(svc == "orchestrator" AND attributes.Result == "Cancelled", 1, 0)
        | STATS imports = SUM(isImport), terminals = SUM(isTerminal), failed = SUM(isFailed), cancelled = SUM(isCancelled),
                handled = SUM(isAdvanced) + SUM(isEnded), dispatched = SUM(successors) BY attributes.ExecutionId
        | EVAL openBranches = imports + dispatched - handled
        | KEEP imports, terminals, failed, cancelled, openBranches, attributes.ExecutionId
        | LIMIT {{TrailRecords.RowLimit}}
        """;

    private static string Iso(DateTimeOffset t)
        => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private async Task<List<Dictionary<string, JsonElement>>> QueryAsync(
        string statement, string query, CancellationToken ct, params (string Name, string Value)[] parameters)
    {
        var body = JsonSerializer.Serialize(new
        {
            query,
            @params = parameters.Select(p => new Dictionary<string, string> { [p.Name] = p.Value }),
        });

        using var request = new HttpRequestMessage(HttpMethod.Post, Path)
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
            throw new FailedException($"elasticsearch could not be reached for the {statement} statement: {ex.Message}", ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new FailedException($"elasticsearch timed out on the {statement} statement: {ex.Message}", ex);
        }

        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new FailedException(
                    $"elasticsearch returned {(int)response.StatusCode} to the {statement} statement: {Truncate(text)}");
            }

            return Rows(statement, text);
        }
    }

    /// <summary>An ES|QL <c>{"columns":[...],"values":[[...]]}</c> answer as rows keyed by column name, never by position.</summary>
    private static List<Dictionary<string, JsonElement>> Rows(string statement, string text)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(text);
        }
        catch (JsonException ex)
        {
            throw new FailedException($"the {statement} answer could not be parsed: {ex.Message}", ex);
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("is_partial", out var partial) && partial.ValueKind == JsonValueKind.True)
            {
                throw new FailedException($"elasticsearch returned a partial answer to the {statement} statement");
            }

            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("columns", out var columns) || columns.ValueKind != JsonValueKind.Array
                || !root.TryGetProperty("values", out var values) || values.ValueKind != JsonValueKind.Array)
            {
                throw new FailedException($"the {statement} answer has no ES|QL columns/values: {Truncate(text)}");
            }

            var names = columns.EnumerateArray()
                .Select(c => c.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "")
                .ToArray();

            var rows = new List<Dictionary<string, JsonElement>>();
            foreach (var value in values.EnumerateArray())
            {
                var cells = value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : [];
                if (cells.Length != names.Length)
                {
                    throw new FailedException($"a row of the {statement} answer does not match its columns");
                }

                rows.Add(names.Zip(cells).ToDictionary(p => p.First, p => p.Second.Clone(), StringComparer.Ordinal));
            }

            if (rows.Count >= TrailRecords.RowLimit)
            {
                throw new FailedException(
                    $"the {statement} statement returned {rows.Count} rows, its limit of {TrailRecords.RowLimit}; "
                    + "the answer may be truncated, so nothing is counted");
            }

            return rows;
        }
    }

    private static JsonElement Cell(Dictionary<string, JsonElement> row, string column)
        => row.TryGetValue(column, out var cell)
            ? cell
            : throw new FailedException($"an elasticsearch answer has no column '{column}'");

    private static string Text(Dictionary<string, JsonElement> row, string column)
        => Cell(row, column) is { ValueKind: JsonValueKind.String } cell
            ? cell.GetString()!
            : throw new FailedException($"elasticsearch column '{column}' is not a string");

    /// <summary>A count column; null (a SUM over no rows) reads as zero.</summary>
    private static long Long(Dictionary<string, JsonElement> row, string column) => Cell(row, column) switch
    {
        { ValueKind: JsonValueKind.Null } => 0,
        { ValueKind: JsonValueKind.Number } n => n.GetInt64(),
        _ => throw new FailedException($"elasticsearch column '{column}' is not a number"),
    };

    private static string Truncate(string text) => text.Length <= 500 ? text : string.Concat(text.AsSpan(0, 500), "...");
}
