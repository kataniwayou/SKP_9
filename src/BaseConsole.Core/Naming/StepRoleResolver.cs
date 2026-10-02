using System.Collections.Concurrent;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Naming;

/// <summary>
/// A step's role in a workflow, read once and cached per (workflow, step) for the replica's life.
/// <para>
/// <b>Forgotten per workflow at its start.</b> A restart can change roles, so the orchestrator calls
/// <see cref="Forget"/> when it re-reads a workflow's projection; nothing else invalidates.
/// </para>
/// <para>
/// <b>Never guesses and never throws.</b> A missing key or a store fault returns null and the record
/// goes out without StepRole. A miss is not cached, so it resolves once the key exists; the first miss
/// per (workflow, step) is logged at Information, later ones are not.
/// </para>
/// </summary>
public sealed class StepRoleResolver(IStepRoleSource source, ILogger<StepRoleResolver> logger)
{
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromMilliseconds(250);

    private readonly ConcurrentDictionary<(Guid Workflow, Guid Step), string> _roles = new();
    private readonly ConcurrentDictionary<(Guid Workflow, Guid Step), byte> _reportedMisses = new();

    public async Task<string?> RoleAsync(Guid workflowId, Guid stepId)
    {
        if (_roles.TryGetValue((workflowId, stepId), out var cached))
        {
            return cached;
        }

        string? role;
        try
        {
            role = await source.ReadRoleAsync(workflowId, stepId).WaitAsync(ReadTimeout).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "the role of step {StepId} in workflow {WorkflowId} could not be read", stepId, workflowId);
            return null;
        }

        if (role is null)
        {
            if (_reportedMisses.TryAdd((workflowId, stepId), 0))
            {
                logger.LogInformation(
                    "step {StepId} has no role in workflow {WorkflowId}; its records go out without StepRole",
                    stepId, workflowId);
            }

            return null;
        }

        _roles[(workflowId, stepId)] = role;
        return role;
    }

    public void Forget(Guid workflowId)
    {
        foreach (var key in _roles.Keys.Where(k => k.Workflow == workflowId))
        {
            _roles.TryRemove(key, out _);
        }

        foreach (var key in _reportedMisses.Keys.Where(k => k.Workflow == workflowId))
        {
            _reportedMisses.TryRemove(key, out _);
        }
    }

    /// <summary>
    /// Opens the StepRole scope for a resolved role, or nothing for an unresolved one. Callers write
    /// <c>using var scope = StepRoleResolver.BeginScope(logger, role);</c>.
    /// </summary>
    public static IDisposable? BeginScope(ILogger logger, string? role)
        => role is null ? null : logger.BeginScope(StepRoles.Scope(role));
}
