using BaseApi.Tests.Live.Resilience;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// The one part of the wedge lever that can be tested without a cluster, and the part most likely
/// to be quietly wrong.
/// <para>
/// <b>The peer_host match must be exact.</b> Pod IPs on this cluster share prefixes —
/// <c>10.244.0.20</c> is a prefix of <c>10.244.0.205</c> — so a <c>StartsWith</c> or
/// <c>Contains</c> match would disconnect a replica the scenario did not name, or every replica at
/// once, which is scenario S7 rather than this one. A scenario that injects the wrong fault and
/// passes is the worst failure available to a resilience suite.
/// </para>
/// </summary>
public sealed class RabbitConnectionListTests
{
    /// <summary>Real output shape, captured from RabbitMQ 4.1.8 on this cluster.</summary>
    private const string Listing = """
        pid	name	peer_host
        <rabbit@rabbitmq-0.1787531233.1054.0>	10.244.0.168:52012 -> 10.244.0.198:5672	10.244.0.168
        <rabbit@rabbitmq-0.1787531233.46278.0>	10.244.0.205:37236 -> 10.244.0.198:5672	10.244.0.205
        <rabbit@rabbitmq-0.1787531233.513984.0>	10.244.0.206:51900 -> 10.244.0.198:5672	10.244.0.206
        """;

    [Fact]
    public void SelectsTheConnectionBelongingToOneHost()
    {
        var pids = ClusterControl.ParseConnectionPids(Listing, "10.244.0.205");

        Assert.Equal(["<rabbit@rabbitmq-0.1787531233.46278.0>"], pids);
    }

    [Fact]
    public void SkipsTheHeaderRow()
    {
        // "peer_host" is the header's own value in the column being matched; a parser that did not
        // skip the header would return the literal string "pid" as a connection to close.
        Assert.Empty(ClusterControl.ParseConnectionPids(Listing, "peer_host"));
    }

    [Fact]
    public void DoesNotMatchAHostThatIsMerelyAPrefix()
    {
        // The whole reason this function is unit-tested. 10.244.0.20 is a prefix of two real pod
        // IPs in the listing above and is itself nobody's address.
        Assert.Empty(ClusterControl.ParseConnectionPids(Listing, "10.244.0.20"));
    }

    [Fact]
    public void ReturnsEveryConnectionAHostHolds()
    {
        // A replica holding two connections must have both closed, or the consumer survives on the
        // one that was missed and the scenario silently injects nothing.
        const string twoForOneHost = """
            pid	name	peer_host
            <rabbit@rabbitmq-0.1.1.0>	10.244.0.205:1 -> 10.244.0.198:5672	10.244.0.205
            <rabbit@rabbitmq-0.1.2.0>	10.244.0.205:2 -> 10.244.0.198:5672	10.244.0.205
            """;

        var pids = ClusterControl.ParseConnectionPids(twoForOneHost, "10.244.0.205");

        Assert.Equal(["<rabbit@rabbitmq-0.1.1.0>", "<rabbit@rabbitmq-0.1.2.0>"], pids);
    }

    [Fact]
    public void ReturnsEmptyWhenTheHostHoldsNothing()
    {
        // Not an error: a replica whose connection is already closed is the steady state this lever
        // maintains, so the keepalive must tolerate finding nothing to close.
        Assert.Empty(ClusterControl.ParseConnectionPids(Listing, "10.244.0.99"));
    }

    [Fact]
    public void IgnoresBlankAndMalformedLines()
    {
        const string ragged = "pid\tname\tpeer_host\n\n<rabbit@x.1.0>\t10.244.0.205:1 -> y\t10.244.0.205\nnot-a-row\n\n";

        Assert.Equal(["<rabbit@x.1.0>"], ClusterControl.ParseConnectionPids(ragged, "10.244.0.205"));
    }
}
