namespace Orchestrator.Scheduling;

/// <summary>
/// The scheduling surface the activation path, the apply handlers and the fire job all speak to.
/// <para>
/// <b>Why this interface exists in a codebase that otherwise injects concrete console types.</b> The
/// concrete <see cref="WorkflowScheduler{TJob}"/> is bound to Quartz through a non-virtual surface, so
/// there is nothing on it a test can override. Yet the two behaviours most worth asserting — that a
/// second activation tears the old job down before standing a new one up, and that a superseded fire
/// declines to reschedule itself — are statements about which scheduling calls were made, not about
/// what Quartz did with them. Without this seam every such test would have to stand up a real
/// scheduler and then infer intent from its job store, which is both slower and a weaker assertion.
/// The seam is deliberately narrow: three methods, no state, no lifecycle.
/// </para>
/// </summary>
public interface IWorkflowScheduler
{
    /// <summary>
    /// The job-data key carrying the workflow a fire belongs to. The scheduler writes it and the fire
    /// job reads it, and a mismatch between the two would leave every fire unable to find its
    /// workflow — so the string is stated once, here, rather than twice as a literal.
    /// </summary>
    public const string WorkflowIdKey = "workflowId";

    /// <summary>
    /// The job-data key carrying the job's own identity. This is what makes the supersession check
    /// possible: a fire can ask whether the job it belongs to is still the one L1 holds for its
    /// workflow, and stand down when a newer activation has replaced it.
    /// </summary>
    public const string JobIdKey = "jobId";

    /// <summary>
    /// Stand up the one-shot job <paramref name="jobId"/> for <paramref name="workflowId"/>, firing at
    /// the next occurrence of <paramref name="cron"/>. A cron with no future occurrence schedules
    /// nothing.
    /// </summary>
    Task ScheduleAsync(Guid workflowId, Guid jobId, string cron, CancellationToken ct);

    /// <summary>
    /// Give the existing job <paramref name="jobId"/> a fresh trigger at the next occurrence of
    /// <paramref name="cron"/>, re-creating the job when it is no longer there. Called by the fire job
    /// to arm its own next fire.
    /// </summary>
    Task RescheduleAsync(Guid workflowId, Guid jobId, string cron, CancellationToken ct);

    /// <summary>Remove the job <paramref name="jobId"/> and every trigger of it.</summary>
    Task UnscheduleAsync(Guid jobId, CancellationToken ct);
}
