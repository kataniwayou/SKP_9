using System.Linq;
using BaseApi.Core.Messaging;
using BaseApi.Tests.Support;
using BaseApi.Core.Gating;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Messaging;

/// <summary>
/// The API's own <see cref="GatedQueueConsumer"/>, driven the way
/// <c>BaseApi.Tests.Console.IngressMetricsTests</c> drives BaseConsole.Core's twin.
/// <para>
/// <b>This class exists because the twin had all the coverage and this copy had none.</b> Every
/// consumer test in the suite targeted BaseConsole.Core, so an arm that existed on one side and not
/// the other was invisible to the whole suite — which is exactly what happened: the escape arm below
/// was present on the twin and absent here, so an escaping delivery was counted by
/// <c>pipeline.consumer.duration</c> and by nothing at all on <c>pipeline.messages.consumed</c>.
/// </para>
/// <para>
/// Only the rows that bear on that asymmetry are covered here, not the full disposition matrix. The
/// matrix is the twin's to assert; what needed proving on this side is that a delivery is accounted
/// for exactly once on every exit, including the exit that leaves through an exception.
/// </para>
/// </summary>
public sealed class ApiIngressMetricsTests
{
    private const string Queue = "orchestrator-control";
    private const string Type = "orchestration-started";

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
    /// A consumer with no channel and no broker — the constructor only assigns fields, and
    /// <see cref="RabbitMqConnection"/> opens no socket until asked. The API's constructor takes no
    /// <c>IConsumerAdmission</c>, and its <see cref="L2Gate"/> is BaseApi.Core's own type rather
    /// than BaseConsole.Core's — the two hosts each carry their own copy. Those are the only shape
    /// differences from the twin's harness.
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
            services.AddSingleton(handler);
        }

        var scopes = services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();

        return new GatedQueueConsumer(
            connection,
            gate,
            scopes,
            Options.Create(new GatedConsumerOptions { Queue = Queue }),
            NullLogger<GatedQueueConsumer>.Instance);
    }

    private static async Task<L2Gate> GateAsync(bool open)
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        if (open)
        {
            await gate.ReportHealthyAsync();
        }

        return gate;
    }

    private static RecordedMeasurement TheOnlyConsumedMeasurement(MetricCollector metrics) =>
        Assert.Single(metrics.For("pipeline.messages.consumed"));

    private static RecordedMeasurement TheOnlyConsumerDurationMeasurement(MetricCollector metrics) =>
        Assert.Single(metrics.For(IngressMetrics.ConsumerDurationInstrument));

    [Fact]
    public async Task ADeliveryThatEscapesIsStillCounted()
    {
        // THE ARM THIS CLASS WAS WRITTEN FOR. L2Gate.StateChanged subscribers run synchronously
        // inside TripAsync, and the store-unreachable branch calls TripAsync BEFORE it records — so
        // a subscriber that throws leaves this method with nothing counted. The RabbitMQ client
        // library swallows whatever escapes a callback, so before this the delivery was invisible
        // on the counter while still being timed by the histogram.
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
    public async Task AnEscapeAgreesWithItsOwnDurationMeasurement()
    {
        // "escaped" is the REASON; the DISPOSITION has to match what the finally records for the
        // same delivery, or the counter and the histogram describe one delivery two ways.
        //
        // Asserts BOTH sides, and that is not padding. Written against the duration alone this
        // passed with the escape arm deleted -- the finally records regardless, so "agreement" held
        // vacuously against a counter measurement that did not exist. Caught by disabling the arm
        // and watching which tests failed: only one of five did.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var gate = await GateAsync(open: true);
        gate.StateChanged += _ => throw new InvalidOperationException("subscriber blew up");

        var consumer = BuildConsumer(
            gate,
            new Handler(() => throw new RedisConnectionException(
                ConnectionFailureType.UnableToConnect, "down")));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => consumer.OnReceivedAsync(this, Delivery()));

        var consumed = TheOnlyConsumedMeasurement(metrics);
        var duration = TheOnlyConsumerDurationMeasurement(metrics);

        Assert.Equal("requeued", consumed.Tags["disposition"]);
        Assert.Equal("requeued", duration.Tags["disposition"]);
        Assert.Equal(consumed.Tags["disposition"], duration.Tags["disposition"]);
    }

    [Fact]
    public async Task AClassifiedExitIsNotDoubleCounted()
    {
        // The other half of the escape arm: `recorded` must suppress the catch's record when a
        // branch already accounted for the delivery. Asserted with Single rather than by value,
        // because the failure this guards is a SECOND measurement, which a value check would pass.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: false));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("requeued", m.Tags["disposition"]);
        Assert.Equal("gate_closed", m.Tags["reason"]);
    }

    [Fact]
    public async Task AnUnknownMessageTypeIsParkedAndCountedOnce()
    {
        // A real disposition reached without a handler registered, and the row most likely to be
        // hit in production by a stray publish: no handler for the type is a refusal the consumer
        // decides on its own.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: true));

        await consumer.OnReceivedAsync(this, Delivery("no-such-type"));

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("parked", m.Tags["disposition"]);
        Assert.Equal("refused", m.Tags["reason"]);
    }

    [Fact]
    public async Task TheQueueTagIsThisConsumersQueue()
    {
        // Both series are filtered by queue on every board. A consumer reporting someone else's
        // queue name would put the API's deliveries on the orchestrator's panels.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: false));

        await consumer.OnReceivedAsync(this, Delivery());

        Assert.Equal(Queue, TheOnlyConsumedMeasurement(metrics).Tags["queue"]);
        Assert.Equal(Queue, TheOnlyConsumerDurationMeasurement(metrics).Tags["queue"]);
    }
}
