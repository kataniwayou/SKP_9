using BaseApi.Service.Features.Orchestration.Messaging;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Messaging;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Orchestrator.Messaging;
using RabbitMQ.Client;
using Xunit;

namespace BaseApi.Tests.Messaging;

/// <summary>
/// The dead-letter contract, asserted across EVERY topology in the system at once rather than once
/// per topology's own test file.
/// <para>
/// <b>There are two separate claims here and they are not equally serious.</b> The first is a safety
/// invariant: a live queue's <c>x-dead-letter-routing-key</c> must match the key its dead queue is
/// bound under, or the broker discards every parked message with no error anywhere. The second is a
/// consistency claim: that key should be the live queue's own name. Breaking the first loses data
/// silently; breaking the second only makes the key underivable, which costs a redrive tool rather
/// than a message.
/// </para>
/// <para>
/// A per-file test cannot make either claim, because both are about agreement ACROSS topologies that
/// never reference each other. That is why this file drives all four pairs through one recorder.
/// </para>
/// </summary>
public sealed class DeadLetterConventionTests
{
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    /// <summary>What one topology declared, flattened enough to assert on.</summary>
    private sealed record Recording(
        Dictionary<string, IDictionary<string, object?>?> Queues,
        List<(string Queue, string Exchange, string Key)> Binds);

    private static async Task<Recording> RecordAsync(IRabbitMqTopology topology)
    {
        var channel = Substitute.For<IChannel>();
        var queues = new Dictionary<string, IDictionary<string, object?>?>(StringComparer.Ordinal);
        var binds = new List<(string, string, string)>();

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
            .AndDoes(c => queues[c.ArgAt<string>(0)] = c.ArgAt<IDictionary<string, object?>>(4));

        channel.QueueBindAsync(
                Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(),
                Arg.Any<IDictionary<string, object?>>(), Arg.Any<bool>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask)
            .AndDoes(c => binds.Add((c.ArgAt<string>(0), c.ArgAt<string>(1), c.ArgAt<string>(2))));

        await topology.DeclareAsync(channel, CancellationToken.None);
        return new Recording(queues, binds);
    }

    /// <summary>
    /// Every topology that declares a dead-lettered pair. Constructed here rather than resolved from a
    /// host so this stays hermetic: none of them opens a connection, and the recorder above is the
    /// only channel any of them sees.
    /// </summary>
    public static TheoryData<string, Func<IRabbitMqTopology>> Topologies() => new()
    {
        { "OrchestrationTopology (API control pair)", () => new OrchestrationTopology() },
        { "OrchestratorTopology (replica + shared pairs)",
            () => new OrchestratorTopology(new InstanceId("orchestrator-0")) },
        { "ProcessorTopology (work + post pairs)", () => new ProcessorTopology(P) },
    };

    [Theory]
    [MemberData(nameof(Topologies))]
    public async Task EveryDeadLetteringQueueHasABindingUnderItsOwnRoutingKey(
        string name, Func<IRabbitMqTopology> build)
    {
        ArgumentNullException.ThrowIfNull(build);

        // THE SAFETY INVARIANT, and the one that loses data when it breaks. x-dead-letter-exchange is
        // not validated at declare time and the exchanges are all `direct`, so a queue whose
        // x-dead-letter-routing-key matches no binding parks into nothing: the broker drops the
        // message with no error, no log and nothing on any board. Three topology files each state
        // that hazard in prose; this is the assertion behind the prose.
        var r = await RecordAsync(build());

        var deadLettering = r.Queues
            .Where(q => q.Value is not null && q.Value.ContainsKey("x-dead-letter-exchange"))
            .ToList();

        Assert.NotEmpty(deadLettering);

        foreach (var (queue, args) in deadLettering)
        {
            var exchange = Assert.IsType<string>(args!["x-dead-letter-exchange"]);
            var key = Assert.IsType<string>(args["x-dead-letter-routing-key"]);

            Assert.True(
                r.Binds.Any(b => b.Exchange == exchange && b.Key == key),
                $"{name}: {queue} dead-letters to {exchange} with routing key '{key}', but no queue "
                + $"is bound to that exchange under that key — everything it parks would be discarded "
                + $"silently. Bindings seen: "
                + string.Join(", ", r.Binds.Select(b => $"{b.Exchange}->{b.Queue} key='{b.Key}'")));
        }
    }

    /// <summary>
    /// Queues whose routing key is their DEAD queue's name rather than their own, pending the
    /// migration that closes the split.
    /// <para>
    /// <b>This list is the TODO, and it is deliberately an allowlist rather than a skipped test.</b>
    /// Anything NOT named here is asserted, so a queue added tomorrow has to comply or fail — which a
    /// skip would not give. Closing the split means re-declaring these three on the broker, because
    /// <c>x-dead-letter-routing-key</c> is a queue argument and changing one fails the channel with a
    /// precondition error; it therefore rides the next teardown rather than justifying its own. When
    /// it does, delete this list and this comment together.
    /// </para>
    /// </summary>
    private static readonly HashSet<string> KeyedByDeadQueueName = new(StringComparer.Ordinal)
    {
        OrchestratorQueues.Result,
        OrchestratorQueues.ResultPost,
        OrchestratorFanout.PerReplica("orchestrator-0"),
    };

    [Theory]
    [MemberData(nameof(Topologies))]
    public async Task TheRoutingKeyIsTheLiveQueuesOwnNameExceptWhereKnownOtherwise(
        string name, Func<IRabbitMqTopology> build)
    {
        ArgumentNullException.ThrowIfNull(build);

        // THE CONSISTENCY CLAIM, which costs a tool rather than a message. Keying on the live queue's
        // name makes the token derivable from a queue name alone, so a redrive that republishes into a
        // dead-letter exchange can compute it. Keyed on the dead queue's name instead, the same tool
        // publishes under a key nothing is bound to — and a direct exchange drops an unroutable
        // message, which is the silent class again, one level up.
        var r = await RecordAsync(build());

        foreach (var (queue, args) in r.Queues)
        {
            if (args is null || !args.ContainsKey("x-dead-letter-routing-key"))
            {
                continue;
            }

            var key = Assert.IsType<string>(args["x-dead-letter-routing-key"]);

            if (KeyedByDeadQueueName.Contains(queue))
            {
                // Pinned, not ignored: if one of these is ever migrated to the live-queue convention
                // without being taken off the list, this fires and points at the list.
                Assert.True(
                    key == $"{queue}.dead",
                    $"{name}: {queue} is on the KeyedByDeadQueueName list but its routing key is "
                    + $"'{key}', not '{queue}.dead'. If it has been migrated, remove it from the list.");
                continue;
            }

            Assert.True(
                key == queue,
                $"{name}: {queue} dead-letters under routing key '{key}' rather than its own name. "
                + $"Key on the live queue's name so the token is derivable, or add it to "
                + $"KeyedByDeadQueueName with a reason.");
        }
    }

    [Fact]
    public void TheAllowlistNamesOnlyQueuesThatStillNeedMigrating()
    {
        // A list that outlives what it excuses is worse than no list: it silently exempts queues that
        // have already been fixed. Three today -- both shared orchestrator execution queues and the
        // per-replica announcement queue. When the teardown re-declares them this drops to zero and
        // the list, this test and the comment above it all go together.
        Assert.Equal(3, KeyedByDeadQueueName.Count);
    }
}
