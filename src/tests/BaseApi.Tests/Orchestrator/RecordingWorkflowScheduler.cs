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
    /// Every call in the order it arrived, as method names. The three typed lists above answer "what
    /// was it asked to do", which is what most assertions want; they cannot answer "in what order",
    /// because a per-method list has no way to interleave with another one. Teardown-before-apply is
    /// exactly such a claim — <see cref="global::Orchestrator.L1.WorkflowActivator"/> converges on a
    /// redelivery only because the unschedule precedes the schedule — so the ordering needs somewhere
    /// to be visible.
    /// </summary>
    public List<string> Calls { get; } = [];

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
        Unscheduled.Add(jobId);
        Calls.Add(nameof(UnscheduleAsync));
        return Task.CompletedTask;
    }
}
