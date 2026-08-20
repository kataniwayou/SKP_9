namespace Orchestrator.Election;

/// <summary>
/// Whether this replica currently holds the orchestrator lease, and therefore whether its fires may
/// dispatch.
/// <para>
/// <b><see cref="LeaderElectionService"/> is the sole writer, and that is the invariant this type
/// exists to make checkable.</b> Every other holder of this object reads it: the fire job asks
/// <see cref="IsLeader"/> and does nothing else with it. If a second writer ever appeared, the
/// question "who decided this replica is the leader" would stop having one answer, and a replica
/// could open its own gate while another still holds the lease — which is precisely the two-leaders
/// state the election exists to prevent. There is exactly one caller of the two mutators; keep it
/// that way.
/// </para>
/// <para>
/// <b>An int behind <see cref="Volatile"/>/<see cref="Interlocked"/> rather than a lock.</b> This is
/// read on every fire of every workflow on every replica, and written twice in the lifetime of a
/// leadership term. A lock would serialise the reads against each other for no benefit; a plain
/// <see cref="bool"/> field would let a reader on another core keep observing a stale value after a
/// demotion, for as long as its cache line went unrefreshed — and "for as long as" is unbounded,
/// which is the one thing the self-demotion fence cannot tolerate. The volatile read is what bounds
/// it.
/// </para>
/// </summary>
public sealed class LeaderState
{
    private int _isLeader;

    /// <summary>
    /// True once this replica has acquired the lease, false again the moment it loses it. A replica
    /// is a follower until it has won something — three replicas start together and contend for one
    /// lease, so a default of true would have all three dispatching until the first lease was
    /// granted.
    /// </summary>
    public bool IsLeader => Volatile.Read(ref _isLeader) == 1;

    /// <summary>Open the gate. Called from the election's started-leading callback and nowhere else.</summary>
    public void BecomeLeader() => Interlocked.Exchange(ref _isLeader, 1);

    /// <summary>
    /// Close the gate. Called from the election's stopped-leading callback and nowhere else — this is
    /// the self-demotion fence in its executable form, and it is the half that matters: a gate that
    /// opened on acquisition and never closed on loss would put two leaders on one workflow for as
    /// long as the demoted replica kept running.
    /// </summary>
    public void BecomeFollower() => Interlocked.Exchange(ref _isLeader, 0);
}
