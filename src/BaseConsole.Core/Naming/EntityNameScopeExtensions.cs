using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Naming;

/// <summary>
/// The two-step way every site puts names on its records: resolve the scope value with
/// <see cref="ScopeOrNullAsync"/> (async, never throws), then open it with
/// <see cref="BeginNamesScope"/> (synchronous) in the SAME method that goes on to log.
/// <para>
/// <b>Why two steps, not one <c>async</c> helper that does both.</b> An <c>AsyncLocal</c> mutation
/// made INSIDE an awaited async method is never visible to whichever method awaited it: the CLR's
/// async method builder snapshots <c>ExecutionContext</c> before running the method's state machine
/// and restores that snapshot once the method returns, specifically so a callee's <c>AsyncLocal</c>
/// writes cannot leak back into the caller. <c>ILogger.BeginScope</c> is exactly such a write — the
/// default scope provider (<c>LoggerExternalScopeProvider</c>) is <c>AsyncLocal</c>-backed — so a
/// single <c>async</c> helper that both awaits the name resolution AND calls <c>BeginScope</c>
/// internally opens a scope that nobody outside that helper can ever observe. This was tried and
/// measured: the scope silently never took effect on the caller's own subsequent log records, though
/// the helper returned a perfectly valid, no-op <see cref="IDisposable"/>. <see cref="BeginNamesScope"/>
/// is therefore synchronous and must be called directly by whichever method wants the scope, with the
/// awaited value already in hand — never awaited itself, and never called from inside another async
/// helper on the caller's behalf.
/// </para>
/// <para>
/// A null resolver or a null scope opens nothing, so a host or test that wires no resolver still
/// logs, just without names.
/// </para>
/// </summary>
public static class EntityNameScopeExtensions
{
    /// <summary>The names scope value for these ids, or null when no resolver is wired. Never throws.</summary>
    public static async Task<Dictionary<string, object>?> ScopeOrNullAsync(
        this EntityNameResolver? names, Guid workflowId, Guid stepId, Guid processorId) =>
        names is null ? null : await names.ScopeAsync(workflowId, stepId, processorId).ConfigureAwait(false);

    /// <summary>
    /// Opens <paramref name="scope"/> on <paramref name="logger"/>, or opens nothing for a null scope.
    /// Synchronous — call it directly in the frame that goes on to log; see the class remarks for why.
    /// </summary>
    public static IDisposable? BeginNamesScope(this ILogger logger, Dictionary<string, object>? scope) =>
        scope is null ? null : logger.BeginScope(scope);

    /// <summary>The same scope from the cache alone, for synchronous sites. It never reads the store.</summary>
    public static IDisposable? BeginCachedNamesScope(
        this ILogger logger, EntityNameResolver? names, Guid workflowId, Guid stepId, Guid processorId) =>
        names is null ? null : logger.BeginScope(names.CachedScope(workflowId, stepId, processorId));
}
