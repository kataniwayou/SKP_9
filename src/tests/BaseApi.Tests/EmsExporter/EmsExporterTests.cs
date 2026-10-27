using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.EmsExporter;
using Processor.EmsExporter.Ems;
using Xunit;

namespace BaseApi.Tests.EmsExporter;

/// <summary>
/// KafkaExporterTests' rules, on EMS, plus the three this processor adds: a queue must be named, a
/// body above the pod's ceiling fails before connecting, and a send that never answers is abandoned
/// at the backstop.
/// </summary>
public sealed class EmsExporterTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");

    /// <summary>The lineage this step was handed. Never Guid.Empty: an exporter is not a source.</summary>
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static string Payload(string queue = "skp.exports", int deliveryTimeoutSeconds = 30) =>
        $$"""
        {"queue":"{{queue}}","deliveryTimeoutSeconds":{{deliveryTimeoutSeconds}}}
        """;

    private static (EmsExporterProcessor Processor, IQueueSender Sender, RecordingLogger<EmsExporterProcessor> Log)
        Build(FakeMessageSenderFactory factory, long maxMessageBytes = 1024, TimeSpan? backstopGrace = null)
    {
        var log = new RecordingLogger<EmsExporterProcessor>();
        var sender = Substitute.For<IQueueSender>();
        var server = new EmsServerOptions { ServerUrl = "tcp://ems:7222", MaxMessageBytes = maxMessageBytes };
        var processor = new EmsExporterProcessor(factory, server, log)
        {
            BackstopGrace = backstopGrace ?? TimeSpan.FromSeconds(5),
        };
        processor.BeginDispatch(TestDispatch.State(sender, C, W, S, P));
        return (processor, sender, log);
    }

    private static byte[] Input(string text) => Encoding.UTF8.GetBytes(text);

    // ---- The export ------------------------------------------------------------------------

    /// <summary>
    /// AS IS: the bytes here are deliberately not valid UTF-8, because a seam that decoded on its way
    /// to the server — a TextMessage instead of a BytesMessage — would put the replacement character
    /// on the queue and no test sending text would notice.
    /// </summary>
    [Fact]
    public async Task SendsTheBranchDataByteForByteToTheQueueTheStepNamed()
    {
        byte[] data = [0xC3, 0x28, 0x00, 0xFF];
        var sender = new FakeMessageSender();
        var (processor, _, _) = Build(new FakeMessageSenderFactory(sender));

        await processor.ExecuteAsync(data, Payload(), E, CancellationToken.None);

        var (queue, body, _) = Assert.Single(sender.Sent);
        Assert.Equal("skp.exports", queue);
        Assert.Equal(data, body);
    }

    /// <summary>Two dispatches, two ids, so a sender that stamped a fixed or remembered id would fail.</summary>
    [Fact]
    public async Task StampsEachMessageWithTheExecutionItWasDispatchedWith()
    {
        var other = Guid.Parse("66666666-6666-6666-6666-666666666666");
        var sender = new FakeMessageSender();
        var (processor, _, _) = Build(new FakeMessageSenderFactory(sender));

        await processor.ExecuteAsync(Input("first"), Payload(), E, CancellationToken.None);
        processor.BeginDispatch(TestDispatch.State(Substitute.For<IQueueSender>(), C, W, S, P));
        await processor.ExecuteAsync(Input("second"), Payload(), other, CancellationToken.None);

        Assert.Equal([E, other], sender.Sent.Select(s => s.ExecutionId));
    }

    [Fact]
    public async Task ReportsItsSuccessWithOneBranchCarryingNoData()
    {
        var (processor, sender, _) = Build(new FakeMessageSenderFactory(new FakeMessageSender()));
        var branches = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(branches.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None);

        var branch = Assert.Single(branches);
        Assert.Empty(branch.Data);
        Assert.Equal(EntryIds.Branch(Guid.Empty, W, S, E), branch.EntryId);
        Assert.Equal(E, branch.ExecutionId);
    }

    /// <summary>The send landed and its report did not: redelivery, and a duplicate the consumer dedupes.</summary>
    [Fact]
    public async Task LetsAFailedCompletionSendPropagateAfterTheSend()
    {
        var emsSender = new FakeMessageSender();
        var (processor, sender, _) = Build(new FakeMessageSenderFactory(emsSender));
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .Returns(_ => throw new TransientSendException("broker gone", new InvalidOperationException()));

        await Assert.ThrowsAsync<PostSendException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));

        Assert.Single(emsSender.Sent);
    }

    [Fact]
    public async Task SendsNothingOnwardWhenTheExportFails()
    {
        var (processor, sender, _) = Build(new FakeMessageSenderFactory(new FakeMessageSender { SendThrowsOnCall = 1 }));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));

        await sender.DidNotReceive().SendAsync(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
            Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    /// <summary>
    /// KafkaExporter's template with the message id in the offset's place, so one query finds the
    /// exports of both processors.
    /// </summary>
    [Fact]
    public async Task LogsTheExportAgainstTheExecutionIdItWasDispatchedWith()
    {
        var (processor, _, log) = Build(new FakeMessageSenderFactory(new FakeMessageSender()));

        await processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None);

        var line = log.Records.Single(r => r.Message.Contains("exported")).Message;
        Assert.Contains(E.ToString(), line);
        Assert.Contains("to skp.exports at ID:EMS-SERVER.1", line);
    }

    [Fact]
    public async Task DoesNotLogTheDataItExported()
    {
        var (processor, _, log) = Build(new FakeMessageSenderFactory(new FakeMessageSender()));

        await processor.ExecuteAsync(Input("account 4711 balance 12.50"), Payload(), E, CancellationToken.None);

        Assert.DoesNotContain(log.Records, r => r.Message.Contains("4711"));
    }

    // ---- Failure ---------------------------------------------------------------------------

    [Fact]
    public async Task FailsTheStepWhenTheStepPayloadIsMissing()
    {
        var (processor, _, _) = Build(new FakeMessageSenderFactory(new FakeMessageSender()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), "", E, CancellationToken.None));
    }

    [Fact]
    public async Task FailsTheStepWhenTheStepPayloadNamesNoQueue()
    {
        var sender = new FakeMessageSender();
        var (processor, _, _) = Build(new FakeMessageSenderFactory(sender));

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(queue: " "), E, CancellationToken.None));

        Assert.Contains("queue", failed.Message);
        Assert.Empty(sender.Sent);
    }

    /// <summary>The edge guard runs first, so an entry-wired exporter names the wiring, not the empty input.</summary>
    [Fact]
    public async Task NamesTheWiringWhenItIsDispatchedAsAnEntryStep()
    {
        var sender = new FakeMessageSender();
        var (processor, _, _) = Build(new FakeMessageSenderFactory(sender));

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(), Guid.Empty, CancellationToken.None));

        Assert.Contains("entry", failed.Message);
        Assert.DoesNotContain("no input to export", failed.Message);
        Assert.Empty(sender.Sent);
    }

    [Fact]
    public async Task FailsTheStepWhenTheBranchCarriesNoData()
    {
        var sender = new FakeMessageSender();
        var (processor, _, _) = Build(new FakeMessageSenderFactory(sender));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(), E, CancellationToken.None));

        Assert.Empty(sender.Sent);
    }

    [Fact]
    public async Task FailsTheStepWhenDeliveryTimeoutSecondsIsBelowTheFloor()
    {
        var (processor, _, _) = Build(new FakeMessageSenderFactory(new FakeMessageSender()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(deliveryTimeoutSeconds: 0), E, CancellationToken.None));
    }

    /// <summary>
    /// Above the pod's ceiling fails BEFORE connecting, and names both numbers and the setting that
    /// moves one of them. One byte over, so an off-by-one in the comparison fails this.
    /// </summary>
    [Fact]
    public async Task FailsAnOversizeBodyWithoutConnecting()
    {
        var factory = new FakeMessageSenderFactory(new FakeMessageSender());
        var (processor, _, _) = Build(factory, maxMessageBytes: 4);

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("12345"), Payload(), E, CancellationToken.None));

        Assert.Contains("5 bytes", failed.Message);
        Assert.Contains("ceiling of 4", failed.Message);
        Assert.Contains("Ems__MaxMessageBytes", failed.Message);
        Assert.Equal(0, factory.Created);
    }

    [Fact]
    public async Task SendsABodyExactlyAtTheCeiling()
    {
        var sender = new FakeMessageSender();
        var (processor, _, _) = Build(new FakeMessageSenderFactory(sender), maxMessageBytes: 4);

        await processor.ExecuteAsync(Input("1234"), Payload(), E, CancellationToken.None);

        Assert.Single(sender.Sent);
    }

    [Fact]
    public async Task FailsTheStepWithTheEmsCodeWhenTheSendThrows()
    {
        var sender = new FakeMessageSender { SendThrowsOnCall = 1, FaultCode = "INVALID_DESTINATION" };
        var (processor, _, _) = Build(new FakeMessageSenderFactory(sender));

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));

        Assert.Equal("exporting to skp.exports failed: INVALID_DESTINATION", failed.Message);
    }

    [Fact]
    public async Task FailsTheStepWhenTheSenderCannotBeBuilt()
    {
        var factory = new FakeMessageSenderFactory(new FakeMessageSender()) { CreateThrows = true };
        var (processor, _, _) = Build(factory);

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));

        Assert.StartsWith("building a sink for skp.exports failed", failed.Message);
    }

    /// <summary>
    /// A server that accepted the connection and then stopped answering: no reconnect limit sees it,
    /// so the backstop fails the step at timeout + grace and drops the sender, and the next dispatch
    /// connects afresh. One second plus no grace keeps the test short.
    /// </summary>
    [Fact]
    public async Task AbandonsASendThatNeverAnswersAndConnectsAfreshNextTime()
    {
        var quiet = new FakeMessageSender { SendHangsOnCall = 1 };
        var fresh = new FakeMessageSender();
        var factory = new FakeMessageSenderFactory(quiet, fresh);
        var (processor, _, _) = Build(factory, backstopGrace: TimeSpan.Zero);

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("one"), Payload(deliveryTimeoutSeconds: 1), E, CancellationToken.None));
        await processor.ExecuteAsync(Input("two"), Payload(deliveryTimeoutSeconds: 1), E, CancellationToken.None);

        Assert.Contains("no answer within 1s", failed.Message);
        Assert.True(quiet.Disposed);
        Assert.Single(fresh.Sent);
    }

    /// <summary>The placeholder factory the host registers until TIBCO.EMS.dll is vendored, failing by name.</summary>
    [Fact]
    public async Task NamesTheMissingClientWhileTheImageHasNoTibcoLibrary()
    {
        var log = new RecordingLogger<EmsExporterProcessor>();
        var processor = new EmsExporterProcessor(
            new UnavailableMessageSenderFactory(), new EmsServerOptions { ServerUrl = "tcp://ems:7222" }, log);
        processor.BeginDispatch(TestDispatch.State(Substitute.For<IQueueSender>(), C, W, S, P));

        var failed = await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None));

        Assert.Contains(UnavailableMessageSenderFactory.Code, failed.Message);
    }

    // ---- The cache -------------------------------------------------------------------------

    [Fact]
    public async Task KeepsOneSenderAcrossDispatchesAndQueues()
    {
        var sender = new FakeMessageSender();
        var factory = new FakeMessageSenderFactory(sender);
        var (processor, _, _) = Build(factory);

        await processor.ExecuteAsync(Input("one"), Payload("skp.exports"), E, CancellationToken.None);
        await processor.ExecuteAsync(Input("two"), Payload("skp.audit"), E, CancellationToken.None);

        Assert.Equal(1, factory.Created);
        Assert.Equal(["skp.exports", "skp.audit"], sender.Sent.Select(s => s.Queue));
    }

    /// <summary>The timeout fixes the connection limits, so a different one needs a different connection.</summary>
    [Fact]
    public async Task RebuildsWhenTheStepNamesADifferentDeliveryTimeout()
    {
        var first = new FakeMessageSender();
        var factory = new FakeMessageSenderFactory(first, new FakeMessageSender());
        var (processor, _, _) = Build(factory);

        await processor.ExecuteAsync(Input("one"), Payload(deliveryTimeoutSeconds: 30), E, CancellationToken.None);
        await processor.ExecuteAsync(Input("two"), Payload(deliveryTimeoutSeconds: 5), E, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(first.Disposed);
        Assert.Equal([TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(5)], factory.Requests);
    }

    [Fact]
    public async Task DiscardsTheSenderAfterAFailedSendSoTheNextDispatchIsFresh()
    {
        var faulted = new FakeMessageSender { SendThrowsOnCall = 1 };
        var fresh = new FakeMessageSender();
        var factory = new FakeMessageSenderFactory(faulted, fresh);
        var (processor, _, _) = Build(factory);

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync(Input("one"), Payload(), E, CancellationToken.None));
        await processor.ExecuteAsync(Input("two"), Payload(), E, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(faulted.Disposed);
        Assert.Single(fresh.Sent);
    }

    [Fact]
    public async Task ClosesTheSenderWhenTheHostShutsDown()
    {
        var sender = new FakeMessageSender();
        var (processor, _, _) = Build(new FakeMessageSenderFactory(sender));

        await processor.ExecuteAsync(Input("payload"), Payload(), E, CancellationToken.None);
        processor.Dispose();

        Assert.True(sender.Disposed);
    }
}
