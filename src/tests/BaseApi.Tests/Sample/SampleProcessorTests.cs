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

    /// <summary>
    /// Every branch this dispatch sent, in order. A list rather than a single captured value because
    /// the entry step now sends two, and an <c>Arg.Do</c> that overwrites one variable would silently
    /// report only the second — which is exactly the failure these facts exist to catch.
    /// </summary>
    private static async Task<List<ProcessedData>> SendsOf(
        IQueueSender sender, SampleProcessor processor,
        byte[] data, string config, Guid executionId)
    {
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(data, config, executionId, CancellationToken.None);
        return sends;
    }

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
    public async Task TheEntryStepOpensTwoLineagesSeededOneHundredApart()
    {
        // A source step: no upstream number to add to, so the author produces the origins itself --
        // two of them, because one lineage cannot demonstrate that two do not collide. Each gets its
        // own contribution added like every other step.
        var (processor, sender) = Build(Guid.Empty);

        var sends = await SendsOf(sender, processor, [], """{"Number":7}""", Guid.Empty);

        Assert.Equal([107, 207], sends.Select(NumberIn).ToArray());
    }

    [Fact]
    public async Task TheTwoEntryLineagesCarryDifferentExecutionIds()
    {
        // The point of the pair. Two sends under ONE id would be a single lineage forking, and a
        // collision between them would be invisible because there would be nothing to collide.
        var (processor, sender) = Build(Guid.Empty);

        var sends = await SendsOf(sender, processor, [], """{"Number":1}""", Guid.Empty);

        Assert.Equal(2, sends.Count);
        Assert.All(sends, s => Assert.NotEqual(Guid.Empty, s.ExecutionId));
        Assert.NotEqual(sends[0].ExecutionId, sends[1].ExecutionId);
    }

    [Fact]
    public async Task ADownstreamStepSendsOneBranchOnTheLineageItWasHanded()
    {
        // Only the entry step fans out. A downstream step that also doubled would multiply the run
        // 2^depth and the two lineages could no longer be told apart at the terminal.
        var (processor, sender) = Build(E);

        var sends = await SendsOf(sender, processor, Encoding.UTF8.GetBytes("""{"number":40}"""),
                                  """{"Number":2}""", E);

        Assert.Equal(42, NumberIn(Assert.Single(sends)));
        Assert.Equal(E, sends[0].ExecutionId);
    }

    [Fact]
    public async Task DoesNotSeedADownstreamStepThatWasSentNothing()
    {
        // Empty data downstream is a predecessor that sent an empty branch, not an entry step. Keying
        // the seed off data.Length would restart the count here and a lost prefix would read as a
        // complete run.
        var (processor, sender) = Build(E);
        ProcessedData? sent = null;
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync([], """{"Number":7}""", E, CancellationToken.None);

        Assert.Equal(7, NumberIn(sent!));
    }

    [Fact]
    public async Task BothLineagesReachTheTerminalWithoutCollidingAtOneHundredAndSevenAndTwoHundredAndSeven()
    {
        // The whole point, in one fact. With every assignment carrying number 1 the value is a count
        // of the hops travelled, so the terminal step of the seeded graph's seven-step path -- A, B,
        // C, one of D, one of E, one of F, G -- reports 107 on the lineage the entry step seeded 100
        // and 207 on the one it seeded 200.
        //
        // Both lineages are driven through the SAME seven steps here, and each carries its own data
        // and its own execution id the whole way. Two distinct terminal values is the assertion that
        // matters: a shared key, or a read that crossed lineages, collapses them to one value twice
        // over. The live scenarios read exactly this off Elasticsearch; this pins the arithmetic and
        // the separation without a cluster.
        var path = new[] { "Step_A", "Step_B", "Step_C", "Step_D1", "Step_E1", "Step_F1", "Step_G" };

        // Step_A: the one step that fans out, and the only place the two lineages are born.
        var (entry, entrySender) = Build(Guid.Empty);
        var opened = await SendsOf(entrySender, entry, [], $$"""{"Number":1,"Label":"{{path[0]}}"}""",
                                   Guid.Empty);

        Assert.Equal(2, opened.Count);
        Assert.NotEqual(opened[0].ExecutionId, opened[1].ExecutionId);

        var terminals = new List<int>();
        foreach (var branch in opened)
        {
            var carried = branch.Data;
            var executionId = branch.ExecutionId;

            foreach (var label in path.Skip(1))
            {
                var (processor, sender) = Build(executionId);
                var sends = await SendsOf(sender, processor, carried,
                                          $$"""{"Number":1,"Label":"{{label}}"}""", executionId);

                // Downstream never forks: one branch in, one branch out, same lineage.
                var only = Assert.Single(sends);
                Assert.Equal(executionId, only.ExecutionId);
                carried = only.Data;
            }

            terminals.Add(JsonDocument.Parse(carried).RootElement.GetProperty("number").GetInt32());
        }

        Assert.Equal([107, 207], terminals);
    }

    [Fact]
    public async Task WritesTheProcessedValueAndLabelToTheRunsTrace()
    {
        // The traversal record: one line per step naming the label and the value it produced, so a
        // run's climb from 101 to 107 is readable by joining on the correlation id the framework's
        // open scope puts on this line.
        var (processor, _) = Build(E);

        await processor.ExecuteAsync(Encoding.UTF8.GetBytes("""{"number":40}"""),
                                     """{"Number":2,"Label":"Step_B"}""", E, CancellationToken.None);

        Assert.Contains(Log.Records, r => r.Message.Contains("step Step_B produced 42", StringComparison.Ordinal));
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
