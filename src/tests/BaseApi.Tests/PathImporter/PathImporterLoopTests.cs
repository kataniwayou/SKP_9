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
    /// No assignment, no dispatch — and the orchestrator is told. An unassigned consumer polls empty
    /// and an empty poll is indistinguishable from an empty topic, so reaching the loop at all would
    /// report a full topic Drained. Proven against a live broker: with the broker stopped the wait
    /// returns false rather than throwing, in 87ms on a warm consumer and at the full idle timeout on
    /// a cold one.
    /// <para>
    /// <b>Failed, not a Faulted terminal.</b> A Faulted terminal is silent to the orchestrator, and a
    /// source step that cannot reach its broker is the one condition nothing downstream can infer:
    /// no branches arrive, which is exactly what an empty topic also looks like.
    /// </para>
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenNoPartitionIsAssigned()
    {
        var consumer = new FakePathConsumer { Assigned = false }.WithPaths("/mnt/a.txt");
        var (processor, _, _) = Build(new FakePathConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(100), Guid.Empty, CancellationToken.None));
    }

    /// <summary>
    /// Waiting for assignment is part of getting a subscribed consumer, and every failure of that is
    /// a step failure. The fault here is one the old allow-list called deterministic; the next test
    /// uses one it called transient. Both fail the step now, which is the point: the classification
    /// no longer decides anything on this path.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenAssignmentThrowsADeterministicFault()
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
    /// The twin of the test above with a transient fault. It used to reach a Faulted terminal; it now
    /// fails the step, because a source step that never got a partition has nothing to say and no
    /// other way to say it.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenAssignmentThrowsATransientFault()
    {
        var consumer = new FakePathConsumer { AssignmentThrows = true }.WithPaths("/mnt/a.txt");
        var (processor, _, _) = Build(new FakePathConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));
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

    /// <summary>
    /// Once reading has started nothing fails the step, whatever the fault code. This one is from the
    /// old deterministic allow-list and it now ends the dispatch at Faulted with the paths already
    /// sent kept — the next dispatch re-subscribes, and if the fault is genuinely permanent it
    /// surfaces there, where it does fail the step.
    /// </summary>
    [Fact]
    public async Task StopsAtFaultedWhenConsumeThrowsADeterministicFault()
    {
        var consumer = new FakePathConsumer
        {
            ConsumeThrowsOnCall = 1,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        }.WithPaths("/mnt/a.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 10);

        Assert.Empty(sends);
        Assert.Contains("consumed 0/10 paths; stopped because Faulted", Summary(log));
    }

    /// <summary>
    /// Commit is inside the loop, so a fault there ends the dispatch rather than failing the step.
    /// The path was already sent and its offset was not committed, so the next dispatch re-reads it:
    /// a duplicate, which is the recoverable direction.
    /// </summary>
    [Fact]
    public async Task StopsAtFaultedWhenCommitThrows()
    {
        var consumer = new FakePathConsumer
        {
            CommitThrowsOnCall = 3,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        }.WithPaths("/mnt/a.txt", "/mnt/b.txt", "/mnt/c.txt", "/mnt/d.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 10);

        Assert.Equal(3, sends.Count);
        Assert.Equal(2, consumer.Committed.Count);
        Assert.Contains("consumed 2/10 paths; stopped because Faulted", Summary(log));
    }

    /// <summary>
    /// Rent is Create plus Subscribe — part of getting a subscribed consumer, so any fault there
    /// fails the step. Deterministic code here, transient in the test below; both fail.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenRentThrowsADeterministicFault()
    {
        var factory = new FakePathConsumerFactory(new FakePathConsumer().WithPaths("/mnt/a.txt"))
        {
            CreateThrows = true,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        };
        var (processor, _, _) = Build(factory);

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));
    }

    /// <summary>A transient Rent fault fails the step too: it never got a subscribed consumer.</summary>
    [Fact]
    public async Task FailsTheStepWhenRentThrowsATransientFault()
    {
        var factory = new FakePathConsumerFactory(new FakePathConsumer().WithPaths("/mnt/a.txt"))
        {
            CreateThrows = true,
        };
        var (processor, _, _) = Build(factory);

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
