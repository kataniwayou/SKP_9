using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Processing;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessedDataHandlerTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid M = Guid.Parse("99999999-9999-9999-9999-999999999999");

    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public IConnectionMultiplexer Redis { get; }
        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();
        public ProcessorContext Context { get; } = new();
        public RecordingLogger<ProcessedDataHandler> Log { get; } = new();

        public Harness(string? outputSchema = null)
        {
            Redis = Substitute.For<IConnectionMultiplexer>();
            Redis.GetDatabase().Returns(Db);
            Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                              Arg.Any<When>(), Arg.Any<CommandFlags>()).Returns(true);
            Db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(true);

            var outId = Guid.Parse("88888888-8888-8888-8888-888888888888");
            Context.SetIdentity(new ProcessorIdentityFound(
                P, null, outputSchema is null ? null : outId, null, "sample", "1.0.0"));
            if (outputSchema is not null)
            {
                Context.SetDefinition(outId, outputSchema);
            }
        }

        public ProcessedDataHandler Build(ProcessorLivenessOptions? options = null) => new(
            Redis, Sender, Context,
            Options.Create(options ?? new ProcessorLivenessOptions()), Log);
    }

    private static byte[] Body(ProcessedData p)
        => JsonSerializer.SerializeToUtf8Bytes(p, MessagingJson.Options);

    private static ProcessedData Branch(Guid entryId, string json = "{}") =>
        new(W, S, P)
        {
            CorrelationId = C, ExecutionId = E, MessageId = M, EntryId = entryId,
            Data = Encoding.UTF8.GetBytes(json),
        };

    [Fact]
    public async Task ReclaimsTheInputKeyFirst()
    {
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        await h.Db.Received(1).KeyDeleteAsync(L2ProjectionKeys.ExecutionData(E), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LeavesNothingToReclaimForASourceStep()
    {
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(Guid.Empty)), CancellationToken.None);

        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task WritesTheOutputUnderTheMessageIdSoAReplayRewritesIt()
    {
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E, """{"number":7}""")), CancellationToken.None);

        await h.Db.Received(1).StringSetAsync(
            L2ProjectionKeys.OutputData(M), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
            Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task WritesWithATtlSoAnOrphanedOutputExpires()
    {
        var h = new Harness();
        TimeSpan? ttl = null;

        await h.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Do<TimeSpan?>(t => ttl = t),
                                  Arg.Any<When>(), Arg.Any<CommandFlags>());
        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        Assert.NotNull(ttl);
        Assert.True(ttl!.Value > TimeSpan.Zero);
    }

    [Fact]
    public async Task ReportsCompletionCarryingTheOutputKey()
    {
        // The orchestrator relocates this key into one input key per successor, so it has to be the
        // key just written rather than the input that was reclaimed.
        var h = new Harness();
        StepCompleted? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepCompleted>(s => sent = s),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        Assert.Equal(M, sent!.EntryId);
        Assert.Equal(E, sent.ExecutionId);
    }

    [Fact]
    public async Task ReportsFailureAndWritesNothingWhenTheOutputFailsItsSchema()
    {
        // No successor will read a failed step's output, so persisting it would be garbage with a TTL.
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E, """{"number":"seven"}""")), CancellationToken.None);

        Assert.NotNull(sent);
        await h.Db.DidNotReceive().StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(),
                                                  Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ParksABranchWhoseOutputSchemaHasNotResolvedRatherThanPersistingUnvalidated()
    {
        // Same "not yet" as the pre handler's: a non-null schema id whose definition Loop B has not
        // fetched. TryValidate(null, ...) returns true, so without the guard this branch would be
        // written to the output key and reported complete with the output schema silently not applied.
        var h = new Harness();
        h.Context.SetIdentity(new ProcessorIdentityFound(
            P, null, Guid.Parse("88888888-8888-8888-8888-888888888888"), null, "sample", "1.0.0"));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None));

        await h.Db.DidNotReceive().StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(),
                                                  Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(),
                                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task CompletesABranchThatSimplyHasNoOutputSchema()
    {
        // The "not applicable" half: a null schema id means the role does not apply, so the branch
        // persists and reports complete with validation skipped, exactly as designed.
        var h = new Harness();
        StepCompleted? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepCompleted>(s => sent = s),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E, "not json at all")), CancellationToken.None);

        Assert.NotNull(sent);
        await h.Db.Received(1).StringSetAsync(L2ProjectionKeys.OutputData(M), Arg.Any<RedisValue>(),
                                              Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LetsAStoreFaultEscapeSoTheBranchIsRequeued()
    {
        var h = new Harness();
        h.Db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None));
    }

    [Fact]
    public async Task IsIdempotentAcrossAReplay()
    {
        // The delete no-ops on an already-absent key and the write rewrites the same key with the same
        // bytes, so running the handler twice leaves the state one run leaves. Counting two writes
        // would not show that — two writes of DIFFERENT bytes to the same key, or a second run that
        // skipped the reclaim, both satisfy a count. So capture what each run actually issued.
        var h = new Harness();
        var written = new List<byte[]>();
        var deleted = new List<RedisKey>();
        await h.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Do<RedisValue>(v => written.Add((byte[])v!)),
                                  Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
        await h.Db.KeyDeleteAsync(Arg.Do<RedisKey>(k => deleted.Add(k)), Arg.Any<CommandFlags>());
        var completed = new List<StepCompleted>();
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepCompleted>(completed.Add),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E, """{"number":7}""")), CancellationToken.None);
        await h.Build().HandleAsync(Body(Branch(E, """{"number":7}""")), CancellationToken.None);

        // Same key, twice.
        await h.Db.Received(2).StringSetAsync(L2ProjectionKeys.OutputData(M), Arg.Any<RedisValue>(),
                                              Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
        // Same bytes, twice: the second write is a REwrite, so it cannot leave a different value behind.
        Assert.Equal(2, written.Count);
        Assert.Equal("""{"number":7}""", Encoding.UTF8.GetString(written[0]));
        Assert.Equal(written[0], written[1]);
        // The reclaim is part of the repeated sequence, not something the first run consumed.
        Assert.Equal([L2ProjectionKeys.ExecutionData(E), L2ProjectionKeys.ExecutionData(E)], deleted);
        // And the outcome reported is the same one, naming the same output key.
        Assert.Equal(2, completed.Count);
        Assert.Equal(completed[0].EntryId, completed[1].EntryId);
        Assert.Equal(M, completed[0].EntryId);
    }

    [Fact]
    public async Task StampsOurOwnProcessorIdOnResultsEvenWhenTheBranchClaimsAnother()
    {
        // The inbound ProcessedData was produced by this processor, so its field is already ours by
        // construction — which is exactly why echoing it buys nothing and is the only way the two
        // could ever disagree. A StepCompleted attributed to another processor's id lands in their
        // lineage, and nothing downstream would notice.
        var h = new Harness();
        StepCompleted? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepCompleted>(s => sent = s),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var foreign = Branch(E) with { ProcessorId = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd") };
        await h.Build().HandleAsync(Body(foreign), CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task StampsOurOwnProcessorIdOnAFailureEvenWhenTheBranchClaimsAnother()
    {
        // The other outbound site in this handler. A StepFailed carries no key anyone later reads, so
        // a misattributed one is invisible until someone asks why a processor has failures it never ran.
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var foreign = Branch(E, """{"number":"seven"}""")
            with { ProcessorId = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd") };
        await h.Build().HandleAsync(Body(foreign), CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void RefusesATtlThatWouldMakeEveryWriteFail(int ttlSeconds)
    {
        // L2ProjectionKeys.OutputDataTtl derives Random.Shared.Next(ttl, 2 * ttl + 1), so zero gives
        // TimeSpan.Zero — which Redis rejects on EVERY write, turning every branch into a parked
        // message with no clue pointing at the config value that caused it. A negative one throws out
        // of Random.Next instead. Neither is recoverable at run time, so it has to be refused up front.
        var h = new Harness();

        Assert.Throws<ArgumentOutOfRangeException>(
            () => h.Build(new ProcessorLivenessOptions { ExecutionDataTtlSeconds = ttlSeconds }));
    }

    [Fact]
    public void AcceptsTheSmallestTtlThatActuallyWorks()
    {
        // One second is degenerate but valid: OutputDataTtl(1) yields 1s or 2s, both of which Redis
        // accepts. The guard must refuse the broken values, not police the sensible ones.
        var h = new Harness();

        Assert.NotNull(h.Build(new ProcessorLivenessOptions { ExecutionDataTtlSeconds = 1 }));
    }

    [Fact]
    public async Task LetsAFailedResultSendEscapeRatherThanAcknowledging()
    {
        var h = new Harness();
        h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<StepCompleted>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>())
                .ThrowsAsync(new IOException("socket closed"));

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None));
    }
}
