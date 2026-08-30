using BaseConsole.Core.Messaging;
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
    /// <summary>
    /// <c>Never</c> from the API's <c>StepEntryCondition</c>, as an int — the same reach-across
    /// <see cref="Dispatch.StepAdvancement"/> makes for <c>Always</c>, and for the same reason: the
    /// orchestrator references only <c>Messaging.Contracts</c>, so the enum itself is out of scope.
    /// <para>
    /// <b>That <see cref="Dispatch.StepAdvancement"/> deliberately has no such constant is not a
    /// contradiction of this one.</b> There, <c>Never</c> is not a case — it is every value the
    /// advancement predicate declines, and naming it would invite a branch that treats an absence as
    /// a case. Here it is the opposite: an entry step has no predecessor, so no condition is being
    /// evaluated against anything, and <c>Never</c> is the single value the fire tests for. The two
    /// paths ask different questions of the same field, which is why one names it and one must not.
    /// </para>
    /// </summary>
    private const int Never = 5;

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

        using (logger.BeginScope(ExecutionLogScope.BuildScope(
                   Guid.Empty, workflowId, Guid.Empty, Guid.Empty, Guid.Empty)))
        {
            // ACTIVE, not merely held. A stop marks the L1 entry and leaves it in place so steps still
            // in flight can resolve against the definition, so "is it in L1" no longer answers "may it
            // dispatch". Reading the marked entry here would have a stopped workflow keep firing.
            if (!store.TryGetActive(workflowId, out var entry))
            {
                // The workflow was stopped and this job is on its way out. Returning without
                // rescheduling is the point: arming a successor would resurrect what the stop halted.
                logger.LogInformation("the workflow is not active in L1; this fire dispatches nothing");
                return;
            }

            // Leadership alone, where the reference gates on `IsLeader && IsHydrated`. Dropping the
            // hydration term is deliberate, not an omission: the reference's second term fenced a cold
            // leader firing against an empty L1, and that state cannot be reached here. A Quartz job
            // exists only because WorkflowActivator put both the L1 entry and the job there, in that
            // order, so a fire that arrives before L1 holds its workflow returns at the lookup above —
            // before this gate is consulted at all. A term that can never be false is a term that
            // reads as a live mechanism while protecting nothing.
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
            // a stop that marked the workflow. A cached read would see neither.
            //
            // ACTIVE, and this is the call site where getting it wrong is worst. A stop leaves the
            // entry in place with its JobId intact, so a lookup that admitted marked entries would
            // match this fire's own job, fall through, and call RescheduleAsync — arming the next fire
            // of a workflow that was just stopped, and then the next, indefinitely. The stop would
            // survive on the API side and be silently undone here.
            if (!store.TryGetActive(workflowId, out var current) || current.JobId != jobId)
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
    /// Sends one dispatch per entry step, under one correlation id — except for entry steps frozen
    /// with the <c>Never</c> entry condition, which are skipped. See the guard below: that is the
    /// only entry condition an entry step's dispatch consults, because it is the only one that says
    /// anything about a step with no predecessor.
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

            // A FROZEN ENTRY STEP, and the only entry condition this path reads at all.
            //
            // An entry step has no predecessor, so the outcome-shaped conditions — PreviousCompleted,
            // PreviousFailed, PreviousCancelled — have nothing to be evaluated against and are simply
            // not consulted here; nor is Always, which is what they all collapse to when there is no
            // predecessor. Never is different in kind: it is not a claim about an outcome, it is a
            // claim about the step, and it is the same claim on both paths — this step does not run.
            // Honouring it here is what makes that one reading true everywhere rather than only on
            // edges.
            //
            // This is the operator's per-entry-step freeze. A stop halts the whole workflow, which is
            // the wrong instrument when a workflow has several entry steps and only one of them needs
            // to stand down: the others would go quiet with it. Setting this one to Never and
            // re-issuing start leaves the schedule armed and its siblings firing, and takes this step
            // out. The freeze is not live — L1 is a projection, so it lands on the next start, which
            // is idempotent and does not require a stop first.
            //
            // Continue, not return: a frozen step suppresses itself and nothing else, and the
            // reschedule at the call site is untouched either way. It is also INSIDE the scope
            // below rather than before it, which costs a dictionary on a step that will not be
            // dispatched and buys two things. The record carries StepId and ProcessorId the way
            // every sibling line does — from the scope, not from the template — and it carries the
            // fire's correlation id, so "this fire skipped that step" sits under the same id as the
            // steps the same fire dispatched. Interpolating the id into the message instead would
            // put it on the record too, since the scope keys and the template parameter names are
            // deliberately the same, but it would make the body unique per step: body.text is
            // indexed as a KEYWORD, so a body carrying an id can only be found by a wildcard, while
            // one that does not is an exact-match term like every other message here.
            var state = ExecutionLogScope.BuildScope(
                Guid.Empty, Guid.Empty, step.StepId, step.ProcessorId, Guid.Empty);
            state[CorrelationKeys.LogScope] = CorrelationKeys.Render(correlationId);

            using (logger.BeginScope(state))
            {
                if (step.EntryCondition == Never)
                {
                    logger.LogInformation(
                        "the entry step is frozen — its entry condition is Never; skipping it");
                    continue;
                }

                // Positional, in the canonical id order ProcessDispatch documents. The two
                // Guid.Empty arguments are load-bearing sentinels rather than unset fields: the
                // execution id because an entry dispatch opens no lineage and the author mints one,
                // and the entry id because an entry step is a source step — no upstream input, so the
                // author produces its own. That second one is the branch the processor's pre handler
                // already implements, and it is also why a source step has no key to reclaim and so no
                // idempotence token against a redelivery.
                var dispatch = new ProcessDispatch(
                    correlationId, Guid.Empty, workflowId, step.StepId, step.ProcessorId,
                    step.Payload, Guid.Empty);

                // A dispatch starts a step, so it starts the clock. A cron fire is not inside any
                // delivery, so there is nothing to inherit here -- this is belt-and-braces with the
                // handoff path, and it keeps the rule "a dispatch begins a chain" true at every
                // site rather than at one.
                MessageClock.BeginChain();

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
                    //
                    // The filter is deliberately wider than the reference's, which is
                    // `!(ex is OperationCanceledException && …IsCancellationRequested)` and so goes on
                    // swallowing a genuine broker fault that happens to coincide with shutdown. Once
                    // the token is cancelled there is nothing left worth surviving for — the schedule
                    // chain this swallow protects is being torn down either way — so the simpler rule
                    // is the honest one: after cancellation, nothing here is absorbed.
                    logger.LogWarning(ex, "the entry-step dispatch failed to send; continuing");
                }
            }
        }
    }
}
