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
}
