using System.Text.Json;
using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Orchestrator.L1;
using Orchestrator.Messaging;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The orchestrator under the start-driven layout: activation, hydration and stop all key off the
/// live set, and the store survives a stop.
/// </summary>
public sealed class LiveSetActivationTests
{
    private static readonly Guid W  = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid W2 = Guid.Parse("88888888-8888-8888-8888-888888888888");
    private static readonly Guid S  = Guid.Parse("66666666-6666-6666-6666-666666666666");
    private static readonly Guid P  = Guid.Parse("77777777-7777-7777-7777-777777777777");

    private static WorkflowL1 Def(Guid w, string? cron = "0 0/5 * * * ?", Guid? step = null) =>
        new(w, [step ?? S], cron, [new StepL1(step ?? S, 4, P, "{}", [])], []);

    private sealed class Harness
    {
        public InMemoryL2 L2 { get; } = new();
        public WorkflowL1Store Store { get; } = new();
        public RecordingWorkflowScheduler Scheduler { get; } = new();
        public FakeNameSource Names { get; } = new();

        public L2WorkflowReader Reader => new(L2.Multiplexer, NullLogger<L2WorkflowReader>.Instance);

        public WorkflowActivator Activator => new(
            Reader, Store, Scheduler, NullLogger<WorkflowActivator>.Instance,
            new EntityNameResolver(Names, NullLogger<EntityNameResolver>.Instance));

        public ApplyStopHandler Stop => new(Reader, Store, Scheduler, new FakeTimeProvider(), NullLogger<ApplyStopHandler>.Instance);
    }

    private static byte[] Body<T>(T m) => JsonSerializer.SerializeToUtf8Bytes(m, MessagingJson.Options);

    [Fact]
    public async Task HydrationSeesExactlyTheLiveSet()
    {
        var h = new Harness();
        await L2Seed.LiveAsync(h.L2, Def(W));
        await L2Seed.StoreAsync(h.L2, Def(W2));   // stored but stopped

        Assert.Equal([W], await h.Reader.ReadAllIdsAsync(CancellationToken.None));
    }

    [Fact]
    public async Task AnActivationForAWorkflowNotInTheLiveSetDoesNothing()
    {
        var h = new Harness();
        await L2Seed.StoreAsync(h.L2, Def(W));

        await h.Activator.ActivateAsync(W, CancellationToken.None);

        Assert.False(h.Store.TryGetIncludingStopped(W, out _));
    }

    [Fact]
    public async Task AStopAfterTheLiveRemovalUnschedulesEvenThoughTheStoreRemains()
    {
        var h = new Harness();
        await L2Seed.LiveAsync(h.L2, Def(W));
        await h.Activator.ActivateAsync(W, CancellationToken.None);
        await h.L2.Db.SetRemoveAsync(L2ProjectionKeys.Live(), W.ToString("D"));   // what BaseApi's stop does

        await h.Stop.HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.False(h.Store.TryGetActive(W, out _));
        Assert.True(h.Store.TryGetIncludingStopped(W, out _));   // the stopped entry stays in L1
        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));
    }

    [Fact]
    public async Task AStopIsIgnoredWhileTheWorkflowIsStillLive()
    {
        var h = new Harness();
        await L2Seed.LiveAsync(h.L2, Def(W));
        await h.Activator.ActivateAsync(W, CancellationToken.None);

        await h.Stop.HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out _));
    }

    [Fact]
    public async Task ACorruptStoreReadsAsAbsentAndDoesNotThrow()
    {
        var h = new Harness();
        await h.L2.Db.HashSetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField, "{not json");
        await h.L2.Db.SetAddAsync(L2ProjectionKeys.Live(), W.ToString("D"));

        Assert.Null(await h.Reader.ReadAsync(W, CancellationToken.None));
        await h.Activator.ActivateAsync(W, CancellationToken.None);
        Assert.False(h.Store.TryGetIncludingStopped(W, out _));
    }

    [Fact]
    public async Task ActivationPreloadsTheWorkflowItsStepsAndTheirProcessors()
    {
        var h = new Harness();
        await L2Seed.LiveAsync(h.L2, Def(W));

        await h.Activator.ActivateAsync(W, CancellationToken.None);

        Assert.Contains(new EntityRef(L2EntityKind.Workflow, W), h.Names.Requested);
        Assert.Contains(new EntityRef(L2EntityKind.Step, S), h.Names.Requested);
        Assert.Contains(new EntityRef(L2EntityKind.Processor, P), h.Names.Requested);
    }

    [Fact]
    public async Task ARestartPicksUpRenamedWorkflowAndStepNames()
    {
        // Spec §6: names are frozen only until the workflow's next start. One resolver lives for the
        // replica's lifetime, so the second activation must re-read names it already holds.
        var l2 = new InMemoryL2();
        var resolver = new EntityNameResolver(
            new RedisEntityNameSource(l2.Multiplexer), NullLogger<EntityNameResolver>.Instance);
        var activator = new WorkflowActivator(
            new L2WorkflowReader(l2.Multiplexer, NullLogger<L2WorkflowReader>.Instance),
            new WorkflowL1Store(), new RecordingWorkflowScheduler(),
            NullLogger<WorkflowActivator>.Instance, resolver);

        await L2Seed.LiveAsync(l2, Def(W));
        await l2.Db.HashSetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField, "old-wf_1.0.0-5555-555555555555");
        await l2.Db.HashSetAsync(L2ProjectionKeys.StepEntity(S), L2ProjectionKeys.NameField, "old-step_1.0.0-6666-666666666666");
        await activator.ActivateAsync(W, CancellationToken.None);
        Assert.Equal("old-wf_1.0.0-5555-555555555555", resolver.NameOrFallback(W));

        await l2.Db.HashSetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField, "new-wf_1.0.0-5555-555555555555");
        await l2.Db.HashSetAsync(L2ProjectionKeys.StepEntity(S), L2ProjectionKeys.NameField, "new-step_1.0.0-6666-666666666666");
        await activator.ActivateAsync(W, CancellationToken.None);

        Assert.Equal("new-wf_1.0.0-5555-555555555555", resolver.NameOrFallback(W));
        Assert.Equal("new-step_1.0.0-6666-666666666666", resolver.NameOrFallback(S));
    }

    [Fact]
    public async Task ARestartOverwritesTheL1EntryWithTheNewDefinition()
    {
        var h = new Harness();
        var s2 = Guid.NewGuid();
        await L2Seed.LiveAsync(h.L2, Def(W));
        await h.Activator.ActivateAsync(W, CancellationToken.None);

        await L2Seed.LiveAsync(h.L2, Def(W, step: s2));
        await h.Activator.ActivateAsync(W, CancellationToken.None);

        Assert.True(h.Store.TryGetActive(W, out var entry));
        Assert.Equal([s2], entry.Definition.EntryStepIds);
    }
}
