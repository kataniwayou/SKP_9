using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Orchestrator;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Orchestrator.L1;
using Orchestrator.Messaging;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// Whether the whole start and stop path converges when it is run more than once.
/// <para>
/// <b>Every message on this path can arrive twice.</b> The control message is acknowledged only after
/// its handler completes, so a failure anywhere after the write — including the announcement, which is
/// the last thing the handler does — puts the delivery back on the queue and runs the handler again.
/// The announcement that follows has the same property on the replica side. Nothing in the design
/// deduplicates either of them: what makes redelivery safe is that both handlers apply an end state
/// rather than a change, and that claim is what these tests exercise.
/// </para>
/// <para>
/// <b>They assert resulting state, not calls.</b> The store here is <see cref="InMemoryL2"/>, which
/// keeps what is written to it, so "running it twice leaves the same L2" is asked of the key space
/// rather than of a call count. Existing coverage sits either side of this: <c>FanoutPublishTests</c>
/// pins the announce-after-write ordering within one run, and <c>ApplyHandlerTests</c> pins the
/// replica's behaviour against a stubbed L2. Neither runs the path twice against a store that
/// remembers the first run.
/// </para>
/// <para>
/// <b>The one thing that is deliberately not stable is the job id.</b> Every activation mints a fresh
/// one, so a redelivered announcement leaves L1 holding the same definition under a different id, and
/// the scheduler holding one live job rather than the same job. Convergence is over the definition and
/// the job count; asserting a stable job id would be asserting the opposite of what
/// <see cref="WorkflowActivator"/> is for.
/// </para>
/// </summary>
public sealed class StartStopIdempotencyTests
{
    private static readonly Guid W  = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid S2 = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid P  = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private const string Cron = "0 0/5 * * * ?";

    /// <summary>Records what was announced instead of publishing it, and hands it back for delivery.</summary>
    private sealed class CapturingPublisher : IQueueFanoutPublisher
    {
        private readonly List<(string Type, object Body)> _published = [];

        public int Count => _published.Count;

        public Task PublishAsync<T>(string exchange, string type, T body, CancellationToken ct)
        {
            _published.Add((type, body!));
            return Task.CompletedTask;
        }

        /// <summary>Everything announced since the last call, in order.</summary>
        public IReadOnlyList<(string Type, object Body)> Drain()
        {
            var taken = _published.ToList();
            _published.Clear();
            return taken;
        }
    }

    /// <summary>
    /// The whole path over one store: the API's two control handlers write L2, move the live set and
    /// announce, and the replica's two apply handlers read the same L2 back. Both sides share one
    /// <see cref="InMemoryL2"/>, which is the point — the replica must see what the API actually wrote,
    /// not what a stub says it wrote.
    /// </summary>
    private sealed class Chain
    {
        private readonly L2WorkflowReader _reader;

        public Chain()
        {
            _reader = new L2WorkflowReader(L2.Multiplexer, NullLogger<L2WorkflowReader>.Instance);
        }

        public InMemoryL2 L2 { get; } = new();

        public CapturingPublisher Publisher { get; } = new();

        public WorkflowL1Store L1 { get; } = new();

        public RecordingWorkflowScheduler Scheduler { get; } = new();

        /// <summary>The API's start: write, join the live set, announce.</summary>
        public Task ApiStartAsync(WorkflowL1 definition) =>
            new StartOrchestrationHandler(
                    new L2ProjectionWriter(L2.Multiplexer, FakeStepRows.Everything()),
                    new L2LiveSet(L2.Multiplexer),
                    Publisher,
                    NullLogger<StartOrchestrationHandler>.Instance)
                .HandleAsync(Body(new StartOrchestration(definition)), CancellationToken.None);

        /// <summary>The API's stop: leave the live set, announce.</summary>
        public Task ApiStopAsync(Guid workflowId) =>
            new StopOrchestrationHandler(
                    new L2LiveSet(L2.Multiplexer), Publisher,
                    NullLogger<StopOrchestrationHandler>.Instance)
                .HandleAsync(Body(new StopOrchestration(workflowId)), CancellationToken.None);

        /// <summary>
        /// Delivers every announcement the API has published, in the order it published them, to one
        /// replica. The handlers are built per delivery and the state they mutate — L1 and the
        /// scheduler — is not, so a second delivery meets the first one's results.
        /// </summary>
        public async Task DeliverAsync()
        {
            var start = new ApplyStartHandler(
                new WorkflowActivator(_reader, L1, Scheduler, NullLogger<WorkflowActivator>.Instance),
                NullLogger<ApplyStartHandler>.Instance);
            var stop = new ApplyStopHandler(
                _reader, L1, Scheduler, TimeProvider.System, NullLogger<ApplyStopHandler>.Instance);

            foreach (var (type, body) in Publisher.Drain())
            {
                IQueueMessageHandler handler = type == MessageTypes.OrchestrationStarted ? start : stop;
                await handler.HandleAsync(
                    JsonSerializer.SerializeToUtf8Bytes(body, body.GetType(), MessagingJson.Options),
                    CancellationToken.None);
            }
        }
    }

    private static byte[] Body<T>(T message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, MessagingJson.Options);

    /// <summary>A workflow whose first step is its entry, with one step key per id given and the given
    /// caches. <c>params</c> must be the last parameter, so this is the overload the cacheless one
    /// below delegates to rather than an optional parameter on it.</summary>
    private static WorkflowL1 Definition(Guid[] stepIds, List<CacheL1> caches) => new(
        WorkflowId: W,
        EntryStepIds: [stepIds[0]],
        Cron: Cron,
        Steps: stepIds
            .Select(id => new StepL1(id, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: []))
            .ToList(),
        Caches: caches);

    /// <summary>A workflow whose first step is its entry, with one step key per id given.</summary>
    private static WorkflowL1 Definition(params Guid[] stepIds) => Definition(stepIds, []);

    /// <summary>
    /// A definition as text, for comparing two of them. <c>WorkflowL1</c> is a record whose members
    /// are <c>List</c>s, so its generated equality compares those by reference — two structurally
    /// identical definitions read out of L2 on separate passes are never equal by that test, which
    /// is a fact about the record and not about the path.
    /// </summary>
    private static string Shape(WorkflowL1 definition) =>
        JsonSerializer.Serialize(definition, MessagingJson.Options);

    private static WorkflowStoreProjection Store(Chain c) =>
        JsonSerializer.Deserialize<WorkflowStoreProjection>(
            c.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField)!, MessagingJson.Options)!;

    // ---- the API side: what repeated control messages leave in L2 -------------------------------

    [Fact]
    public async Task AStartAppliedTwiceLeavesTheSameProjection()
    {
        var c = new Chain();

        await c.ApiStartAsync(Definition(S1, S2));
        var afterFirst = c.L2.Snapshot();

        await c.ApiStartAsync(Definition(S1, S2));

        Assert.Equal(afterFirst, c.L2.Snapshot());
    }

    [Fact]
    public async Task ARepeatedStartLeavesAByteIdenticalStore()
    {
        // The store carries no timestamp — the root's liveness stamp went with the root — so a
        // redelivery leaves every byte where the first run put it, the store included.
        var c = new Chain();

        await c.ApiStartAsync(Definition(S1, S2));
        var afterFirst = c.L2.Snapshot();

        await c.ApiStartAsync(Definition(S1, S2));

        Assert.Equal(afterFirst, c.L2.Snapshot());
    }

    [Fact]
    public async Task ARestartThatDropsAStepDropsItFromTheStore()
    {
        // The steps live inside the store, which a start overwrites whole, so a step the new definition
        // does not name is gone from it with no clean. Its name key is deliberately kept: steps are
        // shared across workflows (StartDrivenProjectionTests.ARestartThatDropsAStepLeavesItsNameKey).
        var c = new Chain();

        await c.ApiStartAsync(Definition(S1, S2));
        Assert.Equal([S1, S2], Store(c).Steps.Select(s => s.StepId));

        await c.ApiStartAsync(Definition(S1));

        Assert.Equal([S1], Store(c).Steps.Select(s => s.StepId));
    }

    [Fact]
    public async Task AStopAppliedTwiceOnlyLeavesTheLiveSetBothTimes()
    {
        var c = new Chain();
        await c.ApiStartAsync(Definition(S1, S2));

        await c.ApiStopAsync(W);
        Assert.Empty(c.L2.Members(L2ProjectionKeys.Live()));
        Assert.NotNull(c.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));
        var afterFirst = c.L2.Snapshot();

        // The second stop removes an id that is already gone, which is a no-op. It must not throw:
        // parking a message whose work is already done would need an operator to clear it.
        await c.ApiStopAsync(W);

        Assert.Empty(c.L2.Members(L2ProjectionKeys.Live()));
        Assert.NotNull(c.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));
        Assert.Equal(afterFirst, c.L2.Snapshot());
    }

    [Fact]
    public async Task AWorkflowWithCachesConvergesOnRestartAndStopKeepsItsCacheKeys()
    {
        // Every other test in this file uses Definition's cacheless overload, so none of them ever
        // writes a cache key. This is the one that exercises a cache-bearing workflow through start,
        // restart, and stop over one store.
        var caches = new List<CacheL1>
        {
            new("sk-whitelist", new() { ["acme"] = "1", ["beta"] = "2" }),
        };
        var c = new Chain();

        await c.ApiStartAsync(Definition([S1, S2], caches));

        // The write actually happened, so the assertions below are about convergence and retention,
        // not about a write that silently produced nothing.
        Assert.True(c.L2.Has(L2ProjectionKeys.Cache(W, "sk-whitelist")));
        Assert.True(c.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme")));
        Assert.True(c.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "beta")));

        var afterFirst = c.L2.Snapshot();

        // Convergence: starting the same cache-bearing definition again must leave the same key
        // space, not a growing one.
        await c.ApiStartAsync(Definition([S1, S2], caches));

        Assert.Equal(afterFirst, c.L2.Snapshot());

        await c.ApiStopAsync(W);

        // Retention: a stop only leaves the live set. The caches stay so a restart finds them and an
        // outcome still in flight can resolve its lookups; the next start is what aligns them.
        Assert.True(c.L2.Has(L2ProjectionKeys.Cache(W, "sk-whitelist")));
        Assert.True(c.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme")));
        Assert.True(c.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "beta")));
    }

    [Fact]
    public async Task AStopForAWorkflowThatWasNeverStartedTouchesNothing()
    {
        var c = new Chain();
        await c.ApiStartAsync(Definition(S1));
        var before = c.L2.Snapshot();

        await c.ApiStopAsync(Guid.Parse("99999999-9999-9999-9999-999999999999"));

        Assert.Equal(before, c.L2.Snapshot());
    }

    [Fact]
    public async Task StartStopStartLeavesTheWorkflowInTheLiveSetExactlyOnce()
    {
        var c = new Chain();

        await c.ApiStartAsync(Definition(S1));
        await c.ApiStopAsync(W);
        await c.ApiStartAsync(Definition(S1));

        Assert.Equal([W.ToString("D")], c.L2.Members(L2ProjectionKeys.Live()));
        Assert.Equal([S1], Store(c).Steps.Select(s => s.StepId));
    }

    // ---- the whole chain: control message, announcement, replica --------------------------------

    [Fact]
    public async Task TheStartChainRunTwiceLeavesOneJobAndOneL1Entry()
    {
        // Both the control message and the announcement it produces can be redelivered. The second
        // pass must converge rather than accumulate: two live jobs for one workflow would fire the
        // entry steps twice on every tick.
        var c = new Chain();

        await c.ApiStartAsync(Definition(S1, S2));
        await c.DeliverAsync();
        Assert.True(c.L1.TryGetActive(W, out var first));

        await c.ApiStartAsync(Definition(S1, S2));
        await c.DeliverAsync();

        Assert.True(c.L1.TryGetActive(W, out var second));
        Assert.Equal(Shape(first.Definition), Shape(second.Definition));
        Assert.Equal(1, c.Scheduler.LiveJobCount);
        Assert.Equal([first.JobId], c.Scheduler.Unscheduled);
        Assert.Equal(["ScheduleAsync", "UnscheduleAsync", "ScheduleAsync"], c.Scheduler.Calls);
    }

    [Fact]
    public async Task TheReplicaMirrorsWhatTheApiWroteNotWhatTheMessageCarried()
    {
        // The announcement carries an id and nothing else, so what lands in L1 is whatever the writer
        // put in L2 — which is what makes a repeat converge on the store rather than on the message.
        var c = new Chain();

        await c.ApiStartAsync(Definition(S1, S2));
        await c.DeliverAsync();

        Assert.True(c.L1.TryGetActive(W, out var entry));
        Assert.Equal([S1, S2], entry.Definition.Steps.Select(s => s.StepId));
        Assert.Equal(Cron, entry.Definition.Cron);
        Assert.Equal([(W, entry.JobId, Cron)], c.Scheduler.Scheduled);
    }

    [Fact]
    public async Task TheStopChainRunTwiceLeavesTheReplicaInactiveAndUnschedulesOnlyTheLiveJob()
    {
        var c = new Chain();
        await c.ApiStartAsync(Definition(S1, S2));
        await c.DeliverAsync();
        Assert.True(c.L1.TryGetActive(W, out var live));

        await c.ApiStopAsync(W);
        await c.DeliverAsync();

        // The redelivery: the API removes an already-absent live-set entry and announces again, and the
        // replica finds the entry its predecessor already marked. Neither half has anything left to
        // do — and in particular the second delivery must not unschedule a second time, which is what
        // the single-element Unscheduled assertion below pins.
        await c.ApiStopAsync(W);
        await c.DeliverAsync();

        // Inactive, not absent. The entry survives the stop by design so that steps still in flight
        // resolve against it; what the stop guarantees is that nothing can dispatch from it again.
        Assert.False(c.L1.TryGetActive(W, out _));
        Assert.True(c.L1.TryGetIncludingStopped(W, out var marked));
        Assert.NotNull(marked.DeletedAt);

        Assert.Equal([live.JobId], c.Scheduler.Unscheduled);
        Assert.Equal(0, c.Scheduler.LiveJobCount);

        // The stop takes the id out of the live set and nothing else: the store outlives it, so the
        // next start aligns against it rather than rebuilding from nothing.
        Assert.Empty(c.L2.Members(L2ProjectionKeys.Live()));
        Assert.NotNull(c.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));
    }

    [Fact]
    public async Task AStopAnnouncementDeliveredBehindALaterStartDoesNotTearDownTheRestartedWorkflow()
    {
        // Spec §7.3, over the real writer rather than a stub. The API can process a stop and then a
        // start before the replica handles either, so the stop arrives when L2 already holds the
        // re-written workflow. Acting on it would halt a workflow L2 says is live until the start
        // behind it in the queue was processed.
        var c = new Chain();
        await c.ApiStartAsync(Definition(S1));
        await c.DeliverAsync();

        await c.ApiStopAsync(W);
        await c.ApiStartAsync(Definition(S1, S2));
        Assert.Equal(2, c.Publisher.Count);

        await c.DeliverAsync();

        Assert.True(c.L1.TryGetActive(W, out var entry));
        Assert.Equal([S1, S2], entry.Definition.Steps.Select(s => s.StepId));
        Assert.Equal(1, c.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task TheWholeCycleRunTwiceEndsWhereItStarted()
    {
        var c = new Chain();
        var ends = new List<string>();

        for (var i = 0; i < 2; i++)
        {
            await c.ApiStartAsync(Definition(S1, S2));
            await c.DeliverAsync();
            await c.ApiStopAsync(W);
            await c.DeliverAsync();
            ends.Add(c.L2.Snapshot());
        }

        // The end of a cycle is "store present, live empty": a stop only leaves the live set, so the
        // store and the names stay. Where it started is therefore the end of the first cycle, and the
        // second must land on exactly the same bytes.
        Assert.Equal(ends[0], ends[1]);
        Assert.Empty(c.L2.Members(L2ProjectionKeys.Live()));
        Assert.NotNull(c.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));

        // L2 holds no running workflow and nothing is scheduled, which is what "where it started" means
        // for the two things that outlive the process. L1 still holds the marked entry — it is a
        // per-replica mirror, and nothing but a restart of the workflow or of the pod returns it to
        // empty.
        Assert.False(c.L1.TryGetActive(W, out _));
        Assert.Equal(0, c.Scheduler.LiveJobCount);
        Assert.Equal(2, c.Scheduler.Scheduled.Count);
        Assert.Equal(2, c.Scheduler.Unscheduled.Count);
    }
}
