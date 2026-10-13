using BaseProcessor.Core.Messaging;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using RabbitMQ.Client;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorTopologyTests
{
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public async Task DeclaresTheExchangeBeforeTheQueueThatNamesIt()
    {
        // The dead-letter argument is not validated at declare time, so a queue pointing at a missing
        // exchange is accepted and silently discards everything it parks — the failure has no error
        // anywhere and simply makes "a parked message is recoverable" untrue.
        var channel = Substitute.For<IChannel>();
        var order = new List<string>();

        // The real IChannel signatures (RabbitMQ.Client 7.1.2) match the brief's guessed 8-parameter
        // shape and argument order exactly — including the nullability of `arguments`
        // (IDictionary<string, object?>?). The one real difference is that QueueDeclareAsync returns
        // Task<QueueDeclareOk>, not Task, so a return value must be configured for the await inside
        // ProcessorTopology.DeclareAsync to be safe. Configuring via Returns(...).AndDoes(...) is the
        // idiomatic NSubstitute shape for "return this AND run a side effect", which is clearer here
        // than awaiting the bare configuration call the brief sketched.
        channel.ExchangeDeclareAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask)
            .AndDoes(ci => order.Add($"exchange:{ci.ArgAt<string>(0)}"));

        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)))
            .AndDoes(ci => order.Add($"queue:{ci.ArgAt<string>(0)}"));

        await new ProcessorTopology(P).DeclareAsync(channel, CancellationToken.None);

        Assert.Equal($"exchange:{ProcessorQueues.DeadLetterExchange}", order[0]);
        Assert.Contains($"queue:{ProcessorQueues.Work(P)}", order);
        Assert.True(order.IndexOf($"exchange:{ProcessorQueues.DeadLetterExchange}")
                    < order.IndexOf($"queue:{ProcessorQueues.Work(P)}"));
    }

    [Fact]
    public async Task TheWorkQueueCarriesNoDeliveryLimit()
    {
        // This consumer requeues on purpose for the whole duration of a store outage. A delivery limit
        // counts every redelivery, so a long outage would dead-letter work that was never malformed.
        var channel = Substitute.For<IChannel>();
        IDictionary<string, object?>? args = null;

        // Generic default configured first, then overridden for the exact work-queue name second:
        // NSubstitute resolves overlapping call specs most-recently-configured-first, so the specific
        // one below is what actually matches the work-queue declare and captures its arguments.
        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)));

        channel.QueueDeclareAsync(
                ProcessorQueues.Work(P), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk(ProcessorQueues.Work(P), 0, 0)))
            .AndDoes(ci => args = ci.ArgAt<IDictionary<string, object?>>(4));

        await new ProcessorTopology(P).DeclareAsync(channel, CancellationToken.None);

        Assert.NotNull(args);
        // Present and -1 (unlimited), not absent: RabbitMQ 4.x defaults a quorum queue declaring no
        // limit to 20, so asserting absence would pass while the broker capped redeliveries at twenty.
        Assert.Equal(-1, args!["x-delivery-limit"]);
        Assert.Equal(ProcessorQueues.DeadLetterExchange, args["x-dead-letter-exchange"]);
    }

    [Fact]
    public async Task DeclaresTheWorkPairWithTheDeadLetterArgumentsAndNothingElse()
    {
        // A work queue that quietly lost its dead-letter exchange would discard every dispatch it
        // refused, with no error anywhere. It is also the ONLY pair declared: the post pair went with
        // the in-process post hop, and a redeclare would recreate a queue nothing consumes.
        var channel = Substitute.For<IChannel>();
        var args = new Dictionary<string, IDictionary<string, object?>?>(StringComparer.Ordinal);

        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)))
            .AndDoes(ci => args[ci.ArgAt<string>(0)] = ci.ArgAt<IDictionary<string, object?>>(4));

        await new ProcessorTopology(P).DeclareAsync(channel, CancellationToken.None);

        var live = ProcessorQueues.Work(P);
        var dead = ProcessorQueues.Dead(P);

        Assert.Equal(2, args.Count);
        Assert.DoesNotContain(args.Keys, q => q.Contains("-post", StringComparison.Ordinal));

        var liveArgs = args[live]!;
        Assert.Equal("quorum", liveArgs["x-queue-type"]);
        Assert.Equal(-1, liveArgs["x-delivery-limit"]);
        Assert.Equal(ProcessorQueues.DeadLetterExchange, liveArgs["x-dead-letter-exchange"]);
        // The routing key is the LIVE queue's own name — this assembly's existing convention, kept so
        // it agrees with what is already on the broker.
        Assert.Equal(live, liveArgs["x-dead-letter-routing-key"]);

        var deadArgs = args[dead]!;
        Assert.Equal("quorum", deadArgs["x-queue-type"]);
        Assert.Equal(-1, deadArgs["x-delivery-limit"]);
        // A dead queue parks nothing of its own, so it names no dead-letter exchange.
        Assert.False(deadArgs.ContainsKey("x-dead-letter-exchange"));
    }

    [Fact]
    public async Task BindsEachDeadQueueUnderItsOwnLiveQueuesName()
    {
        // The routing key is what ties a refused dispatch to its dead queue. Get it wrong and the
        // message lands in the wrong queue, or in none.
        var channel = Substitute.For<IChannel>();
        var binds = new List<(string Queue, string Exchange, string Key)>();

        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)));

        channel.QueueBindAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask)
            .AndDoes(ci => binds.Add(
                (ci.ArgAt<string>(0), ci.ArgAt<string>(1), ci.ArgAt<string>(2))));

        await new ProcessorTopology(P).DeclareAsync(channel, CancellationToken.None);

        Assert.Contains(
            (ProcessorQueues.Dead(P), ProcessorQueues.DeadLetterExchange, ProcessorQueues.Work(P)),
            binds);
        Assert.Single(binds);
    }
}
