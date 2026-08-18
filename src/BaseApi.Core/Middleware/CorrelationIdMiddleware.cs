using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace BaseApi.Core.Middleware;

/// <summary>
/// Reads or generates a per-request correlation id, stashes it in
/// <c>HttpContext.Items["CorrelationId"]</c>, echoes it on the response
/// <c>X-Correlation-Id</c> header, and pushes it onto the log scope.
///
/// <para>
/// <b>Pipeline placement:</b> registered immediately after the exception handler, so it runs inside
/// that handler's try-catch. When an endpoint throws, the id is already in
/// <c>HttpContext.Items</c>, which is where the problem-details customizer reads it from.
/// </para>
///
/// <para>
/// <b>Format:</b> generated ids are 32-character lowercase hex without dashes. An inbound header is
/// echoed verbatim only when it is non-empty, at most 128 characters, and ASCII-printable.
/// </para>
///
/// <para>
/// <b>The ASCII-printable check is a security control, not tidiness:</b> it rejects CR, LF, null and
/// other control characters that would otherwise allow response-header CRLF injection or forged log
/// lines through the echoed value. An invalid inbound value produces a fresh id — never a fallback
/// to the unsafe value.
/// </para>
///
/// <para>
/// <b>Header echo timing:</b> the echo goes through <c>Response.OnStarting</c> rather than assigning
/// after the next middleware returns. That fires deterministically before headers flush, including
/// on the exception path where the handler chain writes the response. Direct assignment afterwards
/// would race response commit on short-circuit paths.
/// </para>
///
/// <para>
/// <b>Log scope key:</b> the literal <c>CorrelationId</c>, matching what scope inclusion surfaces as
/// a log attribute, so no renaming is needed downstream.
/// </para>
/// </summary>
public sealed class CorrelationIdMiddleware
{
    private const string HeaderName = "X-Correlation-Id";
    private const string ItemKey = "CorrelationId";
    private const int MaxLength = 128;

    private readonly RequestDelegate _next;
    private readonly ILogger<CorrelationIdMiddleware> _logger;

    public CorrelationIdMiddleware(RequestDelegate next, ILogger<CorrelationIdMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var corrId = ResolveCorrelationId(context);

        // Stash for downstream readers: the exception-handler chain and problem-details customizer.
        context.Items[ItemKey] = corrId;

        // Echo on the way out. Assignment rather than Append, so a duplicate header is impossible.
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[HeaderName] = corrId;
            return Task.CompletedTask;
        });

        using var scope = _logger.BeginScope(
            new Dictionary<string, object> { [ItemKey] = corrId });

        await _next(context);
    }

    private static string ResolveCorrelationId(HttpContext context)
    {
        if (context.Request.Headers.TryGetValue(HeaderName, out var header)
            && header.Count > 0
            && IsValid(header[0]))
        {
            return header[0]!;
        }
        return Guid.NewGuid().ToString("N");  // 32-char lowercase hex, no dashes
    }

    private static bool IsValid(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > MaxLength) return false;
        foreach (var c in value)
        {
            // ASCII-printable only — rejects CR, LF, null and control characters, which is what
            // blocks header and log injection through the echoed value.
            if (c < 0x20 || c > 0x7E) return false;
        }
        return true;
    }
}
