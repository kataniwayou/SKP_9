using BaseApi.Service.Features.Orchestration.Messaging;
using Messaging.Contracts;
using NSubstitute;
using RabbitMQ.Client;
using Xunit;

namespace BaseApi.Tests.Orchestration;

public sealed class FanoutTopologyTests
{
    [Fact]
    public async Task DeclaresOnlyTheTwoExchangesAndNoQueue()
    {
        // "Declare no queues" is a spec invariant, not a preference: the API must not invent queues
        // for replicas that may not exist, and the replica count belongs in deployment. Nothing about
        // this type's structure would fail on its own if a future edit added a QueueDeclareAsync call
        // here, so that absence needs its own assertion rather than being merely true by inspection.
        var channel = Substitute.For<IChannel>();
        channel.ExchangeDeclareAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        await new FanoutTopology().DeclareAsync(channel, CancellationToken.None);

        // Every bool parameter has to be a matcher, not a mix of literal and Arg.Any<bool>() —
        // NSubstitute cannot otherwise tell which position a literal of the same type belongs to,
        // and throws AmbiguousArgumentsException rather than guess.
        await channel.Received(1).ExchangeDeclareAsync(
            OrchestratorFanout.Exchange, ExchangeType.Fanout,
            Arg.Is<bool>(durable => durable), Arg.Is<bool>(autoDelete => !autoDelete),
            Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<CancellationToken>());

        await channel.Received(1).ExchangeDeclareAsync(
            OrchestratorFanout.DeadLetterExchange, ExchangeType.Direct,
            Arg.Is<bool>(durable => durable), Arg.Is<bool>(autoDelete => !autoDelete),
            Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<CancellationToken>());

        await channel.DidNotReceive().QueueDeclareAsync(
            Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<bool>(),
            Arg.Any<CancellationToken>());
    }
}
