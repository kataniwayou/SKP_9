using System.Text.Json;
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
/// four outcomes spec §7.1 distinguishes: a scheduled workflow, an unscheduled one, one L2 no longer
/// holds, and a second activation of one already live.
/// </summary>
public sealed class WorkflowActivatorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

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

            // No "absent workflow" stub: NSubstitute returns default(RedisValue) for an unstubbed
            // StringGetAsync, and default(RedisValue).IsNullOrEmpty is true — which is exactly what an
            // absent key looks like to the reader.
        }

        /// <summary>Writes the same JSON <c>L2ProjectionWriter</c> writes: a root, and one step key.</summary>
        public Harness WithWorkflow(Guid workflowId, string? cron, Guid entry, Guid processor)
        {
            var root = JsonSerializer.Serialize(
                new WorkflowRootProjection(
                    EntryStepIds: [entry],
                    StepIds: [entry],
                    Cron: cron,
                    Liveness: new LivenessProjection(DateTime.UtcNow, 3600, "Pending")),
                MessagingJson.Options);
            Db.StringGetAsync(L2ProjectionKeys.Root(workflowId), Arg.Any<CommandFlags>())
                .Returns((RedisValue)root);

            var step = JsonSerializer.Serialize(
                new StepProjection(
                    EntryCondition: 0, ProcessorId: processor, Payload: "{}", NextStepIds: []),
                MessagingJson.Options);
            Db.StringGetAsync(L2ProjectionKeys.Step(workflowId, entry), Arg.Any<CommandFlags>())
                .Returns((RedisValue)step);

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

        Assert.True(h.Store.TryGet(W, out var entry));
        Assert.Equal(W, entry.Definition.WorkflowId);

        // The job id handed to the scheduler must be the job id L1 recorded, and this is the only
        // place that is true by construction rather than by coincidence. Task 9's fire reads its own
        // job id out of the job-data map and stands down unless L1 still holds that same id for the
        // workflow; if the two ever diverged here, every fire would decline to reschedule and the
        // replica would silently stop firing anything, with nothing failing and nothing logged.
        Assert.Equal((W, entry.JobId, "0 * * * *"), Assert.Single(h.Scheduler.Scheduled));
    }

    [Fact]
    public async Task MirrorsButDoesNotScheduleAWorkflowWithNoCron()
    {
        // A null cron means unscheduled, which is a valid projection — WorkflowL1's own doc puts that
        // decision with whoever reads the root, which is this method.
        var h = new Harness().WithWorkflow(W, cron: null, entry: S, processor: P);

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out _));
        Assert.Empty(h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task DoesNothingAtAllWhenL2DoesNotHoldTheWorkflow()
    {
        // Reachable: a stop cleaned L2 after the announcement was published. L2 is the source of
        // truth, so the correct action is none.
        var h = new Harness();   // no workflow written

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.False(h.Store.TryGet(W, out _));
        Assert.Empty(h.Scheduler.Scheduled);
    }

    [Fact]
    public async Task TearsDownAnExistingJobBeforeSchedulingTheReplacement()
    {
        // Teardown-then-apply is what makes a redelivered announcement converge instead of accumulating
        // a second live job for the same workflow.
        var h = new Harness().WithWorkflow(W, cron: "0 * * * *", entry: S, processor: P);
        await h.Build().ActivateAsync(W, CancellationToken.None);
        var first = h.Store.TryGet(W, out var e1) ? e1.JobId : Guid.Empty;

        await h.Build().ActivateAsync(W, CancellationToken.None);

        Assert.Contains(first, h.Scheduler.Unscheduled);
        Assert.True(h.Store.TryGet(W, out var e2));
        Assert.NotEqual(first, e2.JobId);

        // Teardown strictly before apply. Harmless to get wrong today — the two job keys differ, so a
        // late DeleteJob could not hit the new job — but the convergence argument in WorkflowActivator's
        // own doc is an ordering claim, and an ordering claim needs an ordered record to rest on.
        Assert.Equal(["ScheduleAsync", "UnscheduleAsync", "ScheduleAsync"], h.Scheduler.Calls);

        // The replacement went out under the NEW job id, not the torn-down one. Assert.NotEqual above
        // says L1 moved on; this says the scheduler was told the same thing.
        Assert.Equal((W, e2.JobId, "0 * * * *"), h.Scheduler.Scheduled[1]);
    }
}
