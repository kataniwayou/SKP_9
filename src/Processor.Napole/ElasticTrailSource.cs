using System.Globalization;
using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Microsoft.Extensions.Options;

namespace Processor.Napole;

/// <summary>
/// The trails of one section, from one ES|QL statement against <see cref="TrailRecords.Index"/>,
/// filtered to the watched workflow so Napole's own records and every other workflow's stay out.
/// <para>
/// <b>Read from step outcomes alone</b> (sections spec §4). The orchestrator writes one outcome record
/// per step run (<c>EntryId</c>): <see cref="OutcomeTemplates.BranchEnds"/> carries its <c>Result</c>;
/// an <see cref="OutcomeTemplates.Advanced"/> record is Completed unless an
/// <see cref="OutcomeTemplates.AdvancedAnyway"/> warning for the same run says Failed or Cancelled. The
/// templates travel as params from the contract, never as text in the statement.
/// </para>
/// <para>
/// <b>Reach counting</b> (reach spec §2, §4). An execution is traced when its first <c>fromStepId</c>
/// outcome is in the window, so any entry processor works. From that moment on, the statement counts
/// its step runs of <c>toStepId</c> and their outcomes, and its Failed and Cancelled outcomes at any
/// step, plus its root records (<see cref="OutcomeTemplates.EntryCompleted"/>) for the re-import guard.
/// Which of those count is <see cref="ReachRules"/>' decision. There is no open-branch check and no
/// upper time bound: Napole does not wait for branches, and once an execution has reached
/// <c>toStepId</c>, only that step's outcomes count.
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
        WatchedSection section, ReportWindow window, TimeSpan trail, CancellationToken ct)
    {
        if (_misconfigured is not null)
        {
            throw new FailedException(_misconfigured);
        }

        var (trailFrom, trailTo) = window.TrailSpan(trail);
        var rows = await QueryAsync("section", Statement, ct,
            ("workflow", section.WorkflowId.ToString("D")), ("trailFrom", Iso(trailFrom)), ("trailTo", Iso(trailTo)),
            ("root", OutcomeTemplates.EntryCompleted), ("advanced", OutcomeTemplates.Advanced),
            ("branchEnds", OutcomeTemplates.BranchEnds), ("advancedAnyway", OutcomeTemplates.AdvancedAnyway),
            ("fromStep", section.FromStepId.ToString("D")), ("toStep", section.ToStepId.ToString("D")),
            ("from", Iso(window.From)), ("to", Iso(window.To))).ConfigureAwait(false);

        return [.. rows.Select(r => new ExecutionTrail(
            Guid.Parse(Text(r, "attributes.ExecutionId")),
            Long(r, "roots"), Long(r, "reached"), Long(r, "endCompleted"), Long(r, "endFailed"), Long(r, "endCancelled"),
            Long(r, "wayFailed"), Long(r, "wayCancelled")))];
    }

    // Run word for word against the dev cluster on 2026-11-09: it reproduced reach spec §5 on all five
    // sections. `res` leaves the root record out because it carries a Result too; `root` is a SUM so two
    // runs of one id stay two even if they ever shared an EntryId. INLINE STATS gives each step run its
    // execution's fromT without a second round trip; nothing before fromT is counted.
    private static readonly string Statement = $$"""
        FROM {{TrailRecords.Index}}
        | WHERE attributes.WorkflowId == ?workflow AND resource.attributes.service.name == "orchestrator"
          AND attributes.ExecutionId IS NOT NULL AND @timestamp >= ?trailFrom AND @timestamp < ?trailTo
        | EVAL fmt = TO_STRING(`attributes.{OriginalFormat}`)
        | WHERE fmt == ?root OR fmt == ?advanced OR fmt == ?branchEnds OR fmt == ?advancedAnyway
        | EVAL isRoot = CASE(fmt == ?root, 1, 0),
               res = CASE(fmt == ?branchEnds OR fmt == ?advancedAnyway, attributes.Result, null)
        | STATS root = SUM(isRoot), res = MAX(res), ts = MIN(@timestamp)
                BY attributes.ExecutionId, attributes.EntryId, attributes.StepId
        | EVAL outcome = COALESCE(res, "Completed")
        | INLINE STATS fromT = MIN(CASE(attributes.StepId == ?fromStep, ts, null)) BY attributes.ExecutionId
        | WHERE fromT IS NOT NULL
        | EVAL after = CASE(ts >= fromT, 1, 0), atEnd = CASE(after == 1 AND attributes.StepId == ?toStep, 1, 0)
        | STATS fromT = MIN(fromT), roots = SUM(root), reached = SUM(atEnd),
                endCompleted = SUM(CASE(atEnd == 1 AND outcome == "Completed", 1, 0)),
                endFailed = SUM(CASE(atEnd == 1 AND outcome == "Failed", 1, 0)),
                endCancelled = SUM(CASE(atEnd == 1 AND outcome == "Cancelled", 1, 0)),
                wayFailed = SUM(CASE(after == 1 AND outcome == "Failed", 1, 0)),
                wayCancelled = SUM(CASE(after == 1 AND outcome == "Cancelled", 1, 0)) BY attributes.ExecutionId
        | WHERE fromT >= ?from AND fromT < ?to
        | KEEP attributes.ExecutionId, roots, reached, endCompleted, endFailed, endCancelled, wayFailed, wayCancelled
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
