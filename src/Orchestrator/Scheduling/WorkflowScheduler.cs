using Microsoft.Extensions.Logging;
using Quartz;

namespace Orchestrator.Scheduling;

/// <summary>
/// One self-rescheduling one-shot Quartz job per workflow, keyed by the job id L1 minted for it.
/// <para>
/// <b>Why the job type is a type parameter.</b> This class knows about keys, triggers and the job-data
/// map; it does not know or care what runs when the trigger fires. Leaving the job type open lets the
/// scheduling mechanics be asserted against a real job store with an inert job, and lets the fire job
/// be written and tested independently of the thing that schedules it. The host closes it once, at
/// registration, over the real fire job.
/// </para>
/// <para>
/// <b><see cref="RescheduleAsync"/> attaches a new trigger to the existing job rather than re-adding
/// the job, and the distinction is not cosmetic.</b> The one-shot trigger a fire is running under is
/// still in the store while <c>Execute</c> is on the stack — Quartz removes a completed no-repeat
/// trigger only after it returns — so adding a trigger on the same deterministic key would collide.
/// Re-adding the job would collide on the job key for the same reason. Replacing the trigger in place
/// is the only move that is safe from inside a fire.
/// </para>
/// <para>
/// <b>And it must nonetheless be able to re-create job and trigger from nothing.</b> A non-durable job
/// with no triggers is auto-purged, which is the ordinary state of affairs by the time a fire gets
/// around to arming its successor. That is why <see cref="RescheduleAsync"/> takes the workflow id it
/// would otherwise not need: a purged job took its job-data map with it, so the re-created job has to
/// re-stamp both ids or the resurrected fire loses track of what it is firing.
/// </para>
/// </summary>
/// <typeparam name="TJob">The job type the trigger fires. Never constructed here.</typeparam>
public sealed class WorkflowScheduler<TJob>(
    IScheduler scheduler, TimeProvider timeProvider, ILogger<WorkflowScheduler<TJob>> logger)
    : IWorkflowScheduler
    where TJob : IJob
{
    private static JobKey JobKeyFor(Guid jobId) => new(jobId.ToString("D"));

    private static TriggerKey TriggerKeyFor(Guid jobId) => new(jobId.ToString("D"));

    /// <inheritdoc />
    public async Task ScheduleAsync(Guid workflowId, Guid jobId, string cron, CancellationToken ct)
    {
        if (NextFireTimeOrLogSkip(workflowId, cron) is not { } nextUtc)
        {
            return;
        }

        var jobKey = JobKeyFor(jobId);
        await scheduler
            .ScheduleJob(BuildJob(jobKey, workflowId, jobId), BuildTrigger(jobKey, jobId, nextUtc), ct)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task RescheduleAsync(Guid workflowId, Guid jobId, string cron, CancellationToken ct)
    {
        if (NextFireTimeOrLogSkip(workflowId, cron) is not { } nextUtc)
        {
            return;
        }

        var jobKey = JobKeyFor(jobId);
        var trigger = BuildTrigger(jobKey, jobId, nextUtc);

        // Replaces the trigger on this key without touching the job, and returns null only when there
        // was no trigger on the key to replace — see the type remarks for why both halves matter.
        var replaced = await scheduler.RescheduleJob(TriggerKeyFor(jobId), trigger, ct)
            .ConfigureAwait(false);

        if (replaced is null)
        {
            // No trigger on the key, so the non-durable job is gone with it. The trigger built above
            // already names the job key, so it binds to the job re-created here.
            await scheduler.ScheduleJob(BuildJob(jobKey, workflowId, jobId), trigger, ct)
                .ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public Task UnscheduleAsync(Guid jobId, CancellationToken ct) =>
        // DeleteJob, not UnscheduleJob: it removes the job and every trigger of it in one step, so
        // there is no interval in which a trigger outlives the job it fires.
        scheduler.DeleteJob(JobKeyFor(jobId), ct);

    private DateTime? NextFireTimeOrLogSkip(Guid workflowId, string cron)
    {
        var next = CronInterval.NextOccurrence(cron, timeProvider.GetUtcNow().UtcDateTime);
        if (next is null)
        {
            // Never the expression, which is user data — the workflow id is what identifies the
            // projection an operator would go and look at.
            logger.LogWarning(
                "cron for workflow {WorkflowId} yields no future fire time; nothing scheduled",
                workflowId);
        }

        return next;
    }

    private static IJobDetail BuildJob(JobKey jobKey, Guid workflowId, Guid jobId) =>
        JobBuilder.Create<TJob>()
            .WithIdentity(jobKey)
            .UsingJobData(IWorkflowScheduler.WorkflowIdKey, workflowId.ToString("D"))
            .UsingJobData(IWorkflowScheduler.JobIdKey, jobId.ToString("D"))
            .Build();

    private static ITrigger BuildTrigger(JobKey jobKey, Guid jobId, DateTime nextUtc) =>
        TriggerBuilder.Create()
            .WithIdentity(TriggerKeyFor(jobId))
            .ForJob(jobKey)
            .StartAt(new DateTimeOffset(nextUtc, TimeSpan.Zero))
            // No repeat: the fire arms its own successor, so a fire time missed while the process was
            // down is caught up once rather than replayed.
            .WithSimpleSchedule(s => s.WithMisfireHandlingInstructionFireNow())
            .Build();
}
