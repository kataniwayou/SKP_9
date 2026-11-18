using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// Step domain entity — couples a processor to its successors in a workflow graph.
/// <para>
/// <c>ProcessorId</c> is a non-nullable foreign key whose constraint restricts deletes, so deleting a
/// processor while a step references it raises SQLSTATE 23001 and becomes a 422; the other direction
/// raises 23503. This differs from the processor's own schema foreign keys, which are nullable.
/// </para>
/// <para>
/// <c>EntryCondition</c> is stored as its underlying int, preserving the enum's explicit numeric
/// values.
/// </para>
/// <para>
/// <b>The next-step collection is deliberately not a property here.</b> There are no navigation
/// properties between entities: the self-referencing many-to-many is expressed by the
/// <c>StepNextSteps</c> junction table, the collection lives on the DTOs only, and
/// <c>StepService.SyncJunctionsAsync</c> keeps the two in step.
/// </para>
/// </summary>
public sealed class StepEntity : BaseEntity
{
    public Guid ProcessorId { get; set; }
    public StepEntryCondition EntryCondition { get; set; } = StepEntryCondition.PreviousCompleted;

    /// <summary>Where the Acto board draws this row, or null when it has never been placed. An update that carries no location leaves the stored one.</summary>
    public double? BoardX { get; set; }

    /// <summary>See <see cref="BoardX"/>.</summary>
    public double? BoardY { get; set; }
}
