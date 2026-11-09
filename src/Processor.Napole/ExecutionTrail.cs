namespace Processor.Napole;

/// <summary>
/// What Elasticsearch shows of one execution across a tick's trail span, for one section (sections
/// spec §5.2): counts only, because the verdict needs nothing more and the report carries nothing
/// more. Every count is read from the orchestrator's step-outcome records.
/// </summary>
/// <param name="Roots"><c>OutcomeTemplates.EntryCompleted</c> records. Exactly 1 is one run; 2 is two runs of one id mixed, 0 is a run whose start is outside the trail.</param>
/// <param name="OpenBranches">roots plus every <c>Advanced</c> record's SuccessorCount, less the outcomes the orchestrator handled (<c>Advanced</c> + <c>BranchEnds</c>); only &gt; 0 is open. Over the whole run, not only the section.</param>
/// <param name="Failed">step runs inside the section whose outcome is Failed.</param>
/// <param name="Cancelled">step runs inside the section whose outcome is Cancelled.</param>
/// <param name="Reached">step runs of <c>toStepId</c> that completed: 2 when two branches meet again there.</param>
public sealed record ExecutionTrail(
    Guid ExecutionId, long Roots, long OpenBranches, long Failed, long Cancelled, long Reached);
