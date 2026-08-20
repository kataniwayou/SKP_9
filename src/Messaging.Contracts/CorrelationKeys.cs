namespace Messaging.Contracts;

/// <summary>
/// The cross-boundary correlation id: one key, one rendering, on both sides of the HTTP/bus line.
/// <para>
/// <b>The rendering is the whole point.</b> <c>CorrelationIdMiddleware</c> mints
/// <c>Guid.NewGuid().ToString("N")</c> and echoes that exact string to the client. A bus-side scope
/// writing a <see cref="Guid"/> would default to the hyphenated <c>"D"</c> form, putting two
/// spellings of one id on a single Elasticsearch field — so a query joining an HTTP request to the
/// bus work it caused returns nothing, with no error anywhere to suggest why. Every producer renders
/// through <see cref="Render"/>.
/// </para>
/// </summary>
public static class CorrelationKeys
{
    /// <summary>The log-scope key. Must equal the literal the HTTP middleware uses.</summary>
    public const string LogScope = "CorrelationId";

    /// <summary>32 lowercase hex characters, no dashes — the form the middleware puts on the wire.</summary>
    public static string Render(Guid correlationId) => correlationId.ToString("N");
}
