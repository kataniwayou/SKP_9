namespace Processor.Napole;

/// <summary>How an execution's pass through the section ended. Only the first three are counted.</summary>
public enum RoundTrip
{
    Failed,
    Cancelled,
    Complete,

    /// <summary>Still running, its start outside the trail, or two runs of one id: in no count at all (sections spec §5.2).</summary>
    Unfinished,

    /// <summary>
    /// Finished, with nothing failed or cancelled in the section, but <c>toStepId</c> never completed:
    /// the run left by a route that does not pass the section's end. In no count, because counting it
    /// as anything would break the identity or say something false (sections spec §5.2, 6).
    /// </summary>
    Bypassed,
}

public static class RoundTripRules
{
    /// <summary>
    /// The verdict, in the spec's order (sections spec §5.2).
    /// <list type="number">
    /// <item><description>Not exactly one root: Unfinished. Two runs mixed cannot be told apart, and with none whether every branch ended cannot be known.</description></item>
    /// <item><description>A Failed outcome in the section: Failed -- the first failure decides, even when a failure branch then completes, and whatever a branch still open goes on to do. Before the open check, because no later tick reports a run this one leaves out.</description></item>
    /// <item><description>A branch still open: Unfinished. A cancel on one branch is not a terminated run while another may yet fail.</description></item>
    /// <item><description>A Cancelled outcome in the section: Cancelled -- e.g. an artist not on the whitelist.</description></item>
    /// <item><description><c>toStepId</c> completed: Complete. Once, however many branches reached it.</description></item>
    /// <item><description>Otherwise Bypassed.</description></item>
    /// </list>
    /// </summary>
    public static RoundTrip Decide(ExecutionTrail trail)
    {
        ArgumentNullException.ThrowIfNull(trail);

        if (trail.Roots != 1)
        {
            return RoundTrip.Unfinished;
        }

        if (trail.Failed > 0)
        {
            return RoundTrip.Failed;
        }

        if (trail.OpenBranches > 0)
        {
            return RoundTrip.Unfinished;
        }

        if (trail.Cancelled > 0)
        {
            return RoundTrip.Cancelled;
        }

        return trail.Reached > 0 ? RoundTrip.Complete : RoundTrip.Bypassed;
    }
}
