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
    public List<(Guid WorkflowId, Guid ActivationId, int Index, string Cron)> Scheduled { get; } = [];

    public List<(Guid WorkflowId, Guid ActivationId, int Index, string Cron)> Rescheduled { get; } = [];

    /// <summary>The workflow ids <see cref="UnscheduleWorkflowAsync"/> was called with, in order.</summary>
    public List<Guid> Unscheduled { get; } = [];

    /// <summary>
    /// How many jobs this scheduler currently believes are live, modelled the way Quartz keys them:
    /// each <see cref="ScheduleAsync"/> adds the job <c>(workflow, activation, index)</c>, and each
    /// <see cref="UnscheduleWorkflowAsync"/> removes every job of that workflow — the group delete —
    /// however many groups it had. Replayed from <c>_events</c> on every read rather than kept
    /// as a running set, so it is one more view of the record of what happened, not a second record
    /// that could disagree with it. A plain <c>Scheduled.Count - Unscheduled.Count</c> was right only
    /// while each activation scheduled a single job.
    /// </summary>
    public int LiveJobCount
    {
        get
        {
            var live = new HashSet<(Guid WorkflowId, Guid ActivationId, int Index)>();
            foreach (var (workflowId, activationId, index, isSchedule) in _events)
            {
                if (isSchedule)
                {
                    live.Add((workflowId, activationId, index));
                }
                else
                {
                    live.RemoveWhere(j => j.WorkflowId == workflowId);
                }
            }

            return live.Count;
        }
    }

    /// <summary>Schedules and group deletes interleaved in arrival order, for <see cref="LiveJobCount"/>.</summary>
    private readonly List<(Guid WorkflowId, Guid ActivationId, int Index, bool IsSchedule)> _events = [];

    /// <summary>
    /// How many times a fire armed its own successor. Derived from <see cref="Rescheduled"/> rather
    /// than counted separately, for the same reason <see cref="LiveJobCount"/> is derived: a counter
    /// kept alongside the list is a second record of one fact, and the two can disagree.
    /// </summary>
    public int RescheduleCount => Rescheduled.Count;

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
    /// Invoked at the top of <see cref="UnscheduleWorkflowAsync"/>, before it records anything. Opt-in and
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

    public Task ScheduleAsync(Guid workflowId, Guid activationId, int index, string cron, CancellationToken ct)
    {
        Scheduled.Add((workflowId, activationId, index, cron));
        _events.Add((workflowId, activationId, index, true));
        Calls.Add(nameof(ScheduleAsync));
        return Task.CompletedTask;
    }

    public Task RescheduleAsync(Guid workflowId, Guid activationId, int index, string cron, CancellationToken ct)
    {
        Rescheduled.Add((workflowId, activationId, index, cron));
        Calls.Add(nameof(RescheduleAsync));
        return Task.CompletedTask;
    }

    public Task UnscheduleWorkflowAsync(Guid workflowId, CancellationToken ct)
    {
        OnUnscheduleAsync?.Invoke();
        Unscheduled.Add(workflowId);
        _events.Add((workflowId, Guid.Empty, 0, false));
        Calls.Add(nameof(UnscheduleWorkflowAsync));
        return Task.CompletedTask;
    }
}
