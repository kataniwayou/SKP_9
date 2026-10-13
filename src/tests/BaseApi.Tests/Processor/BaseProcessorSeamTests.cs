using BaseApi.Tests.Support;
using System.Text;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class BaseProcessorSeamTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private sealed record TwoFieldConfig(int Number, string? Label) : ProcessorConfig;

    /// <summary>A processor whose transform is supplied per test.</summary>
    private sealed class Probe(Func<byte[], TwoFieldConfig?, Guid, Probe, Task> body)
        : BaseProcessor<TwoFieldConfig>
    {
        protected override Task ProcessAsync(
            byte[] data, TwoFieldConfig? config, Guid executionId, CancellationToken ct)
            => body(data, config, executionId, this);

        public Task Send(byte[] data, Guid executionId) => SendToPostAsync(data, executionId, CancellationToken.None);
        public Guid NextExecution() => NewExecutionId();

        /// <summary>What an author sees when it reads the dispatch's correlation id.</summary>
        public Guid Correlation => CorrelationId;
    }

    private static (Probe Processor, IQueueSender Sender) Build(
        Func<byte[], TwoFieldConfig?, Guid, Probe, Task> body)
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new Probe(body);
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P));
        return (processor, sender);
    }

    [Fact]
    public async Task DeserializesThePayloadIntoTheAuthorsConfigType()
    {
        TwoFieldConfig? seen = null;
        var (processor, _) = Build((_, config, _, _) => { seen = config; return Task.CompletedTask; });

        await processor.ExecuteAsync([], """{"number":5,"label":"Step_A"}""", Guid.Empty, CancellationToken.None);

        Assert.Equal(new TwoFieldConfig(5, "Step_A"), seen);
    }

    [Fact]
    public async Task HandsTheAuthorANullConfigWhenThePayloadIsEmpty()
    {
        // A step with no payload is a normal configuration. Deserializing "" would throw, so the guard
        // runs first and the author sees the absence rather than an exception.
        var sawNull = false;
        var (processor, _) = Build((_, config, _, _) => { sawNull = config is null; return Task.CompletedTask; });

        await processor.ExecuteAsync([], "   ", Guid.Empty, CancellationToken.None);

        Assert.True(sawNull);
    }

    [Fact]
    public async Task StampsTheDispatchIdsOntoEveryBranch()
    {
        ProcessedData? sent = null;
        var (processor, sender) = Build((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal(W, sent!.WorkflowId);
        Assert.Equal(S, sent.StepId);
        Assert.Equal(C, sent.CorrelationId);
        Assert.Equal(E, sent.ExecutionId);

        // The entry id is derived, never random: no input key here, so it is the entry-step formula.
        Assert.Equal(EntryIds.Branch(Guid.Empty, W, S, E), sent.EntryId);
    }

    [Fact]
    public async Task StampsTheProcessorIdTheDispatchWasOpenedWith()
    {
        // DispatchState holds one processor id and the seam stamps it verbatim. Where that id came
        // from is the caller's decision, and the handler tests pin it: the pre handler reads it off the
        // dispatch and passes it through, like WorkflowId and StepId.
        ProcessedData? sent = null;
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task GivesEachBranchOfAFanOutTheKeyItsExecutionIdDerives()
    {
        // The author's contract (§5.1): every output carries a distinct execution id, and the key
        // follows it. Distinct ids, distinct keys.
        var ids = new List<Guid>();
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => ids.Add(p.EntryId)),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var x1 = Guid.Parse("a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1");
        var x2 = Guid.Parse("a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2");
        var input = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var processor = new Probe(async (_, _, _, self) =>
        {
            await self.Send(Encoding.UTF8.GetBytes("{}"), x1);
            await self.Send(Encoding.UTF8.GetBytes("{}"), x2);
        });
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P, input));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal([EntryIds.Branch(input, W, S, x1), EntryIds.Branch(input, W, S, x2)], ids);
    }

    [Fact]
    public async Task TwoOutputsUnderOneExecutionIdShareOneKey()
    {
        // The other half of the contract, pinned so it stays a documented cost rather than a
        // surprise: an author that reuses one execution id for two outputs writes both to one key,
        // and the second overwrites the first.
        var ids = new List<Guid>();
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => ids.Add(p.EntryId)),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var processor = new Probe(async (_, _, _, self) =>
        {
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
        });
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Single(ids.Distinct());
    }
    [Fact]
    public async Task ReplayingADispatchRewritesTheSameBranchKey()
    {
        // INVERTED from "replaying produces fresh ids". Keys are derived from the input key and the
        // execution id now, so a replay of the same dispatch names the same keys: L2 converges and
        // the successor subtree is absorbed rather than forked.
        var input = Guid.Parse("99999999-9999-9999-9999-999999999999");

        async Task<List<Guid>> RunOnce()
        {
            var ids = new List<Guid>();
            var sender = Substitute.For<IQueueSender>();
            await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(),
                                   Arg.Do<ProcessedData>(p => ids.Add(p.EntryId)),
                                   Arg.Any<CancellationToken>(), Arg.Any<string?>());
            var processor = new Probe((_, _, x, self) => self.Send(Encoding.UTF8.GetBytes("{}"), x));
            processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P, input));
            await processor.ExecuteAsync([], "", E, CancellationToken.None);
            return ids;
        }

        Assert.Equal(await RunOnce(), await RunOnce());
    }

    [Fact]
    public async Task RefusesAnEmptyExecutionId()
    {
        // Every output sent under Guid.Empty would share one key. An author error, so it fails loudly
        // inside the dispatch and the framework reports the step Failed.
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), Guid.Empty));
        processor.BeginDispatch(TestDispatch.State(Substitute.For<IQueueSender>(), C, W, S, P));

        var thrown = await Assert.ThrowsAsync<ArgumentException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Contains("execution id", thrown.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReportsWhichBranchWasLostWhenASendFails()
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(new IOException("socket closed"));
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P));

        var thrown = await Assert.ThrowsAsync<PostSendException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Equal(E, thrown.ExecutionId);
        Assert.Equal(EntryIds.Branch(Guid.Empty, W, S, E), thrown.EntryId);
        // It must stay classifiable as transient, or the consumer parks the dispatch instead of
        // returning it and the branch is lost for good.
        Assert.IsAssignableFrom<TransientSendException>(thrown);
    }

    [Fact]
    public async Task LetsADeterministicSendFaultPropagateUnwrappedSoTheDispatchParks()
    {
        // PostSendException IS a TransientSendException, and the consumer's classifier maps every one
        // of those to Requeue. Wrapping a fault the send-fault allow-list does not recognise would
        // therefore override that classification at this one site and requeue, forever, a branch that
        // fails identically on every redelivery. The fault has to arrive raw so the message parks.
        var sender = Substitute.For<IQueueSender>();
        var deterministic = new NotSupportedException("no converter for this type");
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(deterministic);
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P));

        var thrown = await Assert.ThrowsAnyAsync<Exception>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Same(deterministic, thrown);
        Assert.IsNotAssignableFrom<TransientSendException>(thrown);
    }

    [Fact]
    public async Task LetsAnUnresolvedOutputSchemaThroughUnwrapped()
    {
        // OutputSchemaPendingException is already the requeue type; renaming it PostSendException
        // would claim a send failed when none was attempted.
        var sink = new PendingSchemaSink();
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(new DispatchState(sink, Guid.Empty, C, W, S, P));

        await Assert.ThrowsAsync<OutputSchemaPendingException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));
    }

    /// <summary>IBranchSink is internal, so NSubstitute cannot proxy it from this assembly.</summary>
    private sealed class PendingSchemaSink : IBranchSink
    {
        public Task FinishAsync(ProcessedData branch, CancellationToken ct)
            => Task.FromException(new OutputSchemaPendingException(Guid.NewGuid()));
    }

    [Fact]
    public void OpeningALineageTwiceProducesDifferentIds()
    {
        // Same replay cost as the branch ids above, on the other id an author can mint: a redelivered
        // dispatch opens a SECOND lineage rather than reopening the first. Pinned rather than left
        // implicit, because the method it tests used to promise the opposite.
        Guid RunOnce()
        {
            var processor = new Probe((_, _, _, _) => Task.CompletedTask);
            processor.BeginDispatch(TestDispatch.State(Substitute.For<IQueueSender>(), C, W, S, P));
            return processor.NextExecution();
        }

        Assert.NotEqual(RunOnce(), RunOnce());
    }

    [Fact]
    public void RefusesToOpenALineageOutsideADispatch()
    {
        // The same framework-wiring guard the send path carries. Without it this helper would be a
        // bare Guid.NewGuid() that quietly succeeds outside a dispatch and hands back a lineage id
        // belonging to nothing — which is exactly the kind of id that is impossible to trace back.
        var processor = new Probe((_, _, _, _) => Task.CompletedTask);

        Assert.Throws<InvalidOperationException>(() => processor.NextExecution());
    }

    [Fact]
    public async Task RefusesToSendOutsideADispatch()
    {
        // Calling the helper with no dispatch open is a framework wiring bug, never an author one, and
        // it must be loud rather than sending a branch stamped with default ids.
        var processor = new Probe((_, _, _, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => processor.Send(Encoding.UTF8.GetBytes("{}"), E));
    }

    [Fact]
    public async Task TheAuthorSeesTheDispatchesCorrelationId()
    {
        var seen = Guid.Empty;
        var (processor, _) = Build((_, _, _, p) => { seen = p.Correlation; return Task.CompletedTask; });

        await processor.ExecuteAsync([], "", Guid.Empty, CancellationToken.None);

        Assert.Equal(C, seen);
    }

    [Fact]
    public void ReadingTheCorrelationIdOutsideADispatchThrows()
    {
        // Current already enforces this for the send helpers; the accessor inherits it rather than
        // returning a stale id from a pooled thread's previous dispatch.
        var processor = new Probe((_, _, _, _) => Task.CompletedTask);

        Assert.Throws<InvalidOperationException>(() => processor.Correlation);
    }
}
