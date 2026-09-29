using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Naming;

/// <summary>
/// The one helper every site uses to put names on its records: the gated consumer around each
/// delivery, and each orchestrator or processor log site that runs outside a delivery. A null
/// resolver opens nothing, so a host or test that wires none still logs, just without names.
/// </summary>
public static class EntityNameScopeExtensions
{
    public static async Task<IDisposable?> BeginNamesScopeAsync(
        this ILogger logger, EntityNameResolver? names, Guid workflowId, Guid stepId, Guid processorId) =>
        names is null
            ? null
            : logger.BeginScope(await names.ScopeAsync(workflowId, stepId, processorId).ConfigureAwait(false));

    public static IDisposable? BeginCachedNamesScope(
        this ILogger logger, EntityNameResolver? names, Guid workflowId, Guid stepId, Guid processorId) =>
        names is null ? null : logger.BeginScope(names.CachedScope(workflowId, stepId, processorId));
}
