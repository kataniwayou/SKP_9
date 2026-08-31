using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Processing;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
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

            var outId = Guid.Parse("88888888-8888-8888-8888-888888888888");
            Context.SetIdentity(new ProcessorIdentityFound(
                P, null, outputSchema is null ? null : outId, null, "sample", "1.0.0"));
            if (outputSchema is not null)
            {
                Context.SetDefinition(outId, outputSchema);
            }
        }

        public ProcessedDataHandler Build() => new(Redis, Sender, Context, Log);
    }

    private static byte[] Body(ProcessedData p)
        => JsonSerializer.SerializeToUtf8Bytes(p, MessagingJson.Options);

    // The parameter is now the key this branch WRITES — it used to be the source key alongside a
    // separate MessageId, and the two collapsed into one field. Callers that passed the source entry
    // here are passing the written key now, which is the same value the outcome reports.
    private static ProcessedData Branch(Guid entryId, string json = "{}") =>
        new(C, E, W, S, P, entryId, Encoding.UTF8.GetBytes(json));

    [Fact]
    public async Task RefusesABranchStampedWithAnotherProcessorsId()
    {
        // WR-02, ported back from the reference. Everything this handler does acts on the ids in the
        // body: it writes L2[EntryId] from them and reports a StepOutcome under them. The post queue
        // is addressable on a shared broker and handlers resolve by message type across the whole
        // container, so a message carrying someone else's ProcessorId would write into another
        // lineage's key space and forge that step's outcome. Nothing enforced that until now.
        var h = new Harness();
        var foreign = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd");

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Build().HandleAsync(
                Body(Branch(E) with { ProcessorId = foreign }), CancellationToken.None));

        // Deterministic, so the consumer parks it on first delivery rather than requeueing forever.
        Assert.Contains(foreign.ToString("D"), ex.Message, StringComparison.Ordinal);

        // AND the refusal is total: nothing written, nothing reported. Asserting the throw alone
        // would pass even if the guard sat after the write.
        await h.Db.DidNotReceive().StringSetAsync(
            Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
            Arg.Any<When>(), Arg.Any<CommandFlags>());
        await h.Sender.DidNotReceive().SendTransientAsync(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<StepOutcome>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ReclaimsNothingAtAll()
    {
        // The pre handler owns the reclaim now: it deletes the input once its author's transform
        // returns, which is the only point at which every branch is known to have been sent. A delete
        // here would race the pre hop of a sibling branch's successor.
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task WritesTheOutputUnderTheBranchsEntryIdSoAReplayRewritesIt()
    {
        // The message id is derived, so a redelivered branch lands on this same key and rewrites the
        // same bytes rather than creating a second blob.
        var h = new Harness();

        await h.Build().HandleAsync(Body(Branch(E, """{"number":7}""")), CancellationToken.None);

        await h.Db.Received(1).StringSetAsync(
            L2ProjectionKeys.ExecutionData(E), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
            Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task WritesWithNoExpirySoNothingVanishesBeforeItsSuccessorRuns()
    {
        // This blob IS the successor's input — data:{messageId} is read back as data:{entryId}. An
        // expiry here would delete a workflow's input out from under it if the next step were slow to
        // be dispatched. Reclaim is explicit: the successor's pre hop deletes it, or the orchestrator
        // does after a failed step.
        var h = new Harness();
        TimeSpan? ttl = TimeSpan.MaxValue;
        await h.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Do<TimeSpan?>(t => ttl = t),
                                  Arg.Any<When>(), Arg.Any<CommandFlags>());

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        Assert.Null(ttl);
    }

    [Fact]
    public async Task ReportsCompletionCarryingTheOutputKey()
    {
        // The successor reads this key straight through as its input, so it has to be the
        // key just written rather than the input that was reclaimed.
        var h = new Harness();
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        // The branch's own EntryId, handed straight through: one blob under one key, so the id the
        // handler wrote is the id the successor reads. There is no second minted id any more.
        Assert.Equal(E, sent!.EntryId);
        Assert.Equal(StepResult.Completed, sent.Result);
    }

    [Fact]
    public async Task ReportsFailureAndWritesNothingWhenTheOutputFailsItsSchema()
    {
        // No successor will read a failed step's output, so persisting it would be garbage with a TTL.
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E, """{"number":"seven"}""")), CancellationToken.None);

        Assert.Equal(StepResult.Failed, sent!.Result);

        // Guid.Empty, not the branch's key: the write never ran, so that key does not exist, and the
        // step's own input was already reclaimed by the pre handler when the author returned. There is
        // genuinely nothing here for the orchestrator to reclaim, and naming a key that was never
        // written would send it after one.
        Assert.Equal(Guid.Empty, sent.EntryId);

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
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E, "not json at all")), CancellationToken.None);

        Assert.NotNull(sent);
        await h.Db.Received(1).StringSetAsync(L2ProjectionKeys.ExecutionData(E), Arg.Any<RedisValue>(),
                                              Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LetsAStoreFaultEscapeSoTheBranchIsRequeued()
    {
        // The reclaim moved to the pre handler, so the write is this handler's only remaining store
        // call — and a fault on it must still propagate rather than being swallowed.
        var h = new Harness();
        h.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                            Arg.Any<When>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None));
    }

    [Fact]
    public async Task IsIdempotentAcrossAReplay()
    {
        // The write rewrites the same key with the same bytes, so running the handler twice leaves the
        // state one run leaves. Counting two writes would not show that — two writes of DIFFERENT bytes
        // to the same key would also satisfy a count. So capture what each run actually issued.
        var h = new Harness();
        var written = new List<byte[]>();
        await h.Db.StringSetAsync(Arg.Any<RedisKey>(), Arg.Do<RedisValue>(v => written.Add((byte[])v!)),
                                  Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
        var completed = new List<StepOutcome>();
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(completed.Add),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E, """{"number":7}""")), CancellationToken.None);
        await h.Build().HandleAsync(Body(Branch(E, """{"number":7}""")), CancellationToken.None);

        // Same key, twice.
        await h.Db.Received(2).StringSetAsync(L2ProjectionKeys.ExecutionData(E), Arg.Any<RedisValue>(),
                                              Arg.Any<TimeSpan?>(), Arg.Any<When>(), Arg.Any<CommandFlags>());
        // Same bytes, twice: the second write is a REwrite, so it cannot leave a different value behind.
        Assert.Equal(2, written.Count);
        Assert.Equal("""{"number":7}""", Encoding.UTF8.GetString(written[0]));
        Assert.Equal(written[0], written[1]);
        // And the outcome reported is the same one, naming the same output key.
        Assert.Equal(2, completed.Count);
        Assert.Equal(completed[0].EntryId, completed[1].EntryId);
        Assert.Equal(E, completed[0].EntryId);
    }

    [Fact]
    public async Task CarriesTheBranchsProcessorIdOntoTheOutcome()
    {
        // ProcessorId rides the body onto the outcome rather than being re-resolved from identity.
        // This USED to be asserted with a foreign id, on the reasoning that the field is a routing and
        // tracing id rather than a claim to verify. It is verified now — see
        // RefusesABranchStampedWithAnotherProcessorsId — so the case this pins is the real one: the
        // id that arrives is the id reported, for a branch that legitimately belongs to us.
        var h = new Harness();
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task CarriesTheBranchsProcessorIdOntoAFailedOutcome()
    {
        // The other outbound site in this handler, pinned separately because it is the path that skips
        // the write — so nothing else on it would notice which id was used.
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        StepOutcome? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(o => sent = o),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await h.Build().HandleAsync(
            Body(Branch(E, """{"number":"seven"}""")), CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task LetsAFailedResultSendEscapeRatherThanAcknowledging()
    {
        var h = new Harness();
        h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<StepOutcome>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>())
                .ThrowsAsync(new IOException("socket closed"));

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Build().HandleAsync(Body(Branch(E)), CancellationToken.None));
    }
}
