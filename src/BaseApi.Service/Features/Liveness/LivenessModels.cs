namespace BaseApi.Service.Features.Liveness;

/// <summary>
/// One processor's liveness as the hub reports it: judged by the start gate's own probe, so "live" means one thing
/// everywhere. <see cref="Reason"/> is the gate's refusal wording while it is not live, and null while it is.
/// </summary>
public sealed record ProcessorLivenessStateDto(Guid ProcessorId, bool Live, int Healthy, int Replicas, string? Reason);

/// <summary>
/// The hub's whole state (<see cref="LivenessHub.Snapshot"/>): the running workflows, every processor's liveness, and
/// the sequence number of the last change broadcast before it was taken. <see cref="Known"/> is false while the monitor
/// cannot read Redis (or has not read it yet): the lists are then the last ones it read, and a client says "unknown".
/// </summary>
public sealed record LivenessSnapshotDto(
    long Sequence, bool Known, IReadOnlyList<Guid> RunningWorkflowIds, IReadOnlyList<ProcessorLivenessStateDto> Processors);

/// <summary>A workflow started (it joined the <c>skp:live</c> set) or stopped (it left it).</summary>
public sealed record WorkflowLiveDto(Guid WorkflowId, bool Running, long Sequence);

/// <summary>
/// A processor's liveness changed: live, healthy replica count, replica count or reason. <see cref="Removed"/> is true
/// when the processor row is gone (the client forgets it).
/// </summary>
public sealed record ProcessorLivenessChangeDto(
    Guid ProcessorId, bool Live, int Healthy, int Replicas, string? Reason, bool Removed, long Sequence);

/// <summary>
/// The monitor lost Redis (<see cref="Known"/> false, after a few failed reads in a row) or reads it again (true). A
/// client shows unknown while it is false, and takes a fresh <see cref="LivenessHub.Snapshot"/> when it turns true.
/// </summary>
public sealed record MonitorStatusDto(bool Known, string? Reason, long Sequence);

/// <summary>
/// The last sequence number handed out, sent every <see cref="LivenessMonitorOptions.SequenceEverySeconds"/>. It is not
/// a change and takes no number of its own: a client whose last applied sequence differs missed a broadcast (one that
/// failed to send, with no later change to reveal the gap) and takes a snapshot.
/// </summary>
public sealed record LivenessSequenceDto(long Sequence);

/// <summary>What one monitor tick read: the running workflow ids and every processor row's liveness.</summary>
public sealed record LivenessReading(IReadOnlySet<Guid> Running, IReadOnlyDictionary<Guid, ProcessorLivenessStateDto> Processors);

/// <summary>
/// The hub's client methods. SignalR sends each under its method name (the studio's client matches names without
/// case: <c>workflowLive</c>, <c>processorLiveness</c>, <c>monitorStatus</c>).
/// </summary>
public interface ILivenessClient
{
    Task WorkflowLive(WorkflowLiveDto change);
    Task ProcessorLiveness(ProcessorLivenessChangeDto change);
    Task MonitorStatus(MonitorStatusDto change);
    Task LivenessSequence(LivenessSequenceDto sequence);
}

/// <summary>Monitor settings, bound from the <c>Liveness</c> configuration section.</summary>
public sealed class LivenessMonitorOptions
{
    public const string Section = "Liveness";

    /// <summary>How often the monitor reads Redis, in seconds (default 2).</summary>
    public double IntervalSeconds { get; set; } = 2;

    /// <summary>Failed reads in a row before the hub says "unknown" (default 2; one failure alone is retried quietly).</summary>
    public int UnknownAfterFailures { get; set; } = 2;

    /// <summary>How many processors are probed at once (default 16; each probe is two Redis round trips).</summary>
    public int ProbeParallelism { get; set; } = 16;

    /// <summary>How often the last sequence number is sent, in seconds (default 10), so a lost broadcast is noticed.</summary>
    public double SequenceEverySeconds { get; set; } = 10;
}
