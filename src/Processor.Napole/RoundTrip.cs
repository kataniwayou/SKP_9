namespace Processor.Napole;

/// <summary>How an execution's round trip ended. Only the first three are counted.</summary>
public enum RoundTrip
{
    Failed,
    Cancelled,
    Complete,

    /// <summary>Still running, lost, log-less, or two runs of one id: in no count at all (spec §4.4).</summary>
    Unfinished,
}

public static class RoundTripRules
{
    /// <summary>
    /// The verdict, in the spec's order (§4.4).
    /// <list type="number">
    /// <item><description>Not exactly one import: Unfinished. Two runs mixed cannot be told apart, and none is no run.</description></item>
    /// <item><description>Any Failed outcome: Failed -- the first failure decides, even when a failure branch then ran to a terminal step.</description></item>
    /// <item><description>Any Cancelled outcome: Cancelled -- e.g. an artist not on the whitelist.</description></item>
    /// <item><description>A terminal and no branch left open: Complete, a full round trip. A fan-out ends once per branch, so one terminal alone is not enough.</description></item>
    /// <item><description>Otherwise Unfinished.</description></item>
    /// </list>
    /// </summary>
    public static RoundTrip Decide(ExecutionTrail trail)
    {
        ArgumentNullException.ThrowIfNull(trail);

        if (trail.Imports != 1)
        {
            return RoundTrip.Unfinished;
        }

        if (trail.Failed > 0)
        {
            return RoundTrip.Failed;
        }

        if (trail.Cancelled > 0)
        {
            return RoundTrip.Cancelled;
        }

        return trail.Terminals >= 1 && trail.OpenBranches == 0 ? RoundTrip.Complete : RoundTrip.Unfinished;
    }
}
