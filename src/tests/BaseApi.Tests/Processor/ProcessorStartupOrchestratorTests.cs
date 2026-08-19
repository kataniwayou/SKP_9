using System.Text.Json;
using BaseApi.Tests.Support;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using BaseProcessor.Core.Startup;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorStartupOrchestratorTests
{
    /// <summary>
    /// Answers each ask from a script, publishing straight into the slot the way a reply consumer
    /// would. A null script entry means "no answer" — the ask times out and the loop retries.
    /// </summary>
    private sealed class ScriptedSender : IQueueSender
    {
        private readonly Queue<object?> _script;
        private readonly ReplySlot<object> _slot;

        public ScriptedSender(ReplySlot<object> slot, params object?[] script)
        {
            _slot = slot;
            _script = new Queue<object?>(script);
        }

        /// <summary>Runs on every send, so a test can act at a known point in the sequence.</summary>
        public Action<int>? OnSend { get; set; }

        public List<(string Queue, string Type, string? ReplyTo)> Sent { get; } = [];

        public Task SendAsync<T>(string queue, string type, T body, CancellationToken ct, string? replyTo = null)
        {
            Sent.Add((queue, type, replyTo));
            OnSend?.Invoke(Sent.Count);
            if (_script.Count > 0 && _script.Dequeue() is { } reply)
            {
                _slot.Publish(reply);
            }

            return Task.CompletedTask;
        }
    }

    private sealed class Harness
    {
        public ReplySlot<object> Slot { get; } = new();
        public ProcessorContext Context { get; } = new();
        public LoopHeartbeat Beat { get; }
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public FakeTimeProvider Clock { get; } = new();
        public ScriptedSender Sender { get; }
        public ProcessorStartupOrchestrator Orchestrator { get; }

        /// <param name="identity">
        /// Seeded before the orchestrator exists, the way the two-stage boot seeds the container. Null
        /// builds the one shape the boot is supposed to make impossible, which is what the guard test
        /// needs.
        /// </param>
        public Harness(ProcessorIdentityFound? identity, params object?[] script)
        {
            Beat = new LoopHeartbeat(Clock);
            Sender = new ScriptedSender(Slot, script);

            if (identity is not null)
            {
                Context.SetIdentity(identity);
            }

            var redis = Substitute.For<IConnectionMultiplexer>();
            redis.GetDatabase().Returns(Db);
            var options = Options.Create(new ProcessorLivenessOptions { RequestTimeoutSeconds = 1 });
            var writer = new ProcessorLivenessWriter(
                redis, new RecordingLogger<ProcessorLivenessWriter>());

            var endpoint = Substitute.For<IReplyEndpoint>();
            endpoint.QueueName.Returns("proc-reply-pod-1");

            Orchestrator = new ProcessorStartupOrchestrator(
                Sender, endpoint, Slot, Context, writer, new InstanceId("pod-1"),
                options, Clock, Beat, new RecordingLogger<ProcessorStartupOrchestrator>());
        }

        public IReadOnlyList<ProcessorLivenessEntry> WrittenEntries() =>
            Db.ReceivedCalls()
                .Where(c => c.GetMethodInfo().Name == nameof(IDatabase.StringSetAsync))
                .Select(c => JsonSerializer.Deserialize<ProcessorLivenessEntry>(
                    c.GetArguments()[1]!.ToString()!)!)
                .ToList();
    }

    /// <summary>
    /// Drives the orchestrator to completion, advancing the fake clock so its backoff delays elapse.
    /// A FakeTimeProvider only moves when something reads it, and nothing does while Task.Delay is
    /// pending — so a retrying loop needs the clock pushed from outside.
    /// </summary>
    private static async Task RunPumpedAsync(Harness h, CancellationToken ct)
    {
        var task = h.Orchestrator.RunStartupAsync(ct);

        for (var pump = 0; !task.IsCompleted; pump++)
        {
            Assert.True(pump < 2_000, "the orchestrator did not finish");
            h.Clock.Advance(TimeSpan.FromSeconds(5));
            await Task.Delay(1, CancellationToken.None);
        }

        await task;
    }

    private static ProcessorIdentityFound Found(Guid? input = null, Guid? config = null) =>
        new(Guid.NewGuid(), input, null, config, "sample", "1.0.0");

    [Fact]
    public async Task ResolvesDefinitionsAndReachesHealthy()
    {
        var input = Guid.NewGuid();
        var h = new Harness(Found(input: input), new SchemaDefinitionFound("{\"type\":\"object\"}"));

        await h.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        Assert.True(h.Context.IsHealthy);
        Assert.Equal("{\"type\":\"object\"}", h.Context.Identity!.InputDefinition);
        Assert.Equal([ProcessorQueues.SchemaQuery], h.Sender.Sent.Select(s => s.Queue));
    }

    [Fact]
    public async Task EveryAskCarriesTheReplyAddress()
    {
        // Given a schema to resolve, so there is an ask at all: with identity pre-seeded a processor
        // with no schemas sends nothing, and the assertion would pass on an empty list.
        var h = new Harness(Found(input: Guid.NewGuid()), new SchemaDefinitionFound("{}"));

        await h.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        Assert.All(h.Sender.Sent, s => Assert.Equal("proc-reply-pod-1", s.ReplyTo));
    }

    [Fact]
    public async Task SkipsNullSchemaIdsWithoutAsking()
    {
        // A processor with no input, output or config schema asks nothing at all — a null id means
        // the role does not apply, not that a definition is missing, and identity is already in hand.
        var h = new Harness(Found());

        await h.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        Assert.Empty(h.Sender.Sent);
        Assert.True(h.Context.IsHealthy);
    }

    [Fact]
    public async Task PublishesUnhealthyBeforeResolvingAnyDefinition()
    {
        // Visible in L2 as unhealthy from the first moment — never absent, so the orchestration gate
        // fails the replica on its status rather than on a missing key. With identity pre-seeded that
        // moment is host start.
        var input = Guid.NewGuid();
        var h = new Harness(Found(input: input), new SchemaDefinitionFound("{}"));

        await h.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        var entries = h.WrittenEntries();
        Assert.NotEmpty(entries);
        Assert.Equal(LivenessStatus.Unhealthy, entries[0].Status);
        Assert.Equal(SchemaOutcome.Fail, entries[0].Summary.InputSchema);   // not yet resolved
        Assert.Equal(30, entries[0].Interval);                              // the startup anchor
    }

    [Fact]
    public async Task StartsFromASeededIdentityWithoutAsking()
    {
        // Loop A is gone. If the orchestrator still asked, a processor whose identity was already
        // resolved would send a pointless query on every boot — and worse, could disagree with it.
        var h = new Harness(Found());

        await h.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        Assert.DoesNotContain(h.Sender.Sent, s => s.Queue == ProcessorQueues.IdentityQuery);
    }

    [Fact]
    public async Task RefusesToStartWithoutASeededIdentity()
    {
        // The one way this can happen is a host built through the identity-free overload, which is a
        // wiring mistake. Failing here names it; carrying on would publish L2 writes keyed on nothing.
        var h = new Harness(identity: null);

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken));

        Assert.Contains("AddBaseProcessor", ex.Message);
    }

    [Fact]
    public async Task RetiresItsHeartbeatOnceHealthy()
    {
        // The loops are done, so the liveness check must stop expecting beats from them.
        var h = new Harness(Found());

        await h.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        Assert.True(h.Beat.IsRetired);
    }

    [Fact]
    public async Task BeatsWhileResolving()
    {
        var h = new Harness(Found(input: Guid.NewGuid()), new SchemaDefinitionFound("{}"));

        await h.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(h.Beat.Last);
    }

    [Fact]
    public async Task DoesNotReachHealthyWhenCancelledMidResolution()
    {
        // Shutdown is not completion — a half-resolved processor must never publish itself healthy.
        using var cts = new CancellationTokenSource();
        var h = new Harness(Found(input: Guid.NewGuid()));   // identity answered, schema never is
        h.Sender.OnSend = send =>
        {
            if (send == 1) cts.Cancel();   // the schema ask is now the first — identity is pre-seeded
        };

        await RunPumpedAsync(h, cts.Token);

        Assert.False(h.Context.IsHealthy);       // Loop B did not complete
        Assert.False(h.Beat.IsRetired);
    }
}
