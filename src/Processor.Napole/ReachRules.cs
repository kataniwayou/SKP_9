namespace Processor.Napole;

/// <summary>Where a traced execution's outcomes are read from (reach spec §2.2).</summary>
public enum Reach
{
    /// <summary>It reached <c>toStepId</c>: every outcome there counts, and nothing else does.</summary>
    Reached,

    /// <summary>It did not reach <c>toStepId</c>, and failed or was cancelled on the way: those outcomes count.</summary>
    EndedOnTheWay,

    /// <summary>Neither yet: still on its way, or left by another route without failing. Not in this tick's report.</summary>
    NoProvenEnd,

    /// <summary>Two runs of one ExecutionId in the trail, a re-import: their outcomes would mix, so it is left out.</summary>
    ReImported,
}

/// <summary>
/// What one traced execution adds to the report: 1 to the input if its end is proven, and its step
/// outcomes to the counters. The counters count outcomes, not executions, so they may exceed the input
/// (reach spec §2.3).
/// </summary>
public readonly record struct Contribution(int Input, int Output, int Failed, int Discarded);

public static class ReachRules
{
    /// <summary>
    /// In the spec's order (reach spec §2.2): a re-import first, then whether it reached
    /// <c>toStepId</c>, then whether it failed or was cancelled on the way. There is no waiting for
    /// branches: what is in ES at tick time decides, and the execution is not selected again.
    /// </summary>
    public static Reach Classify(ExecutionTrail trail)
    {
        ArgumentNullException.ThrowIfNull(trail);

        if (trail.Roots > 1)
        {
            return Reach.ReImported;
        }

        if (trail.Reached > 0)
        {
            return Reach.Reached;
        }

        return trail.WayFailed + trail.WayCancelled > 0 ? Reach.EndedOnTheWay : Reach.NoProvenEnd;
    }

    /// <summary>
    /// Reached: every outcome at <c>toStepId</c>, Completed as output, Failed as failed, Cancelled as
    /// discarded -- two arrivals add two, and failures elsewhere in the execution are not counted.
    /// Ended on the way: every Failed and Cancelled outcome after <c>fromStepId</c>. Otherwise nothing.
    /// </summary>
    public static Contribution Count(ExecutionTrail trail) => Classify(trail) switch
    {
        Reach.Reached => new(1, checked((int)trail.EndCompleted), checked((int)trail.EndFailed), checked((int)trail.EndCancelled)),
        Reach.EndedOnTheWay => new(1, 0, checked((int)trail.WayFailed), checked((int)trail.WayCancelled)),
        _ => default,
    };
}
