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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeclaresBothPairsWithTheSameArguments(bool post)
    {
        // The work pair and the post pair are declared by one helper, so the thing worth pinning is
        // that BOTH come out identical apart from their names. A post queue that quietly lost its
        // dead-letter exchange would discard every branch it refused, with no error anywhere.
        var channel = Substitute.For<IChannel>();
        var args = new Dictionary<string, IDictionary<string, object?>?>(StringComparer.Ordinal);

        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)))
            .AndDoes(ci => args[ci.ArgAt<string>(0)] = ci.ArgAt<IDictionary<string, object?>>(4));

        await new ProcessorTopology(P).DeclareAsync(channel, CancellationToken.None);

        var live = post ? ProcessorQueues.Post(P) : ProcessorQueues.Work(P);
        var dead = post ? ProcessorQueues.PostDead(P) : ProcessorQueues.Dead(P);

        var liveArgs = args[live]!;
        Assert.Equal("quorum", liveArgs["x-queue-type"]);
        Assert.Equal(-1, liveArgs["x-delivery-limit"]);
        Assert.Equal(ProcessorQueues.DeadLetterExchange, liveArgs["x-dead-letter-exchange"]);
        // The routing key is the LIVE queue's own name — this assembly's existing convention, kept so
        // the two pairs agree with each other and with what is already on the broker.
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
        // One exchange serves both pairs, so the routing key is the only thing separating them. Get it
        // wrong and a refused dispatch and a refused branch land in the same queue, or in neither.
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
        Assert.Contains(
            (ProcessorQueues.PostDead(P), ProcessorQueues.DeadLetterExchange, ProcessorQueues.Post(P)),
            binds);
        Assert.Equal(2, binds.Count);
    }

    [Fact]
    public void TheTwoPairsNeverShareAName()
    {
        // The whole change is worthless if these collapse to one string, and a typo in either format
        // would do it silently — the topology would declare one queue twice, idempotently, and the
        // branch hop would go back to sharing the author's lane with nothing to report it.
        Assert.NotEqual(ProcessorQueues.Work(P), ProcessorQueues.Post(P));
        Assert.NotEqual(ProcessorQueues.Dead(P), ProcessorQueues.PostDead(P));
        Assert.Equal($"{ProcessorQueues.Post(P)}.dead", ProcessorQueues.PostDead(P));
    }
}
