using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using NSubstitute;
using Orchestrator.Messaging;
using RabbitMQ.Client;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

public sealed class OrchestratorTopologyTests
{
    [Fact]
    public async Task DeclaresTheDeadLetterExchangeBeforeTheQueueThatNamesIt()
    {
        // The dead-letter argument is not validated at declare time, so a queue pointing at a missing
        // exchange is accepted and silently discards everything it parks — the failure has no error
        // anywhere and simply makes "a parked message is recoverable" untrue.
        var channel = Substitute.For<IChannel>();
        var order = new List<string>();

        // The real IChannel signatures (RabbitMQ.Client 7.1.2), pinned by ProcessorTopologyTests.
        // QueueDeclareAsync returns Task<QueueDeclareOk>, not Task, so a return value must be
        // configured for the await inside OrchestratorTopology.DeclareAsync to be safe.
        channel.ExchangeDeclareAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask)
            .AndDoes(c => order.Add($"exchange:{c.ArgAt<string>(0)}"));

        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)))
            .AndDoes(c => order.Add($"queue:{c.ArgAt<string>(0)}"));

        await new OrchestratorTopology(new InstanceId("orchestrator-0"))
            .DeclareAsync(channel, CancellationToken.None);

        var dlx = order.IndexOf($"exchange:{OrchestratorFanout.DeadLetterExchange}");
        var q = order.IndexOf($"queue:{OrchestratorFanout.PerReplica("orchestrator-0")}");
        Assert.True(dlx >= 0 && q > dlx, "the dead-letter exchange must be declared before the queue naming it");
    }

    [Theory]
    [InlineData(OrchestratorQueues.Result, OrchestratorQueues.ResultDead)]
    [InlineData(OrchestratorQueues.ResultPost, OrchestratorQueues.ResultPostDead)]
    public async Task DeclaresEachSharedExecutionQueueAfterTheExchangeItParksInto(string queue, string dead)
    {
        // The execution queues are shared across the deployment, unlike the announcement queue above,
        // but the ordering rule is the same and the consequence of breaking it is worse here: a result
        // this consumer refuses is the orchestrator's only record that a step could not be advanced,
        // and a queue naming an exchange that does not exist yet discards every one of them silently.
        var channel = Substitute.For<IChannel>();
        var order = new List<string>();

        channel.ExchangeDeclareAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask)
            .AndDoes(c => order.Add($"exchange:{c.ArgAt<string>(0)}"));

        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)))
            .AndDoes(c => order.Add($"queue:{c.ArgAt<string>(0)}"));

        await new OrchestratorTopology(new InstanceId("orchestrator-0"))
            .DeclareAsync(channel, CancellationToken.None);

        var dlx = order.IndexOf($"exchange:{OrchestratorQueues.DeadLetterExchange}");
        var deadQueue = order.IndexOf($"queue:{dead}");
        var work = order.IndexOf($"queue:{queue}");

        Assert.True(dlx >= 0, "the execution dead-letter exchange is never declared");
        Assert.True(deadQueue > dlx, "the dead queue must be declared after the exchange it binds to");
        Assert.True(work > deadQueue, "the work queue must be declared after the queue it parks into");
    }

    [Theory]
    [InlineData(OrchestratorQueues.Result, OrchestratorQueues.ResultDead)]
    [InlineData(OrchestratorQueues.ResultPost, OrchestratorQueues.ResultPostDead)]
    public async Task GivesEachSharedExecutionQueueItsDeadLetterArgumentsAndNoDeliveryLimit(
        string queue, string dead)
    {
        // No x-delivery-limit, matching the control queue: the limit counts every redelivery including
        // the ones the L2 gate issues through an outage, so a long one would dead-letter results that
        // were never malformed. A message the consumer genuinely refuses is parked on its first
        // delivery, which is what a limit would otherwise protect against.
        var channel = Substitute.For<IChannel>();
        var args = new Dictionary<string, IDictionary<string, object?>?>(StringComparer.Ordinal);

        channel.ExchangeDeclareAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)))
            .AndDoes(c => args[c.ArgAt<string>(0)] = c.ArgAt<IDictionary<string, object?>>(4));

        await new OrchestratorTopology(new InstanceId("orchestrator-0"))
            .DeclareAsync(channel, CancellationToken.None);

        var work = args[queue]!;
        Assert.Equal(OrchestratorQueues.DeadLetterExchange, work["x-dead-letter-exchange"]);
        Assert.Equal(dead, work["x-dead-letter-routing-key"]);
        Assert.Equal("quorum", work["x-queue-type"]);
        Assert.False(work.ContainsKey("x-delivery-limit"));
    }

    [Fact]
    public async Task BindsThisReplicasQueueToTheFanoutExchangeAndItsDeadQueueToTheDeadLetterExchange()
    {
        // The single most load-bearing line in this file, and the one nothing asserted. A bind that is
        // missing, or that names the wrong exchange, produces the failure OrchestratorFanout's own
        // remarks are written about: the queue exists, the consumer consumes it happily, every probe
        // stays green, and the replica receives nothing, forever. Neither the broker nor any other
        // test in this suite can report that, because nothing about the code's structure fails on its
        // own when a bind is absent.
        var channel = Substitute.For<IChannel>();
        var queue = OrchestratorFanout.PerReplica("orchestrator-0");
        var dead = OrchestratorFanout.Dead("orchestrator-0");

        channel.ExchangeDeclareAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)));

        await new OrchestratorTopology(new InstanceId("orchestrator-0"))
            .DeclareAsync(channel, CancellationToken.None);

        // The real arity (RabbitMQ.Client 7.1.2): queue, exchange, routingKey, arguments, noWait, ct.
        // An empty routing key because a fanout exchange ignores routing keys entirely — asserted
        // rather than left to Arg.Any, since a non-empty one here would read as though it meant
        // something.
        await channel.Received(1).QueueBindAsync(
            queue, OrchestratorFanout.Exchange, string.Empty,
            Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<CancellationToken>());

        // The dead queue binds to the DIRECT dead-letter exchange under its own name, which is the
        // routing key the queue above parks with. The two have to agree or a parked announcement is
        // discarded with nothing logged.
        await channel.Received(1).QueueBindAsync(
            dead, OrchestratorFanout.DeadLetterExchange, dead,
            Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task TheQueueArgumentsCarryTheQuorumTypeAndDeadLetterRouting()
    {
        // The ordering test above only proves the DLX exists before the queue is declared. It says
        // nothing about the arguments dictionary each QueueDeclareAsync call actually carries — and
        // that dictionary is exactly where the silent-failure surface lives: a misspelled
        // x-dead-letter-routing-key, or a queue type that is not "quorum", is accepted at declare
        // time with no error anywhere, and only shows up the day a replica is down long enough for
        // its backlog to matter.
        var channel = Substitute.For<IChannel>();
        var queue = OrchestratorFanout.PerReplica("orchestrator-0");
        var dead = OrchestratorFanout.Dead("orchestrator-0");

        channel.ExchangeDeclareAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        // Generic default configured first, then overridden per exact queue name: NSubstitute
        // resolves overlapping call specs most-recently-configured-first, so the two specific
        // configurations below are what actually match each declare call and capture its arguments —
        // one dictionary per queue, told apart by the queue name RabbitMQ.Client passes as arg 0,
        // rather than one shared variable overwritten by whichever call happens to run last.
        channel.QueueDeclareAsync(
                Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk("q", 0, 0)));

        IDictionary<string, object?>? queueArgs = null;
        channel.QueueDeclareAsync(
                queue, Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk(queue, 0, 0)))
            .AndDoes(ci => queueArgs = ci.ArgAt<IDictionary<string, object?>>(4));

        IDictionary<string, object?>? deadArgs = null;
        channel.QueueDeclareAsync(
                dead, Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new QueueDeclareOk(dead, 0, 0)))
            .AndDoes(ci => deadArgs = ci.ArgAt<IDictionary<string, object?>>(4));

        await new OrchestratorTopology(new InstanceId("orchestrator-0"))
            .DeclareAsync(channel, CancellationToken.None);

        Assert.NotNull(queueArgs);
        Assert.Equal("quorum", queueArgs!["x-queue-type"]);
        Assert.Equal(OrchestratorFanout.DeadLetterExchange, queueArgs["x-dead-letter-exchange"]);
        Assert.Equal(dead, queueArgs["x-dead-letter-routing-key"]);

        Assert.NotNull(deadArgs);
        Assert.Equal("quorum", deadArgs!["x-queue-type"]);
    }
}
