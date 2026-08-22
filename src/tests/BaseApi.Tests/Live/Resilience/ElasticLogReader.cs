using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Reads log records out of the collector's Elasticsearch data stream.
/// <para>
/// <b>Every query is bounded on both time and workflow.</b> The index here is a single shard holding
/// millions of documents on a shared dev cluster; an unbounded aggregation is slow enough to look
/// like a hang.
/// </para>
/// <para>
/// <b>Paged with search_after rather than from/size.</b> A five-minute soak is roughly 800 records
/// and deep paging past 10,000 is refused outright, so from/size would work right up until a
/// scenario got interesting.
/// </para>
/// </summary>
internal sealed class ElasticLogReader
{
    private static readonly string[] SourceFields =
    [
        "@timestamp", "body.text", "attributes", "scope.name", "resource.attributes.service.name",
    ];

    private const int PageSize = 1000;

    private readonly HttpClient _http;

    public ElasticLogReader(HttpClient http) => _http = http ?? throw new ArgumentNullException(nameof(http));

    /// <summary>
    /// Every record of every run of one workflow in a window.
    /// <para>
    /// Filtering on WorkflowId alone is not safe: the orchestration control-plane endpoints (start,
    /// stop) log a line carrying WorkflowId too, and each HTTP request is stamped with its own
    /// request-scoped CorrelationId by CorrelationIdMiddleware — a WorkflowId-only query cannot tell
    /// that apart from a run's CorrelationId, and each such request groups into a phantom "run" with
    /// an empty ledger. The second filter, on <see cref="Templates.RunScoped"/>, restricts the query
    /// to the templates an actual run's records can be, which excludes the control plane's own
    /// request-scoped logging without excluding anything a real run emits.
    /// </para>
    /// </summary>
    public Task<IReadOnlyList<LogRecord>> ReadRunRecordsAsync(
        Guid workflowId, DateTimeOffset from, DateTimeOffset to, CancellationToken ct) =>
        SearchAsync(
            [
                Range(from, to),
                Term("attributes.WorkflowId", workflowId.ToString("D")),
                Terms(Templates.RunScoped),
            ],
            ct);

    /// <summary>
    /// Records matching any of a set of templates, unfiltered by workflow, and optionally scoped to
    /// one service.
    /// <para>
    /// The gate and channel records carry no WorkflowId — they are statements about a process, not
    /// about a run — so the fault witness cannot reuse the run query.
    /// </para>
    /// <para>
    /// <b>The service filter exists for one specific hazard.</b> A worker's shutdown edge is
    /// <c>Application is shutting down...</c>, a Microsoft.Hosting.Lifetime template every service in
    /// the deployment emits. Witnessing a processor outage on that template alone would match the
    /// API or the orchestrator restarting for unrelated reasons and report a fault that never
    /// happened to the process under test.
    /// </para>
    /// </summary>
    public Task<IReadOnlyList<LogRecord>> ReadTemplateRecordsAsync(
        IReadOnlyCollection<string> templates, DateTimeOffset from, DateTimeOffset to, CancellationToken ct) =>
        ReadTemplateRecordsAsync(templates, from, to, service: null, ct);

    /// <summary>
    /// Records matching any of a set of templates, unfiltered by workflow, and scoped to the given
    /// service. See the four-argument overload for why the service filter exists.
    /// </summary>
    /// <param name="service">
    /// The <c>service.name</c> to scope to, or null for every service.
    /// </param>
    public Task<IReadOnlyList<LogRecord>> ReadTemplateRecordsAsync(
        IReadOnlyCollection<string> templates,
        DateTimeOffset from,
        DateTimeOffset to,
        string? service,
        CancellationToken ct)
    {
        var filters = new List<Dictionary<string, object>>
        {
            Range(from, to),
            Terms(templates),
        };

        if (service is { Length: > 0 })
        {
            filters.Add(Term("resource.attributes.service.name", service));
        }

        return SearchAsync(filters, ct);
    }

    /// <summary>How many records one workflow wrote in a window. The settle poll's stability signal.</summary>
    public async Task<long> CountAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        var body = new Dictionary<string, object>
        {
            ["query"] = Bool(
            [
                Range(from, to),
                Term("attributes.WorkflowId", Chaos.WorkflowId.ToString("D")),
            ]),
        };

        using var response = await PostAsync($"/{Chaos.LogIndex}/_count", body, ct);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));

        return document.RootElement.GetProperty("count").GetInt64();
    }

    private async Task<IReadOnlyList<LogRecord>> SearchAsync(
        List<Dictionary<string, object>> filters, CancellationToken ct)
    {
        var records = new List<LogRecord>();
        object[]? searchAfter = null;
        long reportedTotal;

        while (true)
        {
            var body = new Dictionary<string, object>
            {
                ["size"] = PageSize,
                // Without this, hits.total is capped and reported as a lower-bound ("gte") rather
                // than an exact count above 10,000 -- which would make the completeness check below
                // compare the collected count against a number that was never exact to begin with.
                ["track_total_hits"] = true,
                ["sort"] = new object[]
                {
                    new Dictionary<string, object> { ["@timestamp"] = "asc" },
                    // Tie-breaks on _doc, which is stable only within a shard -- fine today, on a
                    // single shard, but Chaos.LogIndex is a data stream, and after a rollover the
                    // search spans multiple backing indices, each with its own _doc ordering. The
                    // completeness check below (collected count vs. hits.total.value) is exactly what
                    // would catch that breaking: a rollover-induced gap would show up as a page that
                    // silently dropped or duplicated records, and the count would no longer match.
                    new Dictionary<string, object> { ["_doc"] = "asc" },
                },
                ["_source"] = SourceFields,
                ["query"] = Bool(filters),
            };

            if (searchAfter is not null)
            {
                body["search_after"] = searchAfter;
            }

            using var response = await PostAsync($"/{Chaos.LogIndex}/_search", body, ct);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));

            var hitsElement = document.RootElement.GetProperty("hits");
            reportedTotal = hitsElement.GetProperty("total").GetProperty("value").GetInt64();

            var hits = hitsElement.GetProperty("hits");
            if (hits.GetArrayLength() == 0)
            {
                break;
            }

            JsonElement last = default;
            foreach (var hit in hits.EnumerateArray())
            {
                records.Add(LogRecord.FromSource(hit.GetProperty("_source")));
                last = hit;
            }

            // Deserialized from raw text so a numeric sort value stays numeric on the way back in.
            // Passing it as a quoted string would make the next page start from a string, which
            // matches nothing and silently truncates the window at 1000 records.
            searchAfter = last.GetProperty("sort").EnumerateArray()
                .Select(e => JsonSerializer.Deserialize<object>(e.GetRawText())!).ToArray();
        }

        // A dropped page reads as lost steps, or -- at a page boundary -- as a run that quietly loses
        // records, either of which would masquerade as a real finding rather than a plumbing bug. No
        // verdict built from an incomplete read can be trusted, so this throws rather than returning a
        // partial list.
        if (records.Count != reportedTotal)
        {
            throw new InvalidOperationException(
                $"paged search collected {records.Count} record(s) but elasticsearch reported "
                + $"{reportedTotal} matching the query. The window was read incompletely, and no "
                + "verdict built from it can be trusted.");
        }

        return records;
    }

    private async Task<HttpResponseMessage> PostAsync(
        string path, Dictionary<string, object> body, CancellationToken ct)
    {
        // Encoding.UTF8 explicitly: two of the templates carry U+2014, and a request written in any
        // other encoding is rejected by Elasticsearch as an invalid UTF-8 start byte.
        using var content = new StringContent(
            JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        var response = await _http.PostAsync($"{Chaos.ElasticUrl.TrimEnd('/')}{path}", content, ct);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync(ct);
            response.Dispose();
            throw new InvalidOperationException(
                $"elasticsearch {path} returned {(int)response.StatusCode}: {detail}");
        }

        return response;
    }

    private static Dictionary<string, object> Bool(List<Dictionary<string, object>> filters) =>
        new() { ["bool"] = new Dictionary<string, object> { ["filter"] = filters } };

    private static Dictionary<string, object> Term(string field, string value) =>
        new() { ["term"] = new Dictionary<string, object> { [field] = value } };

    private static Dictionary<string, object> Terms(IReadOnlyCollection<string> templates) =>
        new()
        {
            ["terms"] = new Dictionary<string, object> { ["attributes.{OriginalFormat}"] = templates },
        };

    private static Dictionary<string, object> Range(DateTimeOffset from, DateTimeOffset to) =>
        new()
        {
            ["range"] = new Dictionary<string, object>
            {
                ["@timestamp"] = new Dictionary<string, object>
                {
                    ["gte"] = from.UtcDateTime.ToString("o", CultureInfo.InvariantCulture),
                    ["lte"] = to.UtcDateTime.ToString("o", CultureInfo.InvariantCulture),
                },
            },
        };
}
