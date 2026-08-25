using System.Globalization;
using System.Text.Json;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// One Elasticsearch log record, cut down to the fields the oracle reads.
/// <para>
/// <b><see cref="Result"/> is read from its own attribute, not parsed out of the body.</b> The
/// bridge lands every structured parameter as <c>attributes.&lt;Name&gt;</c>, so an outcome record
/// carries <c>attributes.Result</c> = "Completed" alongside the rendered text. Substring-matching
/// the body for "Failed" would be a second, weaker spelling of a fact already on the record.
/// </para>
/// <para>
/// <b><see cref="StepId"/> and <see cref="EntryId"/> ride the log scope, not any template.</b>
/// <c>ProcessDispatchHandler</c> opens <c>ExecutionLogScope.BuildScope(dispatch)</c> around the whole
/// of its <c>RunAsync</c>, so every record that hop writes carries the dispatch's ids whether or not
/// its template names one. Together the pair identifies the dispatch a record belongs to, which is
/// what lets <see cref="RunLedger"/> pair a step's start with its return rather than only counting
/// both.
/// </para>
/// </summary>
/// <param name="StepId">
/// The step's position in the graph, or null where the scope omitted it.
/// </param>
/// <param name="EntryId">
/// The L2 key this dispatch reads. Null for a source step, which has no upstream input and whose
/// id <c>ExecutionLogScope</c> therefore omits rather than zeroes -- so null here means "this
/// dispatch had no input key", never "the attribute was lost".
/// </param>
internal sealed record LogRecord(
    DateTimeOffset Timestamp,
    string Template,
    string Body,
    string? CorrelationId,
    string? Result,
    string Service,
    string Scope,
    string? StepId = null,
    string? EntryId = null)
{
    /// <summary>
    /// Projects one <c>_source</c> object. Used by both the live reader and the hermetic fixture
    /// loader, so a drift in the field names breaks in the fast tests rather than in a soak.
    /// </summary>
    public static LogRecord FromSource(JsonElement source)
    {
        var attributes = source.TryGetProperty("attributes", out var a) ? a : default;

        return new LogRecord(
            Timestamp: ParseTimestamp(source),
            Template: Attribute(attributes, "{OriginalFormat}") ?? string.Empty,
            Body: source.TryGetProperty("body", out var body)
                && body.TryGetProperty("text", out var text)
                    ? text.GetString() ?? string.Empty
                    : string.Empty,
            CorrelationId: Attribute(attributes, "CorrelationId"),
            Result: Attribute(attributes, "Result"),
            Service: source.TryGetProperty("resource", out var resource)
                && resource.TryGetProperty("attributes", out var ra)
                    ? Attribute(ra, "service.name") ?? string.Empty
                    : string.Empty,
            Scope: source.TryGetProperty("scope", out var scope)
                && scope.TryGetProperty("name", out var name)
                    ? name.GetString() ?? string.Empty
                    : string.Empty,
            StepId: Attribute(attributes, "StepId"),
            EntryId: Attribute(attributes, "EntryId"));
    }

    /// <summary>
    /// Reads <c>@timestamp</c>, which arrives either as an ISO-8601 string or as epoch milliseconds
    /// with a fractional part -- the exporter writes the latter and Elasticsearch accepts both against
    /// the same <c>date</c> mapping. Handling only one form would work until it silently did not.
    /// </summary>
    private static DateTimeOffset ParseTimestamp(JsonElement source)
    {
        if (!source.TryGetProperty("@timestamp", out var stamp))
        {
            return default;
        }

        var raw = stamp.ValueKind == JsonValueKind.Number
            ? stamp.GetRawText()
            : stamp.GetString() ?? string.Empty;

        if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var epochMillis))
        {
            return DateTimeOffset.FromUnixTimeMilliseconds((long)epochMillis);
        }

        return DateTimeOffset.Parse(raw, CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
    }

    private static string? Attribute(JsonElement attributes, string key) =>
        attributes.ValueKind == JsonValueKind.Object
        && attributes.TryGetProperty(key, out var value)
            ? value.GetString()
            : null;
}
