using System.Globalization;
using System.Text;
using System.Text.Json;
using Processor.Analyst.Panels;

namespace Processor.Analyst.Graph;

/// <summary>
/// Resolves the run context from BaseApi's start and stop records. The orchestrator's
/// "activated workflow" record is NOT a start: every orchestrator pod restart writes it again, so it
/// is read only as a deploy marker inside the run.
/// </summary>
internal sealed class ElasticRunContextSource(HttpClient http) : IRunContextSource
{
    internal static readonly TimeSpan MaxHistory = TimeSpan.FromDays(30);

    private const string StartTemplate = "accepted start for workflow {WorkflowId}";
    private const string StopTemplate = "accepted stop for workflow {WorkflowId}";

    public async Task<RunContext> ReadAsync(Guid workflowId, DateTimeOffset now, CancellationToken ct)
    {
        try
        {
            var since = (now - MaxHistory).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
            var row = (await QueryAsync($$"""
                FROM {{PanelRegistry.ElasticIndex}}
                | WHERE @timestamp >= "{{since}}" AND attributes.WorkflowId == "{{workflowId:D}}" AND `attributes.{OriginalFormat}` IN ("{{StartTemplate}}", "{{StopTemplate}}")
                | EVAL is_start = `attributes.{OriginalFormat}` == "{{StartTemplate}}"
                | STATS last_start = MAX(CASE(is_start, @timestamp, NULL)), last_stop = MAX(CASE(NOT is_start, @timestamp, NULL))
                """, ct).ConfigureAwait(false)).SingleOrDefault();

            var start = Date(row, "last_start");
            var stop = Date(row, "last_stop");

            if (start is null)
            {
                return RunContext.Missing($"no start record for the workflow in the last {MaxHistory.TotalDays:F0} days");
            }

            if (stop is { } s && s > start)
            {
                return RunContext.Missing($"the workflow was stopped at {s:O} after its last start");
            }

            var limit = start.Value > now - MaxHistory ? start.Value : now - MaxHistory;
            var startMinute = new DateTimeOffset(start.Value.Year, start.Value.Month, start.Value.Day,
                start.Value.Hour, start.Value.Minute, 0, TimeSpan.Zero);

            var deploys = (await QueryAsync($$"""
                FROM {{PanelRegistry.ElasticIndex}}
                | WHERE @timestamp >= "{{start.Value.UtcDateTime:o}}" AND attributes.WorkflowId == "{{workflowId:D}}" AND `attributes.{OriginalFormat}` LIKE "activated workflow*"
                | STATS replicas = COUNT(*) BY minute = DATE_TRUNC(1 minute, @timestamp)
                | SORT minute
                """, ct).ConfigureAwait(false))
                .Select(r => new DeployMarker(Date(r, "minute")!.Value, (int)r["replicas"].GetInt64()))
                .Where(d => d.Minute > startMinute)
                .ToList();

            return new RunContext(start, limit, deploys, null);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            return Unreadable(ex);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidOperationException or KeyNotFoundException)
        {
            return Unreadable(ex);
        }
    }

    private static RunContext Unreadable(Exception ex) => RunContext.Missing($"the run context could not be read: {ex.Message}");

    private async Task<IReadOnlyList<Dictionary<string, JsonElement>>> QueryAsync(string esql, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/_query?allow_partial_results=false")
        {
            Content = new StringContent(JsonSerializer.Serialize(new { query = esql }), Encoding.UTF8, "application/json"),
        };
        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false));

        var columns = doc.RootElement.GetProperty("columns").EnumerateArray()
            .Select(c => c.GetProperty("name").GetString()!).ToList();

        return [.. doc.RootElement.GetProperty("values").EnumerateArray().Select(values =>
        {
            var row = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            var i = 0;
            foreach (var cell in values.EnumerateArray())
            {
                row[columns[i++]] = cell.Clone();
            }
            return row;
        })];
    }

    private static DateTimeOffset? Date(IReadOnlyDictionary<string, JsonElement>? row, string column)
        => row is not null && row.TryGetValue(column, out var v) && v.ValueKind == JsonValueKind.String
            ? DateTimeOffset.Parse(v.GetString()!, CultureInfo.InvariantCulture)
            : null;
}
