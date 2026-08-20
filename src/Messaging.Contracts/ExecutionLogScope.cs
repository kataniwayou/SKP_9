namespace Messaging.Contracts;

/// <summary>
/// The execution ids as log-scope keys. A key here MUST equal the structured-parameter name any
/// template would use for the same id, so both surface at one <c>attributes.&lt;Key&gt;</c> field
/// through the OpenTelemetry <c>IncludeScopes</c> + <c>ParseStateValues</c> bridge.
/// <para>
/// <b>CorrelationId is deliberately absent.</b> It crosses the HTTP boundary, is echoed to clients in
/// <c>X-Correlation-Id</c>, and must render the way the HTTP middleware renders it — so it keeps its
/// own key and its own renderer in <see cref="CorrelationKeys"/>.
/// </para>
/// </summary>
public static class ExecutionLogScope
{
    public const string WorkflowId  = "WorkflowId";
    public const string StepId      = "StepId";
    public const string ProcessorId = "ProcessorId";
    public const string ExecutionId = "ExecutionId";
    public const string EntryId     = "EntryId";

    /// <summary>
    /// Builds the scope dictionary, omitting every id that is <see cref="Guid.Empty"/>.
    /// <para>
    /// <b>Omitted, not zeroed.</b> An entry dispatch has no execution id and a source step has no
    /// entry id; rendering those as all-zeros would make "this id does not apply" indistinguishable
    /// from "this id is the zero guid" to anything reading the logs. Consumers of these records must
    /// therefore be written for an absent field, not a sentinel value.
    /// </para>
    /// <para>
    /// Ids render <c>"D"</c>, matching the L2 key format so a log value can be pasted into a Redis
    /// lookup unchanged.
    /// </para>
    /// </summary>
    public static Dictionary<string, object> BuildState(
        Guid workflowId, Guid stepId, Guid processorId, Guid executionId, Guid entryId)
    {
        var state = new Dictionary<string, object>(5);
        if (workflowId  != Guid.Empty) state[WorkflowId]  = workflowId.ToString("D");
        if (stepId      != Guid.Empty) state[StepId]      = stepId.ToString("D");
        if (processorId != Guid.Empty) state[ProcessorId] = processorId.ToString("D");
        if (executionId != Guid.Empty) state[ExecutionId] = executionId.ToString("D");
        if (entryId     != Guid.Empty) state[EntryId]     = entryId.ToString("D");
        return state;
    }

    /// <summary>Convenience overload for a dispatch.</summary>
    public static Dictionary<string, object> BuildState(ProcessDispatch d)
        => BuildState(d.WorkflowId, d.StepId, d.ProcessorId, d.ExecutionId, d.EntryId);

    /// <summary>Convenience overload for a processed-data branch.</summary>
    public static Dictionary<string, object> BuildState(ProcessedData p)
        => BuildState(p.WorkflowId, p.StepId, p.ProcessorId, p.ExecutionId, p.EntryId);
}
