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
    }

    private static (Probe Processor, IQueueSender Sender) Build(
        Func<byte[], TwoFieldConfig?, Guid, Probe, Task> body)
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new Probe(body);
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));
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
        Assert.Equal(E, sent.EntryId);
    }

    [Fact]
    public async Task StampsTheProcessorIdTheDispatchWasOpenedWith()
    {
        // Note what this does NOT prove: DispatchState holds one processor id, so from in here the
        // seam cannot tell "our own identity" from "whatever the inbound message claimed". Which of
        // those the id came from is decided by the caller that opens the dispatch — see the handler
        // task, where a test pins that a dispatch carrying a foreign processor id still produces a
        // branch stamped with ours.
        ProcessedData? sent = null;
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task GivesEachBranchOfAFanOutItsOwnMessageId()
    {
        var ids = new List<Guid>();
        var sender = Substitute.For<IQueueSender>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => ids.Add(p.MessageId)),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var processor = new Probe(async (_, _, _, self) =>
        {
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
            await self.Send(Encoding.UTF8.GetBytes("{}"), E);
        });
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal(3, ids.Distinct().Count());
    }

    [Fact]
    public async Task ReplayingADispatchProducesTheSameBranchIds()
    {
        // The property the whole redelivery model rests on: a second run of the same dispatch writes
        // the keys the first run wrote.
        async Task<List<Guid>> RunOnce()
        {
            var ids = new List<Guid>();
            var sender = Substitute.For<IQueueSender>();
            await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(),
                                   Arg.Do<ProcessedData>(p => ids.Add(p.MessageId)),
                                   Arg.Any<CancellationToken>(), Arg.Any<string?>());
            var processor = new Probe(async (_, _, _, self) =>
            {
                await self.Send(Encoding.UTF8.GetBytes("{}"), E);
                await self.Send(Encoding.UTF8.GetBytes("{}"), E);
            });
            processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));
            await processor.ExecuteAsync([], "", E, CancellationToken.None);
            return ids;
        }

        Assert.Equal(await RunOnce(), await RunOnce());
    }

    [Fact]
    public async Task SendsToTheProcessorsOwnQueueUnderTheProcessedDataType()
    {
        var (processor, sender) = Build((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));

        await processor.ExecuteAsync([], "", E, CancellationToken.None);

        await sender.Received(1).SendAsync(
            ProcessorQueues.Work(P), MessageTypes.ProcessedData, Arg.Any<ProcessedData>(),
            Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task ReportsWhichBranchWasLostWhenASendFails()
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(new IOException("socket closed"));
        var processor = new Probe((_, _, _, self) => self.Send(Encoding.UTF8.GetBytes("{}"), E));
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));

        var thrown = await Assert.ThrowsAsync<PostSendException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Equal(E, thrown.ExecutionId);
        Assert.NotEqual(Guid.Empty, thrown.MessageId);
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
        processor.BeginDispatch(new DispatchState(sender, W, S, P, C, E));

        var thrown = await Assert.ThrowsAnyAsync<Exception>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Same(deterministic, thrown);
        Assert.IsNotAssignableFrom<TransientSendException>(thrown);
    }

    [Fact]
    public async Task DerivesAnExecutionIdThatIsStableAcrossAReplay()
    {
        Guid RunOnce()
        {
            var processor = new Probe((_, _, _, _) => Task.CompletedTask);
            processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), W, S, P, C, Guid.Empty));
            return processor.NextExecution();
        }

        Assert.Equal(RunOnce(), RunOnce());
        await Task.CompletedTask;
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
}
