using BaseConsole.Core.Gating;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The server states that clear on their own. Before the in-process post hop, a full or failing-over
/// store refused a write on the post queue's own delivery; now the refusal lands inside the dispatch,
/// and parking it would lose a branch the store would have accepted a minute later.
/// </summary>
public sealed class ConsoleL2FaultClassifierTests
{
    [Theory]
    [InlineData("OOM command not allowed when used memory > 'maxmemory'.")]
    [InlineData("READONLY You can't write against a read only replica.")]
    [InlineData("LOADING Redis is loading the dataset in memory")]
    [InlineData("BUSY Redis is busy running a script.")]
    public void AServerStateThatClearsOnItsOwnIsTransient(string message)
    {
        Assert.True(L2FaultClassifier.IsTransient(new RedisServerException(message)));
        Assert.Equal(DeliveryDisposition.RequeueAndTrip,
                     DeliveryClassifier.Classify(new RedisServerException(message)));
    }

    [Theory]
    [InlineData("NOPERM this user has no permissions to run the 'copy' command")]
    [InlineData("ERR unknown command 'COPY'")]
    [InlineData("WRONGTYPE Operation against a key holding the wrong kind of value")]
    [InlineData("BUSYGROUP Consumer Group name already exists")]
    public void ARejectedCommandIsStillDeterministic(string message)
        => Assert.False(L2FaultClassifier.IsTransient(new RedisServerException(message)));

    [Fact]
    public void AWrappedServerStateIsStillFound()
        => Assert.True(L2FaultClassifier.IsTransient(
            new InvalidOperationException("outer", new RedisServerException("OOM full"))));
}
