namespace BaseApi.Service.Features.Step;

/// <summary>
/// Entry condition for a <see cref="StepEntity"/> within a workflow graph, encoding when the step
/// may begin processing based on the previous step's outcome.
/// <para>
/// Every value carries an explicit numeric assignment, and those assignments must be preserved
/// across future migrations so the stored integer values stay stable.
/// <see cref="PreviousCompleted"/> is the C# default and therefore seeds
/// <see cref="StepEntity.EntryCondition"/>; EF sees that default and emits it as the column default
/// in the migration.
/// </para>
/// </summary>
public enum StepEntryCondition
{
    /// <summary>
    /// Rejected by both step validators, and the only member that is.
    /// <para>
    /// Nothing in this system reports a "still processing" result -- a step reaches exactly one of
    /// completed, failed or cancelled -- so a successor gated on this can never be entered. The
    /// member survives only because the numbering is a stored wire value and cannot be closed up.
    /// </para>
    /// <para>
    /// <b>It is also what an omitted field binds to</b>, since it is the C# default of this enum and
    /// the DTOs are positional records. That is the second reason the rule exists: without it a
    /// caller who simply left <c>entryCondition</c> out got a permanently dead step and no error.
    /// </para>
    /// </summary>
    PreviousProcessing = 0,

    /// <summary>Enter when the predecessor completed. Seeds <see cref="StepEntity.EntryCondition"/>.</summary>
    PreviousCompleted = 1,

    /// <summary>Enter when the predecessor failed.</summary>
    PreviousFailed = 2,

    /// <summary>Enter when the predecessor cancelled.</summary>
    PreviousCancelled = 3,

    /// <summary>Enter whatever the predecessor reported.</summary>
    Always = 4,

    /// <summary>
    /// Do not enter, and -- uniquely among these members -- do not fire either.
    /// <para>
    /// <b>The other five are claims about a predecessor's outcome; this one is a claim about the
    /// step.</b> That is why it is the one condition an entry step's dispatch consults: an entry step
    /// has no predecessor, so the outcome-shaped members have nothing to be evaluated against and are
    /// ignored there, while "this step does not run" means the same thing whether the step is reached
    /// by an edge or by a fire.
    /// </para>
    /// <para>
    /// <b>This is the operator's per-entry-step freeze.</b> A stop halts a whole workflow, which is
    /// the wrong instrument when only one of several entry steps needs to stand down. Setting that
    /// one to <c>Never</c> and re-issuing start leaves the schedule armed and its siblings firing.
    /// The freeze lands on the next start, not immediately, because L1 is a projection.
    /// See <c>WorkflowFireJob.DispatchEntryStepsAsync</c>.
    /// </para>
    /// </summary>
    Never = 5,
}
