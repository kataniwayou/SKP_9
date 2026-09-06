using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.PathImporter;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class PathImporterLoopTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static string Payload(int messageCount) =>
        $$"""
        {"brokerList":"kafka-1:9092","topic":"file-paths","consumerGroup":"path-importer",
         "messageCount":{{messageCount}},"idleTimeoutSeconds":1}
        """;

    private static (PathImporterProcessor Processor, IQueueSender Sender, RecordingLogger<PathImporterProcessor> Log)
        Build(FakePathConsumerFactory factory)
    {
        var log = new RecordingLogger<PathImporterProcessor>();
        var sender = Substitute.For<IQueueSender>();
        var processor = new PathImporterProcessor(factory, log);
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender, log);
    }

    private static async Task<List<ProcessedData>> Run(
        PathImporterProcessor processor, IQueueSender sender, int messageCount)
    {
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        // Guid.Empty: a source step. PathImporter mints per path regardless, and a later fact pins
        // that it does so even when handed a non-empty id.
        await processor.ExecuteAsync([], Payload(messageCount), Guid.Empty, CancellationToken.None);
        return sends;
    }

    private static string PathIn(ProcessedData p)
        => JsonDocument.Parse(p.Data).RootElement.GetProperty("path").GetString()!;

    private static string Summary(RecordingLogger<PathImporterProcessor> log)
        => log.Records.Single(r => r.Message.Contains("stopped because")).Message;

    // ---- Terminals -------------------------------------------------------------------------

    [Fact]
    public async Task ConsumesEveryPathItWasAskedForAndReportsCompleted()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt", "/mnt/c.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 3);

        Assert.Equal(["/mnt/a.txt", "/mnt/b.txt", "/mnt/c.txt"], sends.Select(PathIn));
        Assert.Contains("consumed 3/3 paths; stopped because Completed", Summary(log));
    }

    /// <summary>
    /// Twelve of a hundred because the topic held twelve. The reason on the line is the only thing
    /// that separates this from the Faulted case below, which reports an identical count.
    /// </summary>
    [Fact]
    public async Task StopsAtDrainedWhenTheTopicRunsOutBeforeTheCount()
    {
        var paths = Enumerable.Range(0, 12).Select(i => $"/mnt/{i}.txt").ToArray();
        var consumer = new FakePathConsumer().WithPaths(paths);
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 100);

        Assert.Equal(12, sends.Count);
        Assert.Contains("consumed 12/100 paths; stopped because Drained", Summary(log));
    }

    /// <summary>
    /// Twelve of a hundred because the thirteenth consume threw. Same count as Drained, different
    /// cause, and the whole reason the reason is on the line.
    /// </summary>
    [Fact]
    public async Task StopsAtFaultedWhenATransientConsumeThrows()
    {
        var paths = Enumerable.Range(0, 20).Select(i => $"/mnt/{i}.txt").ToArray();
        var consumer = new FakePathConsumer { ConsumeThrowsOnCall = 13 }.WithPaths(paths);
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 100);

        Assert.Equal(12, sends.Count);
        Assert.Equal(12, consumer.Committed.Count);
        Assert.Contains("consumed 12/100 paths; stopped because Faulted", Summary(log));
    }

    /// <summary>
    /// The case that would otherwise fire on every pod's first dispatch: a consumer that has not
    /// been assigned a partition yet polls empty, and an empty poll looks exactly like an empty
    /// topic. It must not be reported as one.
    /// </summary>
    [Fact]
    public async Task DoesNotCallAnUnassignedConsumerDrained()
    {
        var consumer = new FakePathConsumer { Assigned = false }.WithPaths("/mnt/a.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 100);

        Assert.Empty(sends);
        Assert.DoesNotContain("Drained", Summary(log));
        Assert.Contains("consumed 0/100 paths; stopped because Faulted", Summary(log));
    }

    /// <summary>
    /// Spec §8's deterministic allow-list applies to the wait exactly as it does to Consume, Commit
    /// and the send — an unknown-topic fault surfacing on the first read after Subscribe (§8's own
    /// example) must fail the step rather than escape unclassified.
    /// </summary>
    [Fact]
    public async Task FailsTheStepOnADeterministicAssignmentFault()
    {
        var consumer = new FakePathConsumer
        {
            AssignmentThrows = true,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.UnknownTopicOrPart),
        }.WithPaths("/mnt/a.txt");
        var (processor, _, _) = Build(new FakePathConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));
    }

    /// <summary>
    /// A transient fault waiting for assignment must reach the same Faulted terminal a transient
    /// Consume fault does — nothing consumed, the consumer evicted, no exception reaching the
    /// framework.
    /// </summary>
    [Fact]
    public async Task StopsAtFaultedWhenAssignmentFaultsTransiently()
    {
        var consumer = new FakePathConsumer { AssignmentThrows = true }.WithPaths("/mnt/a.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 10);

        Assert.Empty(sends);
        Assert.Contains("consumed 0/10 paths; stopped because Faulted", Summary(log));
    }

    // ---- Ordering and identity -------------------------------------------------------------

    /// <summary>
    /// Commit only if the send succeeded. A send that throws must leave the offset where it is, so
    /// the next dispatch re-reads that path instead of losing it.
    /// </summary>
    [Fact]
    public async Task CommitsNothingForAPathWhoseSendFailed()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt");
        var (processor, sender, _) = Build(new FakePathConsumerFactory(consumer));

        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .Returns(_ => throw new TransientSendException("broker gone", new InvalidOperationException()));

        await Assert.ThrowsAsync<PostSendException>(() =>
            processor.ExecuteAsync([], Payload(2), Guid.Empty, CancellationToken.None));

        Assert.Empty(consumer.Committed);
    }

    /// <summary>
    /// Per record, not per batch. A batch commit would re-send every path of a dispatch redelivered
    /// halfway, because a source step has no input key to guard the replay.
    /// </summary>
    [Fact]
    public async Task CommitsEachPathAsItGoesRatherThanOnceAtTheEnd()
    {
        var consumer = new FakePathConsumer { CommitThrowsOnCall = 2 }.WithPaths("/mnt/a.txt", "/mnt/b.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        await Run(processor, sender, messageCount: 10);

        Assert.Equal(["/mnt/a.txt"], consumer.Committed);
        Assert.Contains("consumed 1/10 paths; stopped because Faulted", Summary(log));
    }

    [Fact]
    public async Task OpensADistinctLineageForEveryPath()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt", "/mnt/c.txt");
        var (processor, sender, _) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 3);

        Assert.Equal(3, sends.Select(s => s.ExecutionId).Distinct().Count());
        Assert.DoesNotContain(Guid.Empty, sends.Select(s => s.ExecutionId));
    }

    /// <summary>
    /// Every path is the origin of its own lineage; there is no case where this processor continues
    /// one it was handed. A non-empty inbound id must not be reused for the branches.
    /// </summary>
    [Fact]
    public async Task MintsPerPathEvenWhenHandedAnExecutionId()
    {
        var inbound = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt");
        var (processor, sender, _) = Build(new FakePathConsumerFactory(consumer));

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await processor.ExecuteAsync([], Payload(2), inbound, CancellationToken.None);

        Assert.DoesNotContain(inbound, sends.Select(s => s.ExecutionId));
        Assert.Equal(2, sends.Select(s => s.ExecutionId).Distinct().Count());
    }

    // ---- The Elasticsearch coupling --------------------------------------------------------

    /// <summary>
    /// The record this whole processor exists to produce: the path, and the execution id it opened,
    /// on one line. The correlation id rides the dispatch scope and is not named in the template.
    /// The id must be the SAME one the branch carries, or the coupling leads nowhere.
    /// </summary>
    [Fact]
    public async Task LogsEachPathAgainstTheExecutionIdItsBranchCarries()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/reports/q3.csv");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 1);

        var line = log.Records.Single(r => r.Message.Contains("imported path")).Message;
        Assert.Contains("/mnt/reports/q3.csv", line);
        Assert.Contains(sends.Single().ExecutionId.ToString(), line);
    }

    // ---- Failure ---------------------------------------------------------------------------

    [Fact]
    public async Task FailsTheStepWhenTheStepPayloadIsMissing()
    {
        var (processor, _, _) = Build(new FakePathConsumerFactory(new FakePathConsumer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], "", Guid.Empty, CancellationToken.None));
    }

    /// <summary>
    /// A count of 0 would never enter the loop, leaving `consumed` at 0 and `reason` at its
    /// Completed default -- "consumed 0/0 paths; stopped because Completed", a false HEALTHY
    /// terminal against a topic that was never read. Elasticsearch cannot tell that apart from a
    /// real completion, so this is reported as a step failure instead.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenMessageCountIsLessThanOne()
    {
        var (processor, _, _) = Build(new FakePathConsumerFactory(new FakePathConsumer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(0), Guid.Empty, CancellationToken.None));
    }

    /// <summary>Same false-healthy-terminal hazard as a zero MessageCount, for the same reason.</summary>
    [Fact]
    public async Task FailsTheStepWhenIdleTimeoutSecondsIsLessThanOne()
    {
        var (processor, _, _) = Build(new FakePathConsumerFactory(new FakePathConsumer()));
        const string payload =
            """
            {"brokerList":"kafka-1:9092","topic":"file-paths","consumerGroup":"path-importer",
             "messageCount":10,"idleTimeoutSeconds":0}
            """;

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], payload, Guid.Empty, CancellationToken.None));
    }

    [Fact]
    public async Task FailsTheStepOnADeterministicConsumeFault()
    {
        var consumer = new FakePathConsumer
        {
            ConsumeThrowsOnCall = 1,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        }.WithPaths("/mnt/a.txt");
        var (processor, _, _) = Build(new FakePathConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));
    }

    [Fact]
    public async Task SubscribesToTheTopicTheStepNamed()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt");
        var (processor, sender, _) = Build(new FakePathConsumerFactory(consumer));

        await Run(processor, sender, messageCount: 1);

        Assert.Equal(["file-paths"], consumer.Subscribed);
    }
}
