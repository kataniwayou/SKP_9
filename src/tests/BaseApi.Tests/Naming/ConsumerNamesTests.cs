using System.Text;
using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Messaging;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class ConsumerNamesTests
{
    private const string Queue = "names-test";
    private const string Type = "step-outcome";

    private static readonly Guid W = Guid.Parse("11111111-1111-1111-aaaa-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-bbbb-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-cccc-333333333333");

    private static readonly Dictionary<Guid, string> Known = new()
    {
        [W] = "chain_1.0.0-aaaa-111111111111",
        [S] = "step-a_1.0.0-bbbb-222222222222",
        [P] = "proc_1.2.0-cccc-333333333333",
    };

    /// <summary>A handler that logs through its OWN category, as real handlers do, then does what the test asks.</summary>
    private sealed class Handler(ILogger logger, Func<Task> body) : IQueueMessageHandler
    {
        public string MessageType => Type;

        public async Task HandleAsync(ReadOnlyMemory<byte> body_, CancellationToken ct)
        {
            logger.LogInformation("the handler ran");
            await body();
        }
    }

    private sealed class Latch : IConsumerAdmission
    {
        public bool IsOpen { get; set; } = true;
    }

    private static BasicDeliverEventArgs Delivery(IDictionary<string, object?>? headers) =>
        new("consumer-tag", deliveryTag: 1UL, redelivered: false, exchange: "", routingKey: Queue,
            properties: new BasicProperties { Type = Type, Headers = headers },
            body: ReadOnlyMemory<byte>.Empty);

    private static Dictionary<string, object?> AllIds() => new()
    {
        [MessageIdHeaders.WorkflowId] = W.ToString("D"),
        [MessageIdHeaders.StepId] = Encoding.UTF8.GetBytes(S.ToString("D")),
        [MessageIdHeaders.ProcessorId] = P.ToString("D"),
    };

    private static async Task<GatedQueueConsumer> Consumer(SharedLog log, IEntityNameSource source, Func<Task> body)
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        await gate.ReportHealthyAsync();

        var services = new ServiceCollection();
        services.AddSingleton<IQueueMessageHandler>(new Handler(log.For<Handler>(), body));

        return new GatedQueueConsumer(
            new RabbitMqConnection(Options.Create(new RabbitMqOptions()), Array.Empty<IRabbitMqTopology>(),
                NullLogger<RabbitMqConnection>.Instance),
            gate,
            services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new GatedConsumerOptions { Queue = Queue }),
            new Latch(),
            log.For<GatedQueueConsumer>(),
            new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance));
    }

    [Fact]
    public async Task ARecordInsideTheHandlerCarriesAllThreeNames()
    {
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)), () => Task.CompletedTask);

        await consumer.OnReceivedAsync(this, Delivery(AllIds()));

        var scope = log.ScopeOf("the handler ran");
        Assert.Equal(Known[W], scope[EntityNames.WorkflowName]);
        Assert.Equal(Known[S], scope[EntityNames.StepName]);
        Assert.Equal(Known[P], scope[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task TheParkLineCarriesTheNamesAfterTheHandlerThrew()
    {
        // Review focus 1: logged in the consumer's catch, after the unwinding exception disposed every
        // scope opened inside the try.
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)),
            () => throw new InvalidOperationException("deterministic"));

        await consumer.OnReceivedAsync(this, Delivery(AllIds()));

        var scope = log.ScopeOf(RefusalTemplates.Parked.Split('{')[0]);
        Assert.Equal(Known[W], scope[EntityNames.WorkflowName]);
        Assert.Equal(Known[S], scope[EntityNames.StepName]);
        Assert.Equal(Known[P], scope[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task AFanoutControlMessageCarriesOnlyTheWorkflowName()
    {
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)), () => Task.CompletedTask);

        await consumer.OnReceivedAsync(this,
            Delivery(new Dictionary<string, object?> { [MessageIdHeaders.WorkflowId] = W.ToString("D") }));

        var scope = log.ScopeOf("the handler ran");
        Assert.Equal(Known[W], scope[EntityNames.WorkflowName]);
        Assert.False(scope.ContainsKey(EntityNames.StepName));
    }

    [Fact]
    public async Task AnUnreachableStoreStillHandlesTheDeliveryWithFallbacks()
    {
        // Review focus 2.
        var log = new SharedLog();
        var ran = false;
        var consumer = await Consumer(log,
            new FakeNameSource { Fault = new RedisConnectionException(ConnectionFailureType.SocketFailure, "down") },
            () => { ran = true; return Task.CompletedTask; });

        await consumer.OnReceivedAsync(this, Delivery(AllIds()));

        Assert.True(ran);
        Assert.Equal(EntityNames.Fallback(S), log.ScopeOf("the handler ran")[EntityNames.StepName]);
        Assert.True(consumer.ShouldConsume);   // the gate was not tripped
    }

    [Fact]
    public async Task ADeliveryWithNoIdHeadersGetsNoNames()
    {
        // Review focus 4.
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)), () => Task.CompletedTask);

        await consumer.OnReceivedAsync(this, Delivery(null));

        var scope = log.ScopeOf("the handler ran");
        Assert.False(scope.ContainsKey(EntityNames.WorkflowName));
        Assert.False(scope.ContainsKey(EntityNames.StepName));
        Assert.False(scope.ContainsKey(EntityNames.ProcessorName));
    }

    [Fact]
    public async Task ANoDataBranchCarriesNamesThoughItHasNoEntryId()
    {
        // A post-handler record for a branch sent with no data: ids in headers, no x-skp-entry-id.
        var log = new SharedLog();
        var consumer = await Consumer(log, new FakeNameSource(new(Known)), () => Task.CompletedTask);
        var headers = AllIds();
        headers[MessageIdHeaders.ExecutionId] = Guid.NewGuid().ToString("D");

        await consumer.OnReceivedAsync(this, Delivery(headers));

        Assert.Equal(Known[P], log.ScopeOf("the handler ran")[EntityNames.ProcessorName]);
    }
}
