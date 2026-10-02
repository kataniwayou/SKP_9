using BaseConsole.Core.Naming;
using Messaging.Contracts.Projections;
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
/// <b>Not live means do nothing.</b> Not an error, and nothing to park: a stop may have taken the
/// workflow out of the live set after the announcement was published, and the live set is the source of
/// truth. The store outlives a stop, so reading it anyway would resurrect a workflow an operator stopped.
/// </para>
/// <para>
/// <b>Names are refreshed, best-effort.</b> When a resolver is supplied, the workflow's, its steps' and
/// their processors' names are re-read in one round trip after scheduling — cached ones included, so a
/// rename made while the workflow was stopped shows from this start (spec §6). A miss keeps the cached
/// name or falls back, and never blocks activation.
/// </para>
/// </summary>
public sealed class WorkflowActivator(
    L2WorkflowReader reader,
    WorkflowL1Store store,
    IWorkflowScheduler scheduler,
    ILogger<WorkflowActivator> logger,
    EntityNameResolver? names = null,
    StepRoleResolver? roles = null)
{
    /// <summary>
    /// Spec §7.1, in order: return unless the workflow is live, read the definition, return if L2 holds
    /// no usable store for it, unschedule the job L1 already holds for it, put the definition in L1 under
    /// a fresh job id, schedule when the definition carries a cron, and preload its names.
    /// </summary>
    public async Task ActivateAsync(Guid workflowId, CancellationToken ct)
    {
        // THE LIVE SET DECIDES, not the store. The store outlives a stop, so an announcement that lost
        // a race with a stop would otherwise resurrect a workflow an operator stopped.
        if (!await reader.IsLiveAsync(workflowId, ct).ConfigureAwait(false))
        {
            logger.LogInformation("workflow {WorkflowId} is not in the live set; nothing to activate", workflowId);
            return;
        }

        var definition = await reader.ReadAsync(workflowId, ct).ConfigureAwait(false);
        if (definition is null)
        {
            // Warning, and behind the live guard above this is a FAULT, not a race: a start writes the
            // store before it adds the id to the live set, and a stop removes the id but keeps the
            // store, so a live id whose store is missing or unreadable means L2 was flushed or holds an
            // odd key state (a corrupt store field, a key of the wrong type). The announcement's sender
            // has no way to learn that work it asked for was not done, so this record is the only trace.
            logger.LogWarning(
                "L2 does not hold workflow {WorkflowId}; nothing to activate", workflowId);
            return;
        }

        // ACTIVE, not merely held, and the distinction matters on the restart path. A marked entry has
        // no job left to tear down: ApplyStopHandler unschedules strictly before it marks, so "marked"
        // implies "already unscheduled". Tearing down again would be a second DeleteJob against a job
        // that is gone — harmless in Quartz, but it would state a teardown that did not happen and put
        // this method's convergence argument on a call that cannot be doing what it claims.
        //
        // Store.Set below then writes a fresh entry carrying no DeletedAt, which is what clears the
        // stop. The un-marking is a side effect of the write rather than a separate call this path
        // could forget to make.
        if (store.TryGetActive(workflowId, out var held))
        {
            await scheduler.UnscheduleAsync(held.JobId, ct).ConfigureAwait(false);
        }

        // Before the projection is set and the job scheduled, so no fire or outcome between the two
        // can read a cached old role.
        // A start can change roles (an edit took effect); drop this workflow's cached roles so the
        // next record re-reads them. Names refresh below for the same reason.
        roles?.Forget(workflowId);

        var jobId = Guid.NewGuid();
        store.Set(workflowId, definition, jobId);

        // A null cron means unscheduled, which is a valid projection: WorkflowL1's own doc puts that
        // decision with whoever reads the root, and that is this method.
        if (definition.Cron is { } cron)
        {
            await scheduler.ScheduleAsync(workflowId, jobId, cron, ct).ConfigureAwait(false);
        }

        // Names for the records this workflow is about to produce, in one read. A REFRESH, not a
        // preload: the resolver lives as long as the replica, and a preload would skip every id it
        // already holds, so a workflow or step renamed while stopped would keep its old name past this
        // start. Best-effort: the resolver never throws, and a miss keeps the cached name or falls back.
        if (names is not null)
        {
            await names.RefreshAsync(
                new[] { new EntityRef(L2EntityKind.Workflow, workflowId) }
                    .Concat(definition.Steps.Select(s => new EntityRef(L2EntityKind.Step, s.StepId)))
                    .Concat(definition.Steps.Select(s => new EntityRef(L2EntityKind.Processor, s.ProcessorId))))
                .ConfigureAwait(false);
        }

        // Information, not Debug. This is the only record that a replica took a start announcement
        // and acted on it, and it fires once per start rather than once per anything hot. At Debug it
        // sat below the level shipped to the log store, which made "the announcement never arrived"
        // and "it arrived and applied" look identical from outside the process — the two cases a
        // control-plane record exists to separate.
        logger.LogInformation(
            "activated workflow {WorkflowId} with {StepCount} steps, scheduled={Scheduled}",
            workflowId, definition.Steps.Count, definition.Cron is not null);
    }
}
