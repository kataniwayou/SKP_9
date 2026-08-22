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
/// touched, and <c>landed</c> — which is the only part that needs one — is asserted false
/// throughout. Splitting the two facts apart is what bought this coverage; while a lost
/// acknowledgement was a sixth disposition value, none of these rows were reachable hermetically.
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
        Assert.Equal("false", m.Tags["landed"]);
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
    public async Task AnAckedRowReportsLandedFalseWhenThereIsNoChannel()
    {
        // The other half of the split. With no channel the acknowledgement cannot be issued, so
        // the broker will redeliver -- which is exactly the silent retry amplification `landed`
        // exists to expose. A row that reported landed=true here would be lying.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true), new Handler(() => Task.CompletedTask));

        await consumer.OnReceivedAsync(this, Delivery());

        Assert.Equal("false", TheOnlyConsumedMeasurement(metrics).Tags["landed"]);
    }

    [Fact]
    public void LandedRendersAsTheLowerCaseStringTrueNotABooleanTrue()
    {
        // The half of `landed` that a hermetic test CAN reach: a live broker is needed to make
        // SafeAckAsync/SafeNackAsync actually return true, but the string-rendering rule -- lower
        // case literals, never a bool an exporter could print as "True" -- needs no broker at all.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordConsumed(
            Queue, Type, "acked", "handled", landed: true);

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("true", m.Tags["landed"]);
    }


    [Fact]
    public void TheConsumingGaugeReportsOneSeriesPerQueueFromASingleInstrument()
    {
        // ONE instrument, N measurements -- not N instruments. Creating this gauge once per
        // consumer would put three instruments with one name on one meter, which the OpenTelemetry
        // SDK resolves to a single stream and warns about or drops. An observable callback may
        // return many measurements, so a registry keyed by queue is the shape that works.
        IngressMetrics.TrackConsumer("queue-a", () => true);
        IngressMetrics.TrackConsumer("queue-b", () => false);

        try
        {
            using var metrics = new MetricCollector(IngressMetrics.MeterName);
            metrics.Collect();

            var byQueue = metrics.For("pipeline.consumer.consuming")
                .ToDictionary(m => m.Tags["queue"], m => m.Value);

            Assert.Equal(1, byQueue["queue-a"]);
            Assert.Equal(0, byQueue["queue-b"]);
        }
        finally
        {
            IngressMetrics.UntrackConsumer("queue-a");
            IngressMetrics.UntrackConsumer("queue-b");
        }
    }

    [Fact]
    public void AnUntrackedConsumerStopsBeingReported()
    {
        // A consumer that stopped must not keep reporting the last value it held -- a stale 1 here
        // reads as "something is listening" for a queue nothing is reading.
        IngressMetrics.TrackConsumer("queue-gone", () => true);
        IngressMetrics.UntrackConsumer("queue-gone");

        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        metrics.Collect();

        Assert.DoesNotContain(
            metrics.For("pipeline.consumer.consuming"), m => m.Tags["queue"] == "queue-gone");
    }

    [Fact]
    public async Task InflightRisesForTheHandlerAndFallsBackToZero()
    {
        // Read against PrefetchCount this is saturation. The decrement is in a finally, so the
        // assertion that matters is the one after a handler that THREW.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        var consumer = BuildConsumer(
            await GateAsync(open: true),
            new Handler(() => throw new InvalidOperationException("boom")));

        await consumer.OnReceivedAsync(this, Delivery());

        var deltas = metrics.For("pipeline.consumer.inflight").Select(m => m.Value).ToArray();
        Assert.Equal(new double[] { 1, -1 }, deltas);
        Assert.Equal(0, deltas.Sum());
    }

    [Fact]
    public void AChannelResetIsCountedWithItsCause()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordChannelReset(Queue, "shutdown");

        var m = Assert.Single(metrics.For("pipeline.consumer.channel.resets"));
        Assert.Equal(1, m.Value);
        Assert.Equal("shutdown", m.Tags["reason"]);
        Assert.Equal(Queue, m.Tags["queue"]);
    }
}
