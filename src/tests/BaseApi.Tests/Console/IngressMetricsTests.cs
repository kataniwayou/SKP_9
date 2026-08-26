using System.IO;
using System.Linq;
using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// Drives the §5.1 disposition matrix through a real <see cref="GatedQueueConsumer"/> with no
/// broker behind it.
/// <para>
/// That works because <c>disposition</c> and <c>reason</c> are decided before any channel is
/// touched. Whether the broker was actually told — the fact <c>landed</c> used to carry on this
/// metric — no longer needs asserting here at all: it survives only in the consumer's own log
/// line, which is not this class's concern. Splitting the two facts apart is what bought this
/// coverage; while a lost acknowledgement was a sixth disposition value, none of these rows were
/// reachable hermetically.
/// </para>
/// </summary>
public sealed class IngressMetricsTests
{
    private const string Queue = "some-queue";
    private const string Type = "step-outcome";

    private sealed class Latch : IConsumerAdmission
    {
        public bool IsOpen { get; set; } = true;
    }

    /// <summary>
    /// A handler for <see cref="Type"/> that does whatever the test needs it to do. Hand-written
    /// rather than an NSubstitute mock so it can be registered by concrete type in a container —
    /// and because BaseConsole.Core grants internals to BaseApi.Tests but not to NSubstitute's
    /// proxy assembly.
    /// </summary>
    private sealed class Handler(Func<Task> body) : IQueueMessageHandler
    {
        public string MessageType => Type;
        public Task HandleAsync(ReadOnlyMemory<byte> body_, CancellationToken ct) => body();
    }

    private static BasicDeliverEventArgs Delivery(string type = Type) =>
        new("consumer-tag", deliveryTag: 1UL, redelivered: false,
            exchange: "", routingKey: Queue,
            properties: new BasicProperties { Type = type },
            body: ReadOnlyMemory<byte>.Empty);

    /// <summary>
    /// A consumer with no channel and no broker. Its constructor only assigns fields, and
    /// <see cref="RabbitMqConnection"/> opens no socket until asked — the same construction
    /// <see cref="ConsumerAdmissionTests"/> already relies on.
    /// </summary>
    private static GatedQueueConsumer BuildConsumer(L2Gate gate, params IQueueMessageHandler[] handlers)
    {
        var connection = new RabbitMqConnection(
            Options.Create(new RabbitMqOptions()),
            Array.Empty<IRabbitMqTopology>(),
            NullLogger<RabbitMqConnection>.Instance);

        var services = new ServiceCollection();
        foreach (var handler in handlers)
        {
            services.AddSingleton<IQueueMessageHandler>(handler);
        }

        var scopes = services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();

        return new GatedQueueConsumer(
            connection,
            gate,
            scopes,
            Options.Create(new GatedConsumerOptions { Queue = Queue }),
            new Latch(),
            NullLogger<GatedQueueConsumer>.Instance);
    }

    /// <summary>An L2Gate driven to the state the test needs. It is constructed closed by design.</summary>
    private static async Task<L2Gate> GateAsync(bool open)
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        if (open)
        {
            await gate.ReportHealthyAsync();
        }

        return gate;
    }

    private static RecordedMeasurement TheOnlyConsumedMeasurement(MetricCollector metrics)
    {
        // Assert.Single is the exactly-once invariant in its cheapest form, and it is asserted on
        // every row rather than once: the failure it guards against is a second Record left behind
        // on one branch, which a per-branch value assertion would happily pass.
        return Assert.Single(metrics.For("pipeline.messages.consumed"));
    }

    [Fact]
    public async Task ADeliveryArrivingWhileTheGateIsShutIsRequeuedAsGateClosed()
    {
        // The gate can close between the broker handing a message over and it arriving, and
        // messages already in flight when the subscription was cancelled still arrive. This row is
        // the one that makes a pause read as a pause rather than as a burst of failures.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: false));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("requeued", m.Tags["disposition"]);
        Assert.Equal("gate_closed", m.Tags["reason"]);
        Assert.Equal(Queue, m.Tags["queue"]);
        Assert.Equal(Type, m.Tags["type"]);
    }

    [Fact]
    public async Task AHandlerThatReturnsIsAcked()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true), new Handler(() => Task.CompletedTask));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("acked", m.Tags["disposition"]);
        Assert.Equal("handled", m.Tags["reason"]);
    }

    [Fact]
    public async Task AStoreFaultRequeuesAsStoreUnreachable()
    {
        // DeliveryClassifier maps a Redis connection fault to RequeueAndTrip, which is the branch
        // that also closes the gate -- the pause is at the broker rather than a redelivery burned
        // per message for the length of the outage.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var gate = await GateAsync(open: true);
        var consumer = BuildConsumer(
            gate,
            new Handler(() => throw new RedisConnectionException(
                ConnectionFailureType.UnableToConnect, "down")));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("requeued", m.Tags["disposition"]);
        Assert.Equal("store_unreachable", m.Tags["reason"]);
        Assert.False(gate.IsOpen);
    }

    [Fact]
    public async Task AnExceptionThatEscapesTheHandlerPathIsRecordedAsEscapedAndStillPropagates()
    {
        // TripAsync invokes L2Gate.StateChanged synchronously, under its own mutex. A subscriber
        // that throws -- concretely reachable in production via the wake semaphore this class
        // disposes during shutdown, which races the RequeueAndTrip arm's own TripAsync call -- must
        // not be swallowed: it has to keep escaping this ReceivedAsync callback exactly as it does
        // today, and it must still be measured, because the RabbitMQ client library swallows
        // whatever escapes silently.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var gate = await GateAsync(open: true);
        gate.StateChanged += _ => throw new InvalidOperationException("subscriber blew up");

        var consumer = BuildConsumer(
            gate,
            new Handler(() => throw new RedisConnectionException(
                ConnectionFailureType.UnableToConnect, "down")));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => consumer.OnReceivedAsync(this, Delivery()));

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("requeued", m.Tags["disposition"]);
        Assert.Equal("escaped", m.Tags["reason"]);
    }

    [Fact]
    public async Task ATransientSendFaultRequeuesAsSendFailed()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true),
            new Handler(() => throw new TransientSendException("broker blip", new IOException("connection reset"))));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("requeued", m.Tags["disposition"]);
        Assert.Equal("send_failed", m.Tags["reason"]);
    }

    [Fact]
    public async Task ADeterministicFaultIsParkedAsRefused()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true),
            new Handler(() => throw new InvalidOperationException("will fail identically forever")));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("parked", m.Tags["disposition"]);
        Assert.Equal("refused", m.Tags["reason"]);
    }

    [Fact]
    public async Task AMessageWithNoRegisteredHandlerIsParkedAsRefused()
    {
        // No redeploy of this process grows a handler for an unknown type, so retrying cannot help.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: true));

        await consumer.OnReceivedAsync(this, Delivery(type: "no-such-type"));

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("parked", m.Tags["disposition"]);
        Assert.Equal("refused", m.Tags["reason"]);
        Assert.Equal("no-such-type", m.Tags["type"]);
    }

    [Fact]
    public async Task AMessageWithNoTypeHeaderIsParkedAndStillNamesItsQueue()
    {
        // Above the type boundary there is no type to report, but the queue is still known -- and
        // a measurement with an empty type attribute is what tells an operator the header is
        // missing rather than the handler.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: true));

        await consumer.OnReceivedAsync(this, Delivery(type: ""));

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("parked", m.Tags["disposition"]);
        Assert.Equal("refused", m.Tags["reason"]);
        Assert.Equal(Queue, m.Tags["queue"]);
        Assert.Equal("", m.Tags["type"]);
    }

    [Fact]
    public void ADeliveryCarriesExactlyFourTagsPlusAnyAmbientOne()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordConsumed("q-tags", "T", "parked", "refused");

        var mine = metrics.For("pipeline.messages.consumed")
            .Single(m => m.Tags["queue"] == "q-tags");

        Assert.Equal("T", mine.Tags["type"]);
        Assert.Equal("parked", mine.Tags["disposition"]);
        Assert.Equal("refused", mine.Tags["reason"]);

        // landed is gone. A park that the broker was never told about is now indistinguishable
        // here from one it was -- the check is pipeline.deadletter.depth, where a park that did
        // not land never appears.
        Assert.False(mine.Tags.ContainsKey("landed"));
    }

    [Fact]
    public void QueueWaitIsLabelledLikeQueueDepth()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordArrival("q-wait", sentMs: MessageClock.NowMilliseconds() - 25);

        var mine = metrics.For(IngressMetrics.QueueWaitInstrument)
            .Single(m => m.Tags["queue"] == "q-wait");

        // One dimension, matching pipeline.queue.depth, so the two can be read side by side on a
        // board without one of them fanning out into a dimension the other does not have.
        Assert.False(mine.Tags.ContainsKey("type"));
    }

    [Fact]
    public void AMessageWithNoSentHeaderContributesNothingRatherThanZero()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordArrival("q-noheader", sentMs: null);

        // A build without the instrument stamps no header, and there are always some during a
        // rollout. Recording those as zero would bury the real distribution under a spike that
        // means nothing.
        Assert.DoesNotContain(
            metrics.For(IngressMetrics.QueueWaitInstrument), m => m.Tags["queue"] == "q-noheader");
    }
}
