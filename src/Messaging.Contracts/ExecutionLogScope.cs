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
/// <para>
/// <b>The parameters run in the canonical order the message records use</b> — execution, workflow,
/// step, processor, entry — minus the correlation id for the reason above. The method was called
/// <c>BuildState</c> while that order was different; it was renamed rather than re-ordered in place
/// because every parameter is a <see cref="Guid"/> and every call site passed the same count, so a
/// silent transposition would have compiled and been wrong only at runtime. The rename forced each
/// one to be visited.
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
    public static Dictionary<string, object> BuildScope(
        Guid executionId, Guid workflowId, Guid stepId, Guid processorId, Guid entryId)
    {
        var state = new Dictionary<string, object>(5);
        if (workflowId  != Guid.Empty) state[WorkflowId]  = workflowId.ToString("D");
        if (stepId      != Guid.Empty) state[StepId]      = stepId.ToString("D");
        if (processorId != Guid.Empty) state[ProcessorId] = processorId.ToString("D");
        if (executionId != Guid.Empty) state[ExecutionId] = executionId.ToString("D");
        if (entryId     != Guid.Empty) state[EntryId]     = entryId.ToString("D");
        return state;
    }

    /// <summary>Convenience overload for a dispatch, whose entry id is the key it reads.</summary>
    public static Dictionary<string, object> BuildScope(ProcessDispatch d)
        => BuildScope(d.ExecutionId, d.WorkflowId, d.StepId, d.ProcessorId, d.EntryId);

    /// <summary>
    /// Convenience overload for a processed-data branch. Note the <c>EntryId</c> attribute means the
    /// key this branch will <i>write</i> — the successor's input — where on the dispatch above it
    /// means the key that step <i>read</i>. Anything querying across both hops is looking at two
    /// different keys under one field name; see <see cref="ProcessedData.EntryId"/>.
    /// </summary>
    public static Dictionary<string, object> BuildScope(ProcessedData p)
        => BuildScope(p.ExecutionId, p.WorkflowId, p.StepId, p.ProcessorId, p.EntryId);
}
