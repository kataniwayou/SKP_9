using BaseApi.Tests.Support;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;
using Xunit;

using ApiConsumer = BaseApi.Core.Messaging.GatedQueueConsumer;
using ApiGate = BaseApi.Core.Gating.L2Gate;
using ApiOptions = BaseApi.Core.Messaging.GatedConsumerOptions;
using ConsoleConsumer = BaseConsole.Core.Messaging.GatedQueueConsumer;
using ConsoleGate = BaseConsole.Core.Gating.L2Gate;
using ConsoleOptions = BaseConsole.Core.Messaging.GatedConsumerOptions;

namespace BaseApi.Tests.Messaging;

/// <summary>
/// Drives BOTH copies of <c>GatedQueueConsumer</c> through the same scenarios and asserts they
/// report a delivery identically.
/// <para>
/// <b>The guard for a defect that already shipped once.</b> BaseApi.Core and BaseConsole.Core each
/// carry their own consumer AND their own <c>DeliveryClassifier</c>, so the disposition a delivery
/// gets is decided by duplicated code on both sides. Every consumer test in the suite drove the
/// BaseConsole copy, which is how the API's copy came to be missing the escape arm entirely: an
/// escaping delivery was timed by <c>pipeline.consumer.duration</c> and counted by nothing. No test
/// failed, because no test looked.
/// </para>
/// <para>
/// This asserts EQUALITY between the twins rather than expected values per host. That is the point:
/// a row asserting <c>("requeued", "gate_closed")</c> twice can be updated on one side and left on
/// the other, which is the same failure one level up. Equality cannot be half-updated — changing
/// one copy's behaviour fails here until the other changes with it, or until someone deletes the
/// row and says why.
/// </para>
/// <para>
/// The four duplicated types are aliased above rather than reconciled. Unifying the hosts is a real
/// refactor and this is not it — this is the seam that makes the duplication safe to keep.
/// </para>
/// </summary>
public sealed class ConsumerTwinParityTests
{
    private const string Queue = "twin-parity";
    private const string Type = "step-outcome";

    /// <summary>What the handler does, which is what the classifier then has to rule on.</summary>
    public enum Fault
    {
        None,
        StoreUnreachable,
        TransientSend,
        Deterministic,
    }

    /// <summary>One host's report of a single delivery, in the terms both hosts must agree on.</summary>
    private sealed record Report(
        string Disposition,
        string Reason,
        string Queue,
        string Type,
        string DurationDisposition,
        bool Escaped);

    private sealed class Latch : IConsumerAdmission
    {
        public bool IsOpen { get; set; } = true;
    }

    private sealed class Handler(Func<Task> body) : IQueueMessageHandler
    {
        public string MessageType => Type;
        public Task HandleAsync(ReadOnlyMemory<byte> body_, CancellationToken ct) => body();
    }

    private static BasicDeliverEventArgs Delivery(string type) =>
        new("consumer-tag", deliveryTag: 1UL, redelivered: false,
            exchange: "", routingKey: Queue,
            properties: new BasicProperties { Type = type },
            body: ReadOnlyMemory<byte>.Empty);

    private static Func<Task> Body(Fault fault) => fault switch
    {
        Fault.StoreUnreachable => () => throw new RedisConnectionException(
            ConnectionFailureType.UnableToConnect, "down"),
        Fault.TransientSend => () => throw new TransientSendException(
            "broker blip", new IOException("connection reset")),
        Fault.Deterministic => () => throw new InvalidOperationException(
            "will fail identically forever"),
        _ => () => Task.CompletedTask,
    };

    private static RabbitMqConnection Connection() =>
        new(Options.Create(new RabbitMqOptions()),
            Array.Empty<IRabbitMqTopology>(),
            NullLogger<RabbitMqConnection>.Instance);

    private static IServiceScopeFactory Scopes(params IQueueMessageHandler[] handlers)
    {
        var services = new ServiceCollection();
        foreach (var handler in handlers)
        {
            services.AddSingleton(handler);
        }

        return services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
    }

    private static Report Read(MetricCollector metrics, bool escaped)
    {
        var consumed = Assert.Single(metrics.For("pipeline.messages.consumed"));
        var duration = Assert.Single(metrics.For(IngressMetrics.ConsumerDurationInstrument));

        return new Report(
            consumed.Tags["disposition"],
            consumed.Tags["reason"],
            consumed.Tags["queue"],
            consumed.Tags["type"],
            duration.Tags["disposition"],
            escaped);
    }

    private static async Task<Report> RunApiAsync(bool gateOpen, string type, Fault fault, bool trip)
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        var gate = new ApiGate(NullLogger<ApiGate>.Instance);
        if (gateOpen)
        {
            await gate.ReportHealthyAsync();
        }

        if (trip)
        {
            gate.StateChanged += _ => throw new InvalidOperationException("subscriber blew up");
        }

        var consumer = new ApiConsumer(
            Connection(),
            gate,
            Scopes(fault == Fault.None && type != Type ? [] : [new Handler(Body(fault))]),
            Options.Create(new ApiOptions { Queue = Queue }),
            NullLogger<ApiConsumer>.Instance);

        var escaped = false;
        try
        {
            await consumer.OnReceivedAsync(new object(), Delivery(type));
        }
        catch (InvalidOperationException)
        {
            escaped = true;
        }

        return Read(metrics, escaped);
    }

    private static async Task<Report> RunConsoleAsync(bool gateOpen, string type, Fault fault, bool trip)
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        var gate = new ConsoleGate(NullLogger<ConsoleGate>.Instance);
        if (gateOpen)
        {
            await gate.ReportHealthyAsync();
        }

        if (trip)
        {
            gate.StateChanged += _ => throw new InvalidOperationException("subscriber blew up");
        }

        var consumer = new ConsoleConsumer(
            Connection(),
            gate,
            Scopes(fault == Fault.None && type != Type ? [] : [new Handler(Body(fault))]),
            Options.Create(new ConsoleOptions { Queue = Queue }),
            new Latch(),
            NullLogger<ConsoleConsumer>.Instance);

        var escaped = false;
        try
        {
            await consumer.OnReceivedAsync(new object(), Delivery(type));
        }
        catch (InvalidOperationException)
        {
            escaped = true;
        }

        return Read(metrics, escaped);
    }

    public static TheoryData<string, bool, string, Fault, bool> Scenarios() => new()
    {
        // name                  gateOpen  type          fault                    subscriber throws
        { "gate closed",         false,    Type,         Fault.None,              false },
        { "handled",             true,     Type,         Fault.None,              false },
        { "store unreachable",   true,     Type,         Fault.StoreUnreachable,  false },
        { "transient send",      true,     Type,         Fault.TransientSend,     false },
        { "deterministic fault", true,     Type,         Fault.Deterministic,     false },
        { "no handler",          true,     "no-such-type", Fault.None,            false },
        { "no type header",      true,     "",           Fault.None,              false },
        // The row that would have caught the shipped defect. The store-unreachable arm trips the
        // gate BEFORE it records, so a subscriber that throws escapes with nothing counted unless
        // the outer catch exists on that side.
        { "escapes the callback", true,    Type,         Fault.StoreUnreachable,  true },
    };

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task BothTwinsReportTheSameDelivery(
        string name, bool gateOpen, string type, Fault fault, bool trip)
    {
        var api = await RunApiAsync(gateOpen, type, fault, trip);
        var console = await RunConsoleAsync(gateOpen, type, fault, trip);

        Assert.Equal(console, api);

        // Named so a failure says WHICH row diverged, since the records render as one blob.
        Assert.True(api == console, $"twins disagree on '{name}': api={api}, console={console}");
    }

    [Fact]
    public async Task TheEscapeRowActuallyEscapesOnBothSides()
    {
        // Guards the guard. If the subscriber stopped throwing -- or the arm that trips the gate
        // moved -- the escape row above would still pass, comparing two identical NON-escapes and
        // asserting nothing about the arm it exists for.
        var api = await RunApiAsync(true, Type, Fault.StoreUnreachable, trip: true);
        var console = await RunConsoleAsync(true, Type, Fault.StoreUnreachable, trip: true);

        Assert.True(api.Escaped, "the api twin did not escape, so the escape row proves nothing");
        Assert.True(console.Escaped, "the console twin did not escape, so the escape row proves nothing");
        Assert.Equal("escaped", api.Reason);
        Assert.Equal("escaped", console.Reason);
    }
}
