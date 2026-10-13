using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class BranchFinisherTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid X = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid E = Guid.Parse("66666666-6666-6666-6666-666666666666");
    private static readonly Guid OutSchema = Guid.Parse("88888888-8888-8888-8888-888888888888");

    private const string NumberSchema =
        """{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""";

    private sealed class Harness
    {
        public InMemoryL2 L2 { get; } = new();
        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();
        public ProcessorContext Context { get; } = new();
        public RecordingLogger<BranchFinisher> Log { get; } = new();
        public List<StepOutcome> Outcomes { get; } = [];

        /// <summary>Whether data:{E} existed at the moment each outcome was sent.</summary>
        public List<bool> KeyPresentAtSend { get; } = [];

        public Harness(string? outputSchema = null)
        {
            Context.SetIdentity(new ProcessorIdentityFound(
                P, null, outputSchema is null ? null : OutSchema, null, "sample", "1.0.0"));
            if (outputSchema is not null)
            {
                Context.SetDefinition(OutSchema, outputSchema);
            }

            Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o =>
                  {
                      Outcomes.Add(o);
                      KeyPresentAtSend.Add(L2.Has(L2ProjectionKeys.ExecutionData(o.EntryId)));
                  }),
                  Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .Returns(Task.CompletedTask);
        }

        public BranchFinisher Build() => new(L2.Multiplexer, Sender, Context, Log);
    }

    private static ProcessedData Branch(string json) =>
        new(C, X, W, S, P, E, Encoding.UTF8.GetBytes(json));

    [Fact]
    public async Task WritesTheBytesUnderTheBranchKeyThenReportsCompleted()
    {
        var h = new Harness();

        await h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None);

        Assert.Equal("""{"number":7}""", h.L2.Value(L2ProjectionKeys.ExecutionData(E)));
        var outcome = Assert.Single(h.Outcomes);
        Assert.Equal(StepResult.Completed, outcome.Result);
        Assert.Equal(E, outcome.EntryId);
        Assert.Equal(X, outcome.ExecutionId);

        // Write, then report: the orchestrator reads the key the outcome names.
        Assert.True(Assert.Single(h.KeyPresentAtSend));
        await h.Sender.Received(1).SendAsync(OrchestratorQueues.Result, MessageTypes.StepOutcome,
            Arg.Any<StepOutcome>(), Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task ANoDataBranchWritesAnEmptyValueUnderItsOwnKey()
    {
        // §4: every key is real; empty means no data. The key buys the branch a unique successor key
        // and a redelivery token, which Guid.Empty could not.
        var h = new Harness(NumberSchema);

        await h.Build().FinishAsync(Branch(""), CancellationToken.None);

        Assert.Equal("", h.L2.Value(L2ProjectionKeys.ExecutionData(E)));
        var outcome = Assert.Single(h.Outcomes);
        Assert.Equal(StepResult.Completed, outcome.Result);
        Assert.Equal(E, outcome.EntryId);
    }

    [Fact]
    public async Task AnOutputThatFailsItsSchemaWritesAnEmptyKeyAndReportsFailedUnderItsOwnKey()
    {
        // Naming the branch's own key gives every failed branch its own successor key. Reporting
        // Guid.Empty, as the queue hop did, made every schema-failed branch of one fire share one
        // recorder key — all but one failure record lost.
        var h = new Harness(NumberSchema);

        await h.Build().FinishAsync(Branch("""{"number":"seven"}"""), CancellationToken.None);

        Assert.Equal("", h.L2.Value(L2ProjectionKeys.ExecutionData(E)));
        var outcome = Assert.Single(h.Outcomes);
        Assert.Equal(StepResult.Failed, outcome.Result);
        Assert.Equal(E, outcome.EntryId);

        var line = Assert.Single(h.Log.Records, r => r.Message.Contains("failed its schema", StringComparison.Ordinal));
        Assert.Contains(OutSchema.ToString("D"), line.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RequeuesWhileTheOutputSchemaHasNotResolved()
    {
        // A non-null schema id with a null definition is "not yet". Validating against null passes by
        // contract, so the branch would go out unvalidated. Requeue: it resolves in seconds.
        var h = new Harness();
        h.Context.SetIdentity(new ProcessorIdentityFound(P, null, OutSchema, null, "sample", "1.0.0"));

        var thrown = await Assert.ThrowsAsync<OutputSchemaPendingException>(
            () => h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None));

        Assert.IsAssignableFrom<TransientSendException>(thrown);
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(E)));
        Assert.Empty(h.Outcomes);
    }

    [Fact]
    public async Task AStoreFaultLeavesRawSoTheGateCanTrip()
    {
        // Wrapped in a send exception, L2FaultClassifier would never see it and the L2 gate would
        // never close. And nothing is reported for a key that was never written.
        var h = new Harness();
        h.L2.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                               Arg.Any<When>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None));

        Assert.Empty(h.Outcomes);
    }

    [Fact]
    public async Task ASendFaultLeavesAsATransientSendException()
    {
        var h = new Harness();
        h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<StepOutcome>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>())
            .ThrowsAsync(new IOException("socket closed"));

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None));

        // The key was written first, so the replay rewrites the same key: converges.
        Assert.True(h.L2.Has(L2ProjectionKeys.ExecutionData(E)));
    }

    [Fact]
    public async Task ScopesTheBranchUnderItsOwnIds()
    {
        var h = new Harness();

        await h.Build().FinishAsync(Branch("""{"number":7}"""), CancellationToken.None);

        Assert.Contains(h.Log.Scopes,
            s => s.TryGetValue(ExecutionLogScope.EntryId, out var v) && Equals(v, E.ToString("D")));
    }
}
