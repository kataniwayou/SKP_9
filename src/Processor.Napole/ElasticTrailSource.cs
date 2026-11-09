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
/// statement folds those into one row per step run, then one row per execution: its root
/// (<see cref="OutcomeTemplates.EntryCompleted"/>), its open branches, and the Failed, Cancelled and
/// <c>toStepId</c>-Completed step runs. The templates travel as params from the contract, never as text
/// in the statement. A run belongs to the tick when its first outcome at <c>fromStepId</c> is in the
/// window, so any entry processor works, not only the kafka-importer.
/// </para>
/// <para>
/// <b>Open branches</b> are roots + Σ <c>SuccessorCount</c> − (<c>Advanced</c> + <c>BranchEnds</c>), over
/// the whole run: a branch counts as ended only once the orchestrator has handled its outcome. A
/// duplicated outcome makes the difference negative, which reads as closed; none was found in 425,000.
/// </para>
/// <para>
/// <b>The section is bounded by time, not by the graph</b> (spec §5.3): failures and cancels count from
/// the first <c>fromStepId</c> outcome up to the last completed <c>toStepId</c> one, or to the end of the
/// run if <c>toStepId</c> never completed. The ids do not chain from step to step, so a failure on a
/// sibling branch outside the section but inside that span is counted. Exact sections need the step
/// graph, which this source does not read.
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
            Long(r, "roots"), Long(r, "openBranches"), Long(r, "failed"), Long(r, "cancelled"), Long(r, "reached")))];
    }

    // Run word for word against the dev cluster on 2026-11-09: it reproduced every section of spec §8.
    // `res` leaves the root record out because it carries a Result too; `root` is a SUM so two runs of
    // one id stay two even if they ever shared an EntryId. INLINE STATS gives each step run its
    // execution's section bounds without a second round trip.
    private static readonly string Statement = $$"""
        FROM {{TrailRecords.Index}}
        | WHERE attributes.WorkflowId == ?workflow AND resource.attributes.service.name == "orchestrator"
          AND attributes.ExecutionId IS NOT NULL AND @timestamp >= ?trailFrom AND @timestamp < ?trailTo
        | EVAL fmt = TO_STRING(`attributes.{OriginalFormat}`)
        | WHERE fmt == ?root OR fmt == ?advanced OR fmt == ?branchEnds OR fmt == ?advancedAnyway
        | EVAL isRoot = CASE(fmt == ?root, 1, 0), isAdv = CASE(fmt == ?advanced, 1, 0), isEnded = CASE(fmt == ?branchEnds, 1, 0),
               succ = CASE(fmt == ?advanced, TO_LONG(attributes.SuccessorCount), 0),
               res = CASE(fmt == ?branchEnds OR fmt == ?advancedAnyway, attributes.Result, null)
        | STATS root = SUM(isRoot), adv = MAX(isAdv), ended = MAX(isEnded), succ = SUM(succ), res = MAX(res), ts = MIN(@timestamp)
                BY attributes.ExecutionId, attributes.EntryId, attributes.StepId
        | EVAL outcome = COALESCE(res, "Completed")
        | INLINE STATS fromT = MIN(CASE(attributes.StepId == ?fromStep, ts, null)),
                       toT = MAX(CASE(attributes.StepId == ?toStep AND outcome == "Completed", ts, null)) BY attributes.ExecutionId
        | WHERE fromT IS NOT NULL
        | EVAL inSection = CASE(ts >= fromT AND (toT IS NULL OR ts <= toT), 1, 0)
        | STATS fromT = MIN(fromT), roots = SUM(root), dispatched = SUM(succ), handled = SUM(adv) + SUM(ended),
                failed = SUM(CASE(inSection == 1 AND outcome == "Failed", 1, 0)),
                cancelled = SUM(CASE(inSection == 1 AND outcome == "Cancelled", 1, 0)),
                reached = SUM(CASE(attributes.StepId == ?toStep AND outcome == "Completed", 1, 0)) BY attributes.ExecutionId
        | WHERE fromT >= ?from AND fromT < ?to
        | EVAL openBranches = roots + dispatched - handled
        | KEEP attributes.ExecutionId, roots, openBranches, failed, cancelled, reached
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
