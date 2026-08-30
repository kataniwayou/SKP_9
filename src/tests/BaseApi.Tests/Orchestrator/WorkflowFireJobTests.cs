using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Orchestrator.Election;
using Orchestrator.L1;
using Orchestrator.Scheduling;
using Quartz;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The fire: the one place in this service that puts work on a processor's queue.
/// <para>
/// <b>Nothing here stands up Quartz.</b> A fire is a method taking a job-execution context, and every
/// claim these tests make — what was dispatched, whether the leader gate was consulted, whether the
/// job armed its successor — is a claim about that method, not about the store Quartz would have read
/// the context out of. The context a fire really receives is asserted on the other side, in
/// <see cref="WorkflowSchedulerTests"/>, against a real job store; the two files meet at
/// <see cref="IWorkflowScheduler.WorkflowIdKey"/> and <see cref="IWorkflowScheduler.JobIdKey"/>, which
/// is why the map below is written through those constants and never through a literal.
/// </para>
/// </summary>
public sealed class WorkflowFireJobTests
{
    private static readonly Guid W  = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid S2 = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid P1 = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid P2 = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private const string EveryHour = "0 * * * *";
    private const string Config    = "{\"setting\":1}";

    // The API's StepEntryCondition as ints, because the orchestrator's contracts carry the field as
    // one. PreviousCompleted is what an ordinary step holds; Never is the operator's freeze.
    private const int PreviousCompleted = 1;
    private const int Never             = 5;

    private sealed class Harness
    {
        private WorkflowL1 _definition = new(W, [], EveryHour, []);

        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();

        public WorkflowL1Store Store { get; } = new();

        public RecordingWorkflowScheduler Scheduler { get; } = new();

        public LeaderState State { get; } = new();

        /// <summary>The job id L1 holds for the workflow, and the one the fire's context carries.</summary>
        public Guid JobId { get; } = Guid.Parse("66666666-6666-6666-6666-666666666666");

        /// <summary>The definition as L1 holds it, so a test can guard against a vacuous pass.</summary>
        public WorkflowL1 Definition => _definition;

        public Harness AsLeader()
        {
            State.BecomeLeader();
            return this;
        }

        public Harness AsFollower()
        {
            State.BecomeFollower();
            return this;
        }

        /// <summary>
        /// Puts <paramref name="workflowId"/> in L1 as an activation would: every entry step is also a
        /// step of the graph, carrying a payload, and the whole thing is held under
        /// <see cref="JobId"/>.
        /// </summary>
        public Harness WithWorkflow(Guid workflowId, (Guid StepId, Guid ProcessorId)[] entries) =>
            WithGatedWorkflow(
                workflowId,
                entries.Select(e => (e.StepId, e.ProcessorId, PreviousCompleted)).ToArray());

        /// <summary>
        /// As <see cref="WithWorkflow"/>, but each entry step carries the entry condition given
        /// rather than the ordinary one — for the cases that turn on the value of that field.
        /// </summary>
        public Harness WithGatedWorkflow(
            Guid workflowId, (Guid StepId, Guid ProcessorId, int EntryCondition)[] entries)
        {
            _definition = new WorkflowL1(
                workflowId,
                entries.Select(e => e.StepId).ToList(),
                EveryHour,
                entries.Select(e => new StepL1(
                    e.StepId, e.EntryCondition, e.ProcessorId, Config, [])).ToList());

            Store.Set(workflowId, _definition, JobId);
            return this;
        }

        /// <summary>
        /// What a start arriving mid-fire leaves behind: L1 holds the same workflow under a different
        /// job id, because the activation that landed deleted this fire's job and stood up another.
        /// </summary>
        public void SupersedeJob(Guid workflowId) => Store.Set(workflowId, _definition, Guid.NewGuid());

        /// <summary>
        /// Marks the workflow stopped, as a stop applied mid-fire would.
        /// <para>
        /// <b>Marked, not removed, and that is what makes these tests worth having.</b> A stop leaves
        /// the entry in L1 — with its job id intact — so that steps still in flight can resolve
        /// against the definition. The fire job therefore cannot ask "is it in L1"; it has to ask
        /// whether the workflow is still active, and a lookup that admitted marked entries would match
        /// this fire's own job id and arm the next fire of a workflow that was just stopped.
        /// </para>
        /// </summary>
        public void StopWorkflow(Guid workflowId) =>
            Store.MarkDeleted(workflowId, DateTimeOffset.UnixEpoch);

        public WorkflowFireJob Build() => new(
            Store, Scheduler, Sender, State, NullLogger<WorkflowFireJob>.Instance);

        /// <summary>The context a fire of this workflow's own job arrives with.</summary>
        public IJobExecutionContext Context(Guid workflowId, Guid jobId) =>
            ContextWith(workflowId.ToString("D"), jobId.ToString("D"), CancellationToken.None);

        /// <summary>
        /// The same context under a token the host has already cancelled — what a fire in progress
        /// sees once shutdown has begun.
        /// </summary>
        public IJobExecutionContext CancelledContext(Guid workflowId, Guid jobId, CancellationToken ct) =>
            ContextWith(workflowId.ToString("D"), jobId.ToString("D"), ct);

        /// <summary>
        /// A context whose job-data values are whatever the caller says, for the cases where the map
        /// carries something that will not parse, or nothing at all.
        /// </summary>
        public IJobExecutionContext RawContext(string? workflowId, string? jobId) =>
            ContextWith(workflowId, jobId, CancellationToken.None);

        private static IJobExecutionContext ContextWith(string? workflowId, string? jobId, CancellationToken ct)
        {
            var map = new JobDataMap();
            if (workflowId is not null)
            {
                map[IWorkflowScheduler.WorkflowIdKey] = workflowId;
            }

            if (jobId is not null)
            {
                map[IWorkflowScheduler.JobIdKey] = jobId;
            }

            var context = Substitute.For<IJobExecutionContext>();
            context.MergedJobDataMap.Returns(map);
            context.CancellationToken.Returns(ct);
            return context;
        }
    }

    [Fact]
    public async Task TheLeaderDispatchesOneProcessDispatchPerEntryStep()
    {
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1), (S2, P2)]);

        await h.Build().Execute(h.Context(W, h.JobId));

        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P1), MessageTypes.ProcessDispatch,
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P2), MessageTypes.ProcessDispatch,
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task AnEntryStepFrozenWithNeverIsNotDispatchedWhileItsSiblingsStillAre()
    {
        // The whole point of the freeze: one entry step stands down and the workflow keeps running.
        // A stop would have taken S2 with it, which is the instrument this exists to avoid.
        var h = new Harness().AsLeader().WithGatedWorkflow(
            W, entries: [(S1, P1, Never), (S2, P2, PreviousCompleted)]);

        await h.Build().Execute(h.Context(W, h.JobId));

        await h.Sender.DidNotReceive().SendAsync(ProcessorQueues.Work(P1), Arg.Any<string>(),
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P2), MessageTypes.ProcessDispatch,
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task AWorkflowWhoseEntryStepsAreAllFrozenDispatchesNothingButStillReschedules()
    {
        // Frozen is not stopped. The schedule stays armed, so unfreezing is a start rather than a
        // start plus whatever it would take to rebuild a job that had been allowed to lapse.
        var h = new Harness().AsLeader().WithGatedWorkflow(
            W, entries: [(S1, P1, Never), (S2, P2, Never)]);

        await h.Build().Execute(h.Context(W, h.JobId));

        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(),
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
        Assert.Equal(1, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task TheOutcomeShapedEntryConditionsDoNotSuppressAnEntryStep()
    {
        // Never is the only value this path reads. An entry step has no predecessor, so a condition
        // that talks about one has nothing to be evaluated against and must not be read as a gate --
        // treating PreviousFailed as "only fire on failure" would silence a step that is meant to run
        // every fire.
        foreach (var condition in new[] { 0, 1, 2, 3, 4 })
        {
            var h = new Harness().AsLeader().WithGatedWorkflow(W, entries: [(S1, P1, condition)]);

            await h.Build().Execute(h.Context(W, h.JobId));

            await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P1), MessageTypes.ProcessDispatch,
                Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
        }
    }

    [Fact]
    public async Task AnEntryDispatchCarriesNoEntryIdAndNoExecutionId()
    {
        // An entry step is a source step: no upstream input, so the author produces its own. That is
        // the isSource branch the processor's pre handler already implements. An entry dispatch opens
        // no lineage either — the author mints one via NewExecutionId.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);
        ProcessDispatch? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessDispatch>(d => sent = d),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal(Guid.Empty, sent!.EntryId);
        Assert.Equal(Guid.Empty, sent.ExecutionId);
        Assert.NotEqual(Guid.Empty, sent.CorrelationId);

        // The rest of the body is what makes the dispatch actionable: which step, on which processor,
        // under which config. A dispatch carrying the right empty ids and the wrong step would satisfy
        // every assertion above.
        Assert.Equal(W, sent.WorkflowId);
        Assert.Equal(S1, sent.StepId);
        Assert.Equal(P1, sent.ProcessorId);
        Assert.Equal(Config, sent.Payload);
    }

    [Fact]
    public async Task TwoFiresOfTheSameWorkflowGetDifferentCorrelationIds()
    {
        // The correlation id is what ties one run together. Reusing it across fires would make two
        // runs indistinguishable in the logs and in every downstream projection.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);
        var ids = new List<Guid>();
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(),
                                 Arg.Do<ProcessDispatch>(d => ids.Add(d.CorrelationId)),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());

        await h.Build().Execute(h.Context(W, h.JobId));
        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal(2, ids.Distinct().Count());
    }

    [Fact]
    public async Task OneFireSharesOneCorrelationIdAcrossItsEntrySteps()
    {
        // The other half of the claim above: freshly minted per fire, not per dispatch. Two entry
        // steps of one fire are one run, and a per-dispatch mint would split that run in two in every
        // projection that reads the id.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1), (S2, P2)]);
        var ids = new List<Guid>();
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(),
                                 Arg.Do<ProcessDispatch>(d => ids.Add(d.CorrelationId)),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal(2, ids.Count);
        Assert.Single(ids.Distinct());
    }

    [Fact]
    public async Task AFollowerDispatchesNothingButStillReschedules()
    {
        // The gate sits before the dispatch only. A follower that returned early without rescheduling
        // would never fire again on that replica — so the workflow would stop the moment it was
        // promoted, which is exactly when it must not.
        var h = new Harness().AsFollower().WithWorkflow(W, entries: [(S1, P1)]);

        // Guards the vacuous pass this test is most exposed to: with no entry step to dispatch, the
        // emptiness asserted below would hold no matter what the gate did.
        Assert.NotEmpty(h.Definition.EntryStepIds);

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Empty(h.Sender.ReceivedCalls());
        Assert.Equal(1, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task ASupersededFireDoesNotReschedule()
    {
        // A start arriving mid-fire deletes this job and schedules a replacement. This fire's
        // self-reschedule would re-create the deleted job — a non-durable one-shot with no triggers is
        // auto-purged, so its reschedule has to be able to recreate it — leaving two live jobs for one
        // workflow, both firing every tick and double-dispatching every entry step.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);

        // The start lands *while the dispatch is running*, which is the only moment this check exists
        // for and the only arrangement that can tell a re-read from a cached one: L1 still holds this
        // fire's job when the fire looks it up at the top, and holds a replacement by the time the
        // fire goes to arm its successor. Superseding before Execute would leave an implementation
        // that reused its first lookup passing this test identically.
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(),
                                 Arg.Do<ProcessDispatch>(_ => h.SupersedeJob(W)),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal(0, h.Scheduler.RescheduleCount);

        // Guards the vacuous pass: a fire that bailed out before the dispatch — on the map, on the L1
        // lookup, on anything — would also reschedule nothing. The dispatch having happened is what
        // pins the zero above on the supersession check and on nothing else.
        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P1), MessageTypes.ProcessDispatch,
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task AFireForAWorkflowStoppedMidFireDoesNotReschedule()
    {
        // The same check on its other outcome — the workflow no longer active, rather than active
        // under a different job id — and it is only reachable mid-fire. A stop applied before the fire
        // returns at the very first L1 lookup and never reaches the check at all, which is what
        // AFireForAWorkflowAbsentFromL1 covers; applying it from inside the dispatch is what makes
        // this the second outcome of the *second* lookup and not a duplicate of that test.
        //
        // THIS IS THE RESURRECTION GUARD, and it only became one when stops started marking instead
        // of deleting. The marked entry keeps this fire's own job id, so a second lookup that admitted
        // marked entries would match, fall through, and arm the next fire of a workflow that was just
        // stopped — and then the next, indefinitely. The stop would stand on the API side and be
        // silently undone here. Nothing else in the suite would notice.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);

        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(),
                                 Arg.Do<ProcessDispatch>(_ => h.StopWorkflow(W)),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal(0, h.Scheduler.RescheduleCount);

        // The same vacuity guard as above: the fire must have got as far as the dispatch, or the zero
        // says nothing about the check this test is named for.
        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P1), MessageTypes.ProcessDispatch,
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task ASendFaultIsSwallowedSoTheScheduleChainSurvives()
    {
        // A self-rescheduling one-shot that throws before rescheduling never fires again, so a
        // transient broker blip would stop the workflow permanently on this replica. This is the one
        // send path in the system that swallows, and the swallow is per entry step.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1), (S2, P2)]);
        h.Sender.SendAsync(ProcessorQueues.Work(P1), Arg.Any<string>(), Arg.Any<ProcessDispatch>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>())
                .ThrowsAsync(new TransientSendException("blip", new IOException("down")));

        await h.Build().Execute(h.Context(W, h.JobId));   // must not throw

        await h.Sender.Received(1).SendAsync(ProcessorQueues.Work(P2), Arg.Any<string>(),
            Arg.Any<ProcessDispatch>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>());
        Assert.Equal(1, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task AShutdownCancellationPropagatesRatherThanBeingSwallowed()
    {
        // The one exception to the swallow above. Shutdown has to be able to end a fire in progress;
        // a catch that absorbed it would leave the host waiting on work it has already asked to stop,
        // and would arm a successor for a scheduler that is being torn down.
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);
        h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessDispatch>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<string?>())
                .ThrowsAsync(new OperationCanceledException(cts.Token));

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => h.Build().Execute(h.CancelledContext(W, h.JobId, cts.Token)));

        Assert.Equal(0, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task AFireForAWorkflowAbsentFromL1DispatchesNothingAndArmsNothing()
    {
        // The workflow was stopped and this job is on its way out. Business, not a fault: nothing to
        // dispatch, and nothing to arm — arming would resurrect the job the stop deleted.
        var h = new Harness().AsLeader();

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Empty(h.Sender.ReceivedCalls());
        Assert.Equal(0, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task AJobDataMapThatWillNotParseIsSkippedRatherThanThrown()
    {
        // There is nothing here to retry and nothing to park: throwing would put a job exception in
        // the log every tick for a job that can never work. The fire says so once and stands down.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);

        await h.Build().Execute(h.RawContext("not-a-guid", h.JobId.ToString("D")));

        Assert.Empty(h.Sender.ReceivedCalls());
        Assert.Equal(0, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task AMissingJobIdIsSkippedRatherThanTreatedAsEmpty()
    {
        // Without the job id there is no supersession check to make. Falling through to Guid.Empty
        // would compare a real L1 job id against a sentinel that can never match — which happens to
        // stand down, and is the wrong reason to stand down.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);

        await h.Build().Execute(h.RawContext(W.ToString("D"), jobId: null));

        Assert.Empty(h.Sender.ReceivedCalls());
        Assert.Equal(0, h.Scheduler.RescheduleCount);
    }

    [Fact]
    public async Task TheRescheduleCarriesTheWorkflowsOwnIdsAndCron()
    {
        // RescheduleAsync re-creates a purged job from exactly these three values, so a fire that
        // armed its successor under the wrong ones would leave behind a job that could never find the
        // workflow it fires again.
        var h = new Harness().AsLeader().WithWorkflow(W, entries: [(S1, P1)]);

        await h.Build().Execute(h.Context(W, h.JobId));

        Assert.Equal((W, h.JobId, EveryHour), Assert.Single(h.Scheduler.Rescheduled));
    }
}
