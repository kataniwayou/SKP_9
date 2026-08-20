using Orchestrator.Scheduling;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// A recording <see cref="IWorkflowScheduler"/>, shared by every test that asserts what the
/// orchestrator asked the scheduler to do rather than what Quartz then did with it.
/// <para>
/// It lives in its own file rather than nested inside one test class because the activation path, the
/// apply handlers and the fire job all need the same fake, and three private copies of it would be
/// three places for the recorded surface to drift from the interface.
/// </para>
/// </summary>
internal sealed class RecordingWorkflowScheduler : IWorkflowScheduler
{
    public List<(Guid WorkflowId, Guid JobId, string Cron)> Scheduled { get; } = [];

    public List<(Guid WorkflowId, Guid JobId, string Cron)> Rescheduled { get; } = [];

    public List<Guid> Unscheduled { get; } = [];

    /// <summary>
    /// How many jobs this scheduler currently believes are live: every <see cref="ScheduleAsync"/>
    /// call minus every <see cref="UnscheduleAsync"/> call. Deliberately a count, not a set kept in
    /// step by <see cref="Scheduled"/> and <see cref="Unscheduled"/> — those two lists already are
    /// the record of what happened, and a count derived from their lengths cannot fail to subtract a
    /// teardown the way a count that only ever increments could.
    /// </summary>
    public int LiveJobCount => Scheduled.Count - Unscheduled.Count;

    /// <summary>
    /// Every call in the order it arrived, as method names. The three typed lists above answer "what
    /// was it asked to do", which is what most assertions want; they cannot answer "in what order",
    /// because a per-method list has no way to interleave with another one. Teardown-before-apply is
    /// exactly such a claim — <see cref="global::Orchestrator.L1.WorkflowActivator"/> converges on a
    /// redelivery only because the unschedule precedes the schedule — so the ordering needs somewhere
    /// to be visible.
    /// </summary>
    public List<string> Calls { get; } = [];

    /// <summary>
    /// Invoked at the top of <see cref="UnscheduleAsync"/>, before it records anything. Opt-in and
    /// null by default, so every caller that does not set it is unaffected.
    /// <para>
    /// <b>Why this exists.</b> Ordering against a call this recorder makes is visible in
    /// <see cref="Calls"/>. Ordering against a call on a <i>different</i> real object —
    /// <c>WorkflowL1Store.Remove</c>, for the stop path — is not: the store is a real object, not a
    /// fake, so it keeps no list a test can inspect afterwards. The only way to tell "the store still
    /// held the workflow when unschedule ran" from "the store had already dropped it" is to sample the
    /// store's state at the instant this method runs, from inside it — which is what this hook is for.
    /// </para>
    /// </summary>
    public Action? OnUnscheduleAsync { get; set; }

    public Task ScheduleAsync(Guid workflowId, Guid jobId, string cron, CancellationToken ct)
    {
        Scheduled.Add((workflowId, jobId, cron));
        Calls.Add(nameof(ScheduleAsync));
        return Task.CompletedTask;
    }

    public Task RescheduleAsync(Guid workflowId, Guid jobId, string cron, CancellationToken ct)
    {
        Rescheduled.Add((workflowId, jobId, cron));
        Calls.Add(nameof(RescheduleAsync));
        return Task.CompletedTask;
    }

    public Task UnscheduleAsync(Guid jobId, CancellationToken ct)
    {
        OnUnscheduleAsync?.Invoke();
        Unscheduled.Add(jobId);
        Calls.Add(nameof(UnscheduleAsync));
        return Task.CompletedTask;
    }
}
