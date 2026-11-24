using System.Text.Json;
using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Orchestrator.L1;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The activation path is the single method hydration and the start handler both call, so what it
/// does with one workflow is the whole of what either of them does with one workflow. These cover the
/// four outcomes spec §7.1 distinguishes: a scheduled workflow, an unscheduled one, one that is not
/// live, and a second activation of one already live.
/// </summary>
public sealed class WorkflowActivatorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid S2 = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();

        public IConnectionMultiplexer Redis { get; }

        /// <summary>Shared across every <see cref="Build"/>, so a second activation sees the first's L1 entry.</summary>
        public WorkflowL1Store Store { get; } = new();

        public RecordingWorkflowScheduler Scheduler { get; } = new();

        public Harness()
        {
            Redis = Substitute.For<IConnectionMultiplexer>();
            Redis.GetDatabase().Returns(Db);

            // No "absent workflow" stub: NSubstitute returns false for an unstubbed SetContainsAsync —
            // not in the live set — and default(RedisValue) for an unstubbed HashGetAsync, whose
            // IsNullOrEmpty is true — which is exactly what an absent store looks like to the reader.
        }

        /// <summary>
        /// What a start leaves in L2: the id in the live set, and the same store JSON
        /// <c>L2ProjectionWriter</c> writes on the workflow hash. <paramref name="cron"/> is the entry
        /// step's cron; null leaves it unscheduled.
        /// </summary>
        public Harness WithWorkflow(Guid workflowId, string? cron, Guid entry, Guid processor) =>
            WithRawStore(workflowId, JsonSerializer.Serialize(
                new WorkflowStoreProjection(
                    EntryStepIds: [entry],
                    Steps: [new StepL1(entry, EntryCondition: 0, ProcessorId: processor, Payload: "{}", NextStepIds: [])],
                    EntryCrons: cron is null ? null : new Dictionary<Guid, string> { [entry] = cron }),
                MessagingJson.Options));

        /// <summary>
        /// A workflow with two entry steps, <see cref="S"/> and <see cref="S2"/>, each on the cron given
        /// for it (null leaves that step unscheduled) — two distinct crons split one workflow into groups.
        /// </summary>
        public Harness WithTwoEntries(Guid workflowId, string? sCron, string? s2Cron)
        {
            var crons = new Dictionary<Guid, string>();
            if (sCron is not null)
            {
                crons[S] = sCron;
            }

            if (s2Cron is not null)
            {
                crons[S2] = s2Cron;
            }

            return WithRawStore(workflowId, JsonSerializer.Serialize(
                new WorkflowStoreProjection(
                    EntryStepIds: [S, S2],
                    Steps:
                    [
                        new StepL1(S, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: []),
                        new StepL1(S2, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: []),
                    ],
                    EntryCrons: crons.Count == 0 ? null : crons),
                MessagingJson.Options));
        }

        /// <summary>The id in the live set and <paramref name="store"/>, verbatim, on the workflow hash.</summary>
        public Harness WithRawStore(Guid workflowId, string store)
        {
            Db.SetContainsAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"), Arg.Any<CommandFlags>())
                .Returns(true);
            Db.HashGetAsync(L2ProjectionKeys.Workflow(workflowId), L2ProjectionKeys.StoreField, Arg.Any<CommandFlags>())
                .Returns((RedisValue)store);

            return this;
        }

        public WorkflowActivator Build() => new(
            new L2WorkflowReader(Redis, NullLogger<L2WorkflowReader>.Instance),
            Store,
            Scheduler,
            NullLogger<WorkflowActivator>.Instance);
    }

    [Fact]
    public async Task MirrorsL2IntoL1AndSchedulesAWorkflowWithACron()
    {
        var h = new Harness().WithWorkflow(W, cron: "0 * * * *", entry: S, processor: P);

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out var entry));
        Assert.Equal(W, entry.Definition.WorkflowId);

        // The job id handed to the scheduler must be the job id L1 recorded, and this is the only
        // place that is true by construction rather than by coincidence. WorkflowFireJob reads its own
        // job id out of the job-data map and stands down unless L1 still holds that same id for the
        // workflow; if the two ever diverged here, every fire would decline to reschedule and the
        // replica would silently stop firing anything, with nothing failing and nothing logged.
        Assert.Equal((W, entry.JobId, 0, "0 * * * *"), Assert.Single(h.Scheduler.Scheduled));
    }

    [Fact]
    public async Task MirrorsButDoesNotScheduleAWorkflowWithNoCron()
    {
        // An entry step with no cron is unscheduled, which is a valid projection — WorkflowL1's own doc
        // puts that decision with whoever reads the root, which is this method.
        var h = new Harness().WithWorkflow(W, cron: null, entry: S, processor: P);

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out _));
        Assert.Empty(h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task DoesNothingAtAllWhenL2DoesNotHoldTheWorkflow()
    {
        // Reachable: a stop took the workflow out of the live set after the announcement was
        // published. The live set is the source of truth, so the correct action is none.
        var h = new Harness();   // no workflow written

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.False(h.Store.TryGetActive(W, out _));
        Assert.Empty(h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task TearsDownAnExistingJobBeforeSchedulingTheReplacement()
    {
        // Teardown-then-apply is what makes a redelivered announcement converge instead of accumulating
        // a second live job for the same workflow.
        var h = new Harness().WithWorkflow(W, cron: "0 * * * *", entry: S, processor: P);
        await h.Build().ActivateAsync(W, CancellationToken.None);
        var first = h.Store.TryGetActive(W, out var e1) ? e1.JobId : Guid.Empty;

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.Equal([W, W], h.Scheduler.Unscheduled);
        Assert.True(h.Store.TryGetActive(W, out var e2));
        Assert.NotEqual(first, e2.JobId);

        // Teardown strictly before apply. The teardown removes the workflow's whole Quartz group, so
        // a teardown landing after the schedule would delete the replacement too — and the
        // convergence argument in WorkflowActivator's own doc is an ordering claim, which needs an
        // ordered record to rest on.
        // Every activation clears first, the first one included.
        Assert.Equal(
            ["UnscheduleWorkflowAsync", "ScheduleAsync", "UnscheduleWorkflowAsync", "ScheduleAsync"],
            h.Scheduler.Calls);

        // The replacement went out under the NEW job id, not the torn-down one. Assert.NotEqual above
        // says L1 moved on; this says the scheduler was told the same thing.
        Assert.Equal((W, e2.JobId, 0, "0 * * * *"), h.Scheduler.Scheduled[1]);
    }

    [Fact]
    public async Task TwoCronsScheduleTwoGroupsUnderOneActivation()
    {
        var h = new Harness().WithTwoEntries(W, sCron: "*/30 * * * * *", s2Cron: "*/10 * * * * *");

        await h.Build().ActivateAsync(W, CancellationToken.None);

        // One activation id for every group: the fire job's supersession check compares activation
        // ids, so a later start retires every group's job at once only if they all share this one.
        Assert.True(h.Store.TryGetActive(W, out var entry));
        Assert.Equal(
            [(W, entry.JobId, 0, "*/30 * * * * *"), (W, entry.JobId, 1, "*/10 * * * * *")],
            h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task TwoEntryCronsEqualAfterNormalizationMakeOneGroup()
    {
        // Equal after normalization: whitespace alone does not make a second schedule.
        var h = new Harness().WithTwoEntries(W, sCron: "*/30 * * * * *", s2Cron: "  */30  * * * * * ");

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out var entry));
        Assert.Equal((W, entry.JobId, 0, "*/30 * * * * *"), Assert.Single(h.Scheduler.Scheduled));
    }

    [Fact]
    public async Task AnEntryWithoutACronIsLeftUnscheduled()
    {
        var h = new Harness().WithTwoEntries(W, sCron: null, s2Cron: "*/10 * * * * *");

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out var entry));
        Assert.Equal((W, entry.JobId, 0, "*/10 * * * * *"), Assert.Single(h.Scheduler.Scheduled));
    }

    [Fact]
    public async Task AStoreWithOnlyALegacyCronSchedulesNothing()
    {
        // A store written while workflows still had a cron: a top-level "cron" and no "entryCrons".
        // It still activates — the definition reads — but there is no workflow cron to fall back to.
        var store =
            $"{{\"entryStepIds\":[\"{S:D}\"],\"cron\":\"*/30 * * * * *\",\"steps\":[{{\"StepId\":\"{S:D}\","
            + $"\"EntryCondition\":0,\"ProcessorId\":\"{P:D}\",\"Payload\":\"{{}}\",\"NextStepIds\":[]}}]}}";
        var h = new Harness().WithRawStore(W, store);

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out var entry));
        Assert.Equal([S], entry.Definition.EntryStepIds);
        Assert.DoesNotContain("ScheduleAsync", h.Scheduler.Calls);
        Assert.Empty(h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task ARestartUnschedulesTheWholeWorkflowBeforeScheduling()
    {
        // A workflow this replica already holds, under an activation whose jobs were never recorded
        // by this scheduler: the teardown is one group delete keyed by the workflow, so it does not
        // need to know how many jobs the previous activation had.
        var h = new Harness().WithTwoEntries(W, sCron: "*/30 * * * * *", s2Cron: "*/10 * * * * *");
        var previous = Guid.NewGuid();
        h.Store.Set(W, new WorkflowL1(W, [S, S2], [], []), previous);

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.Equal(["UnscheduleWorkflowAsync", "ScheduleAsync", "ScheduleAsync"], h.Scheduler.Calls);
        Assert.Equal([W], h.Scheduler.Unscheduled);
        Assert.True(h.Store.TryGetActive(W, out var entry));
        Assert.NotEqual(previous, entry.JobId);
        Assert.All(h.Scheduler.Scheduled, s => Assert.Equal(entry.JobId, s.ActivationId));
    }
}
