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
