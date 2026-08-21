using Messaging.Contracts;

namespace Orchestrator.Dispatch;

/// <summary>
/// Which successors a finished step lets through. A pure function of the outcome and the step map —
/// no store, no logging, no clock — so the one decision that shapes every workflow's control flow can
/// be exercised without a broker or a Redis.
/// </summary>
public static class StepAdvancement
{
    /// <summary>
    /// <c>Always</c> from the API's <c>StepEntryCondition</c>, as an int. The orchestrator references
    /// only <c>Messaging.Contracts</c>, so the enum itself is out of reach; <c>StepResult</c> pins the
    /// numbering the other three share, and this pins the fourth.
    /// <para>
    /// <c>Never</c> (5) has no constant here on purpose. It is not a value to test for — it is every
    /// value the predicate does not accept, and writing it out would invite a branch that treats it as
    /// a case rather than as the absence of one.
    /// </para>
    /// </summary>
    private const int Always = 4;

    /// <summary>
    /// Splits <paramref name="completed"/>'s successors three ways against <paramref name="result"/>.
    /// <list type="bullet">
    ///   <item><description>An id absent from <paramref name="steps"/> is a dangling edge — returned
    ///   in <see cref="Selection.Dangling"/> so the caller can say so, because the alternative is
    ///   dropping a branch of the graph with nothing written down.</description></item>
    ///   <item><description>A resolved successor whose entry condition equals <c>(int)result</c>, or
    ///   is <c>Always</c>, is a match.</description></item>
    ///   <item><description>A resolved successor whose condition is neither is collected nowhere. That
    ///   is the graph working: a step gated on failure is <i>meant</i> not to run when its predecessor
    ///   completed, and counting that as a miss would make every branching workflow look broken.
    ///   </description></item>
    /// </list>
    /// <para>
    /// A null or empty successor list is the contract-defined terminal step: no matches, no dangling
    /// ids, no exception. Terminal is not the same as unresolved and must not read as one.
    /// </para>
    /// </summary>
    public static Selection SelectNext(
        StepResult result, StepL1 completed, IReadOnlyDictionary<Guid, StepL1> steps)
    {
        ArgumentNullException.ThrowIfNull(completed);
        ArgumentNullException.ThrowIfNull(steps);

        var matches = new List<StepL1>();
        var dangling = new List<Guid>();

        foreach (var nextId in completed.NextStepIds ?? [])
        {
            if (!steps.TryGetValue(nextId, out var next))
            {
                dangling.Add(nextId);
            }
            else if (next.EntryCondition == (int)result || next.EntryCondition == Always)
            {
                matches.Add(next);
            }
        }

        return new Selection(matches, dangling);
    }

    /// <summary>
    /// The outcome of <see cref="SelectNext"/>. An empty <see cref="Dangling"/> means every successor
    /// id resolved, or there were none.
    /// </summary>
    public readonly record struct Selection(IReadOnlyList<StepL1> Matches, IReadOnlyList<Guid> Dangling);
}
