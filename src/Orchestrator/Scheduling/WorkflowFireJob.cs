using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Orchestrator.Election;
using Orchestrator.L1;
using Quartz;

namespace Orchestrator.Scheduling;

/// <summary>
/// Spec §8.3. One fire of one workflow: dispatch its entry steps, then arm the next fire.
/// <para>
/// <b>The leader gate sits before the dispatch and nowhere else.</b> A follower runs the whole of
/// this method except the sends — and, critically, still reschedules. A follower that returned early
/// would never fire that workflow again on this replica, so the workflow would stop at the moment
/// that replica was promoted, which is exactly the moment it must not. Followers keeping live
/// schedules is what makes a leadership change cost nothing.
/// </para>
/// <para>
/// <b>The supersession check is why the job id is coupled to L1 at all (§8.2).</b> A start arriving
/// while this fire is running deletes this job and schedules a replacement; the reschedule below can
/// re-create a job from nothing, because a non-durable one-shot with no trigger is auto-purged and it
/// has to be able to. Together those two facts would resurrect this job alongside its replacement —
/// two live jobs for one workflow, both firing every tick, double-dispatching every entry step. So
/// the fire asks L1 whether the job it belongs to is still the one L1 holds, and stands down if it is
/// not.
/// </para>
/// <para>
/// <b>An infra fault on an entry-step send is logged and swallowed, per entry step, and this is the
/// one send path in the system that does that.</b> Everywhere else a send fault propagates so the
/// delivery is requeued or parked. Here there is no delivery: this is a self-rescheduling one-shot,
/// and a throw before the reschedule means it never fires again — so a transient broker blip would
/// stop the workflow permanently on this replica, with nothing to redeliver and nothing to park. Per
/// entry step, so one processor's blip does not drop the sends to its siblings. The one exception is
/// a cancelled <see cref="IJobExecutionContext.CancellationToken"/>: once the host has asked to stop,
/// nothing here is worth surviving for, and swallowing would leave shutdown waiting on work it has
/// already cancelled.
/// </para>
/// <para>
/// <b>Business cases are logged and returned from, never thrown.</b> A job-data map that will not
/// parse and a workflow no longer in L1 are both ordinary — the second is what every fire of a
/// stopped workflow sees on its way out — and Quartz has nothing useful to do with an exception for
/// either.
/// </para>
/// </summary>
[DisallowConcurrentExecution]
public sealed class WorkflowFireJob(
    WorkflowL1Store store,
    IWorkflowScheduler scheduler,
    IQueueSender sender,
    LeaderState leaderState,
    ILogger<WorkflowFireJob> logger) : IJob
{
    /// <inheritdoc />
    public async Task Execute(IJobExecutionContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        // Read through the interface's constants, never a literal: the scheduler writes this map and
        // a literal that drifted from the producer's would leave every fire unable to find itself,
        // with both sides looking correct in isolation.
        var map = context.MergedJobDataMap;
        if (!TryReadId(map, IWorkflowScheduler.WorkflowIdKey, out var workflowId) ||
            !TryReadId(map, IWorkflowScheduler.JobIdKey, out var jobId))
        {
            // Neither id is logged: an unparseable value is by definition not an id, and the point of
            // this record is that the map was wrong, not what it said.
            logger.LogWarning("a fire arrived with a job-data map that carries no usable ids; skipping");
            return;
        }

        using (logger.BeginScope(ExecutionLogScope.BuildState(
                   workflowId, Guid.Empty, Guid.Empty, Guid.Empty, Guid.Empty)))
        {
            if (!store.TryGet(workflowId, out var entry))
            {
                // The workflow was stopped and this job is on its way out. Returning without
                // rescheduling is the point: arming a successor would resurrect what the stop deleted.
                logger.LogInformation("the workflow is no longer in L1; this fire dispatches nothing");
                return;
            }

            if (leaderState.IsLeader)
            {
                await DispatchEntryStepsAsync(workflowId, entry.Definition, context).ConfigureAwait(false);
            }
            else
            {
                logger.LogDebug("not the leader; skipping the dispatch and arming the next fire");
            }

            // Re-read L1 rather than reusing the entry above. The whole value of this check is that it
            // sees what landed *while* the dispatch was running — a start that superseded this job, or
            // a stop that removed the workflow outright. A cached read would see neither.
            if (!store.TryGet(workflowId, out var current) || current.JobId != jobId)
            {
                logger.LogInformation(
                    "this fire's job is no longer the one L1 holds; standing down without rescheduling");
                return;
            }

            if (current.Definition.Cron is not { } cron)
            {
                // Unreachable in practice — a workflow with no cron is never scheduled, so no job of
                // it exists to fire. Stated rather than assumed away with a null-forgiving operator,
                // because the day it becomes reachable it should say so in a log rather than throw
                // inside Quartz.
                logger.LogWarning("the workflow carries no cron; nothing to arm the next fire from");
                return;
            }

            await scheduler.RescheduleAsync(workflowId, jobId, cron, context.CancellationToken)
                .ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Reads one id out of the job-data map, treating "absent" and "not a guid" as the same answer.
    /// <para>
    /// <c>TryGetValue</c> rather than <c>JobDataMap.GetString</c>, which throws a
    /// <see cref="KeyNotFoundException"/> for a key that is not there. A missing key is the same class
    /// of problem as an unparseable one — the map is wrong — and this method is reached from a Quartz
    /// job, where throwing means a job exception logged on every tick of a job that can never work.
    /// </para>
    /// </summary>
    private static bool TryReadId(JobDataMap map, string key, out Guid value)
    {
        value = Guid.Empty;
        return map.TryGetValue(key, out var raw) && Guid.TryParse(raw as string, out value);
    }

    /// <summary>
    /// Sends one dispatch per entry step, under one correlation id.
    /// <para>
    /// <paramref name="workflowId"/> comes from the job-data map rather than from
    /// <see cref="WorkflowL1.WorkflowId"/>, which holds the same value: the id this fire logs under
    /// and the id it dispatches under have to be one id, or a mismatch between them would be
    /// invisible in exactly the records written to find it.
    /// </para>
    /// </summary>
    private async Task DispatchEntryStepsAsync(
        Guid workflowId, WorkflowL1 definition, IJobExecutionContext context)
    {
        // One id per fire, shared by every entry step of it: this is what ties one run together, and
        // a mint per dispatch would split a single run across as many runs as the workflow has entry
        // steps in every log query and every downstream projection.
        var correlationId = Guid.NewGuid();

        foreach (var entryStepId in definition.EntryStepIds)
        {
            var step = definition.Steps.FirstOrDefault(s => s.StepId == entryStepId);
            if (step is null)
            {
                logger.LogWarning(
                    "entry step {StepId} is not in the workflow's step set; skipping it",
                    entryStepId.ToString("D"));
                continue;
            }

            var state = ExecutionLogScope.BuildState(
                Guid.Empty, step.StepId, step.ProcessorId, Guid.Empty, Guid.Empty);
            state[CorrelationKeys.LogScope] = CorrelationKeys.Render(correlationId);

            using (logger.BeginScope(state))
            {
                var dispatch = new ProcessDispatch(workflowId, step.StepId, step.ProcessorId)
                {
                    CorrelationId = correlationId,

                    // An entry step is a source step: no upstream input, so the author produces its
                    // own. That is the branch the processor's pre handler already implements.
                    EntryId = Guid.Empty,

                    // An entry dispatch opens no lineage; the author mints the execution id.
                    ExecutionId = Guid.Empty,

                    Payload = step.Payload,
                };

                try
                {
                    await sender.SendAsync(
                            ProcessorQueues.Work(step.ProcessorId),
                            MessageTypes.ProcessDispatch,
                            dispatch,
                            context.CancellationToken)
                        .ConfigureAwait(false);

                    // The only record a successful fire leaves. Without it the correlation id minted
                    // above — the one thing tying this run to everything the processors go on to do
                    // with it — would exist solely inside messages, and a run could not be found from
                    // the orchestrator's side at all. Every id rides the open scope; the template
                    // carries none, and never the payload.
                    logger.LogInformation("dispatched an entry step");
                }
                catch (Exception ex) when (!context.CancellationToken.IsCancellationRequested)
                {
                    // See the type remarks: swallowed on purpose, and only here. The ids are already
                    // in the open scope, so the record carries them without putting one in a template.
                    logger.LogWarning(ex, "the entry-step dispatch failed to send; continuing");
                }
            }
        }
    }
}
