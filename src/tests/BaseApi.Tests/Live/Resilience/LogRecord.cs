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
/// </summary>
internal sealed record LogRecord(
    DateTimeOffset Timestamp,
    string Template,
    string Body,
    string? CorrelationId,
    string? Result,
    string Service,
    string Scope)
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
                    : string.Empty);
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
