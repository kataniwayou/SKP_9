using Microsoft.Extensions.Logging;
using Orchestrator.Scheduling;

namespace Orchestrator.L1;

/// <summary>
/// Brings one workflow from L2 into this replica: mirrors it into L1 and puts it on the scheduler.
/// <para>
/// <b>This is the single activation path, and its being single is the design.</b> Two things activate
/// workflows — hydration on start, and the start announcement while running — and they have no
/// business differing. If they were written separately they would drift: one would grow a guard the
/// other lacks, and the replica would then behave differently depending on whether a workflow arrived
/// at boot or by message, for no reason anybody chose. There is one method, both call it, and there is
/// nowhere for the difference to live.
/// </para>
/// <para>
/// <b>Teardown precedes apply.</b> An activation of a workflow already held unschedules the job L1
/// records before minting a new one. Without that, a redelivered announcement would leave the previous
/// job running alongside its replacement — two live jobs for one workflow, both firing every tick,
/// double-dispatching every entry step. Tearing down first is what makes a redelivery converge instead
/// of accumulate.
/// </para>
/// <para>
/// <b>Absent from L2 means do nothing.</b> Not an error, and nothing to park: a stop may have cleaned
/// L2 after the announcement was published, and L2 is the source of truth. Applying anyway would
/// resurrect a workflow an operator stopped.
/// </para>
/// </summary>
public sealed class WorkflowActivator(
    L2WorkflowReader reader,
    WorkflowL1Store store,
    IWorkflowScheduler scheduler,
    ILogger<WorkflowActivator> logger)
{
    /// <summary>
    /// Spec §7.1, in order: read the definition, return if L2 no longer holds it, unschedule the job
    /// L1 already holds for it, put the definition in L1 under a fresh job id, and schedule when the
    /// definition carries a cron.
    /// </summary>
    public async Task ActivateAsync(Guid workflowId, CancellationToken ct)
    {
        var definition = await reader.ReadAsync(workflowId, ct).ConfigureAwait(false);
        if (definition is null)
        {
            logger.LogInformation(
                "L2 does not hold workflow {WorkflowId}; nothing to activate", workflowId);
            return;
        }

        if (store.TryGet(workflowId, out var held))
        {
            await scheduler.UnscheduleAsync(held.JobId, ct).ConfigureAwait(false);
        }

        var jobId = Guid.NewGuid();
        store.Set(workflowId, definition, jobId);

        // A null cron means unscheduled, which is a valid projection: WorkflowL1's own doc puts that
        // decision with whoever reads the root, and that is this method.
        if (definition.Cron is { } cron)
        {
            await scheduler.ScheduleAsync(workflowId, jobId, cron, ct).ConfigureAwait(false);
        }

        logger.LogDebug(
            "activated workflow {WorkflowId} with {StepCount} steps, scheduled={Scheduled}",
            workflowId, definition.Steps.Count, definition.Cron is not null);
    }
}
