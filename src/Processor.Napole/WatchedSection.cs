namespace Processor.Napole;

/// <summary>
/// The part of a workflow one Napole step reports on: from <see cref="FromStepId"/> to
/// <see cref="ToStepId"/> in <see cref="WorkflowId"/>. Any two steps of the workflow, possibly the same
/// one (sections spec §3).
/// </summary>
public readonly record struct WatchedSection(Guid WorkflowId, Guid FromStepId, Guid ToStepId)
{
    public static WatchedSection Of(NapoleConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        return new(config.WatchedWorkflowId, config.FromStepId, config.ToStepId);
    }
}
