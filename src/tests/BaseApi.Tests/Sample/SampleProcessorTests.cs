using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Processing;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.Sample;
using Xunit;

namespace BaseApi.Tests.Sample;

public sealed class SampleProcessorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    /// <summary>
    /// The author's logger. Recorded rather than substituted so a test can assert on what an author
    /// actually writes — the sample's one log line is part of its worked example, not incidental.
    /// </summary>
    private static readonly RecordingLogger<SampleProcessor> Log = new();

    private static (SampleProcessor Processor, IQueueSender Sender) Build(Guid entryId)
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new SampleProcessor(Log);
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender);
    }

    private static int NumberIn(ProcessedData p)
        => JsonDocument.Parse(p.Data).RootElement.GetProperty("number").GetInt32();

    [Fact]
    public async Task AddsItsConfiguredNumberToTheIncomingOne()
    {
        var (processor, sender) = Build(E);
        ProcessedData? sent = null;
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(Encoding.UTF8.GetBytes("""{"number":40}"""),
                                     """{"Number":2,"Label":"Step_A"}""", E, CancellationToken.None);

        Assert.Equal(42, NumberIn(sent!));
    }

    [Fact]
    public async Task SeedsItsOwnValueWhenThereIsNoInput()
    {
        // A source step: no upstream data, so the author produces the whole value.
        var (processor, sender) = Build(Guid.Empty);
        ProcessedData? sent = null;
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync([], """{"Number":7}""", Guid.Empty, CancellationToken.None);

        Assert.Equal(7, NumberIn(sent!));
    }

    [Fact]
    public async Task ToleratesAnAbsentConfig()
    {
        var (processor, sender) = Build(E);
        ProcessedData? sent = null;
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(Encoding.UTF8.GetBytes("""{"number":5}"""), "", E, CancellationToken.None);

        Assert.Equal(5, NumberIn(sent!));
    }

    [Fact]
    public async Task OpensANewLineageOnAnEntryStepAndReusesItDownstream()
    {
        var (entry, entrySender) = Build(Guid.Empty);
        ProcessedData? fromEntry = null;
        await entrySender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => fromEntry = p),
                                    Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await entry.ExecuteAsync([], "", Guid.Empty, CancellationToken.None);

        var (down, downSender) = Build(E);
        ProcessedData? fromDown = null;
        await downSender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => fromDown = p),
                                   Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await down.ExecuteAsync(Encoding.UTF8.GetBytes("""{"number":1}"""), "", E, CancellationToken.None);

        Assert.NotEqual(Guid.Empty, fromEntry!.ExecutionId);
        Assert.Equal(E, fromDown!.ExecutionId);
    }

    [Fact]
    public async Task WritesItsConfigToTheRunsTrace()
    {
        // The sample's one author-written record, pinned because it is part of the worked example:
        // an author logs through a plain injected ILogger and the framework's open scope carries the
        // run's ids onto the line for free. The template names the config and never the data.
        var (processor, _) = Build(E);

        await processor.ExecuteAsync(Encoding.UTF8.GetBytes("""{"number":40}"""),
                                     """{"Number":2,"Label":"Step_A"}""", E, CancellationToken.None);

        Assert.Contains(Log.Records, r => r.Message.Contains("label Step_A", StringComparison.Ordinal)
                                          && r.Message.Contains("number 2", StringComparison.Ordinal));
    }
}
