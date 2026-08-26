using BaseApi.Tests.Support;
using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// Joins <see cref="EnvironmentCollection"/>: <see cref="DeadLetterReadSignal"/> is one static signal
/// for the whole process with no per-test tag to filter by, so any test calling <c>Reset()</c> or
/// <c>Request()</c> concurrently with these would race them rather than merely coexist, the way two
/// metrics tests asserting different tag values can.
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class DeadLetterReadSignalTests
{
    [Fact]
    public async Task ARequestCompletesTheWaitAndAResetArmsItAgain()
    {
        DeadLetterReadSignal.Reset();
        var first = DeadLetterReadSignal.Requested;
        Assert.False(first.IsCompleted);

        DeadLetterReadSignal.Request();
        await first;   // completes, or the test times out

        // Reset replaces the source rather than clearing it, mirroring L2Gate.Tripped: a waiter
        // holding the old task must not be re-armed out from under itself.
        DeadLetterReadSignal.Reset();
        Assert.False(DeadLetterReadSignal.Requested.IsCompleted);
        Assert.True(first.IsCompleted);
    }

    [Fact]
    public void RepeatedRequestsBeforeAResetAreOneRequest()
    {
        DeadLetterReadSignal.Reset();

        DeadLetterReadSignal.Request();
        DeadLetterReadSignal.Request();

        // A burst of parks must not queue a burst of broker round trips. One pending read is
        // enough -- it will see whatever the queue holds by the time it runs.
        Assert.True(DeadLetterReadSignal.Requested.IsCompleted);
    }
}
