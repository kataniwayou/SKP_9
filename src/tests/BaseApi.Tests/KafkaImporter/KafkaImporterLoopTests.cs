using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.KafkaImporter;
using Xunit;

namespace BaseApi.Tests.KafkaImporter;

public sealed class KafkaImporterLoopTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static string Payload(int messageCount) =>
        $$"""
        {"brokerList":"kafka-1:9092","topic":"records","consumerGroup":"kafka-importer",
         "messageCount":{{messageCount}},"idleTimeoutSeconds":1}
        """;

    private static (KafkaImporterProcessor Processor, IQueueSender Sender, RecordingLogger<KafkaImporterProcessor> Log)
        Build(FakeRecordConsumerFactory factory)
    {
        var log = new RecordingLogger<KafkaImporterProcessor>();
        var sender = Substitute.For<IQueueSender>();
        var processor = new KafkaImporterProcessor(factory, log);
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender, log);
    }

    private static async Task<List<ProcessedData>> Run(
        KafkaImporterProcessor processor, IQueueSender sender, int messageCount)
    {
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        // Guid.Empty: a source step. KafkaImporter mints per record regardless, and a later fact
        // pins that it does so even when handed a non-empty id.
        await processor.ExecuteAsync([], Payload(messageCount), Guid.Empty, CancellationToken.None);
        return sends;
    }

    /// <summary>
    /// Decodes the branch's data, which is the record's value verbatim. There is no envelope to
    /// reach into: whatever the topic carried IS ProcessedData.Data, and the fact below that queues
    /// bytes rather than text is the one that proves it.
    /// </summary>
    private static string ValueIn(ProcessedData p) => Encoding.UTF8.GetString(p.Data);

    private static string Summary(RecordingLogger<KafkaImporterProcessor> log)
        => log.Records.Single(r => r.Message.Contains("stopped because")).Message;

    // ---- Terminals -------------------------------------------------------------------------

    [Fact]
    public async Task ConsumesEveryRecordItWasAskedForAndReportsCompleted()
    {
        var consumer = new FakeRecordConsumer().WithRecords("value-a", "value-b", "value-c");
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 3);

        Assert.Equal(["value-a", "value-b", "value-c"], sends.Select(ValueIn));
        Assert.Contains("consumed 3/3 records; stopped because Completed", Summary(log));
    }

    /// <summary>
    /// Twelve of a hundred because the topic held twelve. The reason on the line is the only thing
    /// that separates this from the Faulted case below, which reports an identical count.
    /// </summary>
    [Fact]
    public async Task StopsAtDrainedWhenTheTopicRunsOutBeforeTheCount()
    {
        var values = Enumerable.Range(0, 12).Select(i => $"record-{i}").ToArray();
        var consumer = new FakeRecordConsumer().WithRecords(values);
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 100);

        Assert.Equal(12, sends.Count);
        Assert.Contains("consumed 12/100 records; stopped because Drained", Summary(log));
    }

    /// <summary>
    /// Twelve of a hundred because the thirteenth consume threw. Same count as Drained, different
    /// cause, and the whole reason the reason is on the line.
    /// </summary>
    [Fact]
    public async Task StopsAtFaultedWhenATransientConsumeThrows()
    {
        var values = Enumerable.Range(0, 20).Select(i => $"record-{i}").ToArray();
        var consumer = new FakeRecordConsumer { ConsumeThrowsOnCall = 13 }.WithRecords(values);
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 100);

        Assert.Equal(12, sends.Count);
        Assert.Equal(12, consumer.Committed.Count);
        Assert.Contains("consumed 12/100 records; stopped because Faulted", Summary(log));
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
        var consumer = new FakeRecordConsumer { Assigned = false }.WithRecords("value-a");
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(100), Guid.Empty, CancellationToken.None));
    }

    /// <summary>
    /// Waiting for assignment is part of getting a subscribed consumer, and every failure of that is
    /// a step failure. The fault here is one the old allow-list called deterministic; the next test
    /// uses one it called transient. Both fail the step now, which is the point: the classification
    /// no longer decides anything here.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenAssignmentThrowsADeterministicFault()
    {
        var consumer = new FakeRecordConsumer
        {
            AssignmentThrows = true,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.UnknownTopicOrPart),
        }.WithRecords("value-a");
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(consumer));

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
        var consumer = new FakeRecordConsumer { AssignmentThrows = true }.WithRecords("value-a");
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));
    }

    // ---- Ordering and identity -------------------------------------------------------------

    /// <summary>
    /// Commit only if the send succeeded. A send that throws must leave the offset where it is, so
    /// the next dispatch re-reads that record instead of losing it.
    /// </summary>
    [Fact]
    public async Task CommitsNothingForARecordWhoseSendFailed()
    {
        var consumer = new FakeRecordConsumer().WithRecords("value-a", "value-b");
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));

        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .Returns(_ => throw new TransientSendException("broker gone", new InvalidOperationException()));

        await Assert.ThrowsAsync<PostSendException>(() =>
            processor.ExecuteAsync([], Payload(2), Guid.Empty, CancellationToken.None));

        Assert.Empty(consumer.Committed);
    }

    /// <summary>
    /// Per record, not per batch. A batch commit would re-send every record of a dispatch redelivered
    /// halfway, because a source step has no input key to guard the replay.
    /// </summary>
    [Fact]
    public async Task CommitsEachRecordAsItGoesRatherThanOnceAtTheEnd()
    {
        var consumer = new FakeRecordConsumer { CommitThrowsOnCall = 2 }.WithRecords("value-a", "value-b");
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        await Run(processor, sender, messageCount: 10);

        Assert.Equal(["value-a"], consumer.Committed);
        Assert.Contains("consumed 1/10 records; stopped because Faulted", Summary(log));
    }

    [Fact]
    public async Task OpensADistinctLineageForEveryRecord()
    {
        var consumer = new FakeRecordConsumer().WithRecords("value-a", "value-b", "value-c");
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 3);

        Assert.Equal(3, sends.Select(s => s.ExecutionId).Distinct().Count());
        Assert.DoesNotContain(Guid.Empty, sends.Select(s => s.ExecutionId));
    }

    /// <summary>
    /// <b>THIS FACT WAS INVERTED, and the inversion is the point of the edge guard.</b> It used to
    /// assert that a dispatch carrying a lineage was IGNORED — the importer minted per record anyway
    /// and the inbound id simply went unused. Silently doing the right thing with a wrong dispatch is
    /// still a wrong dispatch: an importer wired downstream of another step ran on every hand-off and
    /// nothing said so.
    /// <para>
    /// Now it refuses. <c>ExecutionId</c> alone decides what an edge is — an entry dispatch carries
    /// <see cref="Guid.Empty"/> and a downstream one carries the lineage it belongs to — so a
    /// non-empty id here means the workflow wires this step downstream, which it cannot be: every
    /// record is the origin of its own lineage, so there is none it could continue.
    /// </para>
    /// <para>
    /// It refuses BEFORE it opens anything: nothing is consumed and no branch is sent, so a
    /// mis-wired workflow cannot half-run.
    /// </para>
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenItIsDispatchedInsideALineage()
    {
        var inbound = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var consumer = new FakeRecordConsumer().WithRecords("value-a", "value-b");
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(2), inbound, CancellationToken.None));

        Assert.Contains(inbound.ToString(), failed.Message);
        Assert.Empty(sends);
        Assert.Empty(consumer.Committed);
    }

    /// <summary>
    /// The guard runs BEFORE the payload check, so a step that is both mis-wired and mis-authored
    /// reports the wiring. Reaching the payload check first would name a symptom: an operator would
    /// go and write the payload the message asked for, and the step would still be in the wrong place.
    /// </summary>
    [Fact]
    public async Task NamesTheWiringRatherThanTheMissingPayloadWhenBothAreWrong()
    {
        var inbound = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(new FakeRecordConsumer()));

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], "", inbound, CancellationToken.None));

        Assert.Contains("entry step", failed.Message);
        Assert.DoesNotContain("step payload", failed.Message);
    }

    // ---- As is -----------------------------------------------------------------------------

    /// <summary>
    /// <b>The fact that pins "as is".</b> The branch carries the record's value byte for byte: no
    /// envelope around it, no re-encoding through it, nothing added and nothing dropped.
    /// <para>
    /// The value here is deliberately not valid UTF-8 — 0xC3 opens a two-byte sequence and 0x28 does
    /// not continue it — because that is the case a string-typed seam cannot survive. Decoding this
    /// to a string and re-encoding it on the way out yields the replacement character, silently, and
    /// the branch would carry three bytes the topic never held. Nothing else in this suite would
    /// notice: every other fact queues text, and text round-trips. This is the whole reason
    /// <c>KafkaRecord.Value</c> is a <c>byte[]</c>.
    /// </para>
    /// </summary>
    [Fact]
    public async Task SendsTheRecordValueByteForByteEvenWhenItIsNotText()
    {
        byte[] value = [0xC3, 0x28, 0x00, 0xFF];
        var consumer = new FakeRecordConsumer().WithRecords(value);
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 1);

        Assert.Equal(value, sends.Single().Data);
    }

    /// <summary>
    /// The other half of "as is": a JSON record is not unwrapped, re-serialized or re-ordered on its
    /// way through. What arrives downstream is the exact bytes the topic held, which is what lets the
    /// processor's registered output schema describe the topic rather than an envelope this
    /// processor invented.
    /// </summary>
    [Fact]
    public async Task AddsNoEnvelopeAroundTheRecordValue()
    {
        const string value = """{"path":"/mnt/a.txt","providerName":"acme"}""";
        var consumer = new FakeRecordConsumer().WithRecords(value);
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 1);

        Assert.Equal(value, ValueIn(sends.Single()));
    }

    // ---- The Elasticsearch coupling --------------------------------------------------------

    /// <summary>
    /// The record this whole processor exists to produce: the value, and the execution id it opened,
    /// on one line. The correlation id rides the dispatch scope and is not named in the template.
    /// The id must be the SAME one the branch carries, or the coupling leads nowhere.
    /// </summary>
    [Fact]
    public async Task LogsEachRecordAgainstTheExecutionIdItsBranchCarries()
    {
        var consumer = new FakeRecordConsumer().WithRecords("{\"order\":4711}");
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 1);

        var line = log.Records.Single(r => r.Message.Contains("imported record")).Message;
        Assert.Contains("{\"order\":4711}", line);
        Assert.Contains(sends.Single().ExecutionId.ToString(), line);
    }

    // ---- Failure ---------------------------------------------------------------------------

    [Fact]
    public async Task FailsTheStepWhenTheStepPayloadIsMissing()
    {
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(new FakeRecordConsumer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], "", Guid.Empty, CancellationToken.None));
    }

    /// <summary>
    /// A count of 0 would never enter the loop, leaving `consumed` at 0 and `reason` at its
    /// Completed default -- "consumed 0/0 records; stopped because Completed", a false HEALTHY
    /// terminal against a topic that was never read. Elasticsearch cannot tell that apart from a
    /// real completion, so this is reported as a step failure instead.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenMessageCountIsLessThanOne()
    {
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(new FakeRecordConsumer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(0), Guid.Empty, CancellationToken.None));
    }

    /// <summary>Same false-healthy-terminal hazard as a zero MessageCount, for the same reason.</summary>
    [Fact]
    public async Task FailsTheStepWhenIdleTimeoutSecondsIsLessThanOne()
    {
        var (processor, _, _) = Build(new FakeRecordConsumerFactory(new FakeRecordConsumer()));
        const string payload =
            """
            {"brokerList":"kafka-1:9092","topic":"records","consumerGroup":"kafka-importer",
             "messageCount":10,"idleTimeoutSeconds":0}
            """;

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], payload, Guid.Empty, CancellationToken.None));
    }

    /// <summary>
    /// Once reading has started nothing fails the step, whatever the fault code. This one is from the
    /// old deterministic allow-list and it now ends the dispatch at Faulted with the records already
    /// sent kept — the next dispatch re-subscribes, and if the fault is genuinely permanent it
    /// surfaces there, where it does fail the step.
    /// </summary>
    [Fact]
    public async Task StopsAtFaultedWhenConsumeThrowsADeterministicFault()
    {
        var consumer = new FakeRecordConsumer
        {
            ConsumeThrowsOnCall = 1,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        }.WithRecords("value-a");
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 10);

        Assert.Empty(sends);
        Assert.Contains("consumed 0/10 records; stopped because Faulted", Summary(log));
    }

    /// <summary>
    /// Commit is inside the loop, so a fault there ends the dispatch rather than failing the step.
    /// The record was already sent and its offset was not committed, so the next dispatch re-reads it:
    /// a duplicate, which is the recoverable direction.
    /// </summary>
    [Fact]
    public async Task StopsAtFaultedWhenCommitThrows()
    {
        var consumer = new FakeRecordConsumer
        {
            CommitThrowsOnCall = 3,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        }.WithRecords("value-a", "value-b", "value-c", "value-d");
        var (processor, sender, log) = Build(new FakeRecordConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 10);

        Assert.Equal(3, sends.Count);
        Assert.Equal(2, consumer.Committed.Count);
        Assert.Contains("consumed 2/10 records; stopped because Faulted", Summary(log));
    }

    /// <summary>
    /// Rent is Create plus Subscribe — part of getting a subscribed consumer, so any fault there
    /// fails the step. Deterministic code here, transient in the test below; both fail.
    /// </summary>
    [Fact]
    public async Task FailsTheStepWhenRentThrowsADeterministicFault()
    {
        var factory = new FakeRecordConsumerFactory(new FakeRecordConsumer().WithRecords("value-a"))
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
        var factory = new FakeRecordConsumerFactory(new FakeRecordConsumer().WithRecords("value-a"))
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
        var consumer = new FakeRecordConsumer().WithRecords("value-a");
        var (processor, sender, _) = Build(new FakeRecordConsumerFactory(consumer));

        await Run(processor, sender, messageCount: 1);

        Assert.Equal(["records"], consumer.Subscribed);
    }
}
