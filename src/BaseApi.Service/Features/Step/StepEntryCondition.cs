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
    PreviousProcessing = 0,
    PreviousCompleted = 1,
    PreviousFailed = 2,
    PreviousCancelled = 3,
    Always = 4,
    Never = 5,
}
