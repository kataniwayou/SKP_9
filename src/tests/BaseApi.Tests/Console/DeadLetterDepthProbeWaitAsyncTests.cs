using System.Reflection;
using BaseApi.Tests.Support;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// Exercises <c>DeadLetterDepthProbe.WaitAsync</c> itself, not just <see cref="DeadLetterReadSignal"/>
/// in isolation -- the override is where the "wake on park, reset only because of the park" contract
/// actually lives, and a signal that behaves correctly on its own says nothing about whether the probe
/// is wired to it.
/// <para>
/// <b>Reflection, not a test subclass.</b> <see cref="DeadLetterDepthProbe"/> is sealed and
/// <c>WaitAsync</c> is <c>protected</c>, so there is no seam to call it through directly. The
/// alternative -- running the whole <c>ExecuteAsync</c> loop against a real or fake broker connection
/// -- would test the passive-declare plumbing <see cref="QueueStatsProbeHeartbeatTests"/> already
/// covers and say nothing more about this contract. Invoking the protected method directly tests the
/// exact code that ships, with nothing reimplemented in the test.
/// </para>
/// <para>
/// <b>Joins <see cref="EnvironmentCollection"/>.</b> <see cref="DeadLetterReadSignal"/> is one static
/// signal for the whole process with no per-test tag to filter by -- unlike the metric instruments
/// <see cref="EnvironmentCollection"/> already serialises, there is no value here that "nothing else
/// emits". Any test that calls <c>Reset()</c> or <c>Request()</c> concurrently with these would race
/// them, so this class must be serialised against every other test touching the same static.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class DeadLetterDepthProbeWaitAsyncTests
{
    private static readonly MethodInfo WaitAsyncMethod =
        typeof(DeadLetterDepthProbe).GetMethod("WaitAsync", BindingFlags.NonPublic | BindingFlags.Instance)
        ?? throw new InvalidOperationException("DeadLetterDepthProbe.WaitAsync not found by reflection");

    private static DeadLetterDepthProbe NewProbe() =>
        new(
            new RabbitMqConnection(
                Options.Create(new RabbitMqOptions()),
                Array.Empty<IRabbitMqTopology>(),
                NullLogger<RabbitMqConnection>.Instance),
            ["q.dead"],
            TimeSpan.FromSeconds(30),
            NullLogger<DeadLetterDepthProbe>.Instance);

    private static Task InvokeWaitAsync(DeadLetterDepthProbe probe, TimeSpan interval, CancellationToken ct) =>
        (Task)WaitAsyncMethod.Invoke(probe, [interval, ct])!;

    [Fact]
    public async Task APendingRequestWakesTheWaitLongBeforeTheIntervalAndThenResetsIt()
    {
        DeadLetterReadSignal.Reset();
        DeadLetterReadSignal.Request();

        var probe = NewProbe();

        // Thirty seconds is the production interval for this probe. If the signal were ignored, this
        // would take that long -- the two-second cap is what makes an ignored signal fail loudly
        // rather than just slowly.
        var wait = InvokeWaitAsync(probe, TimeSpan.FromSeconds(30), CancellationToken.None);
        await wait.WaitAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken);

        // Woke because of the request, so the signal must be re-armed for the next park.
        Assert.False(DeadLetterReadSignal.Requested.IsCompleted);
    }

    [Fact]
    public async Task TheIntervalWinningWithNoRequestLeavesTheSignalUntouched()
    {
        DeadLetterReadSignal.Reset();
        var before = DeadLetterReadSignal.Requested;

        var probe = NewProbe();

        var wait = InvokeWaitAsync(probe, TimeSpan.FromMilliseconds(30), CancellationToken.None);
        await wait.WaitAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken);

        // Nothing was requested, so the clock is what woke this pass. Resetting here anyway would be
        // harmless this time, but only because nothing raced it -- the real hazard, documented on
        // DeadLetterDepthProbe.WaitAsync, is a park landing in the gap this would otherwise open. The
        // same task instance proves Reset() was not called.
        Assert.Same(before, DeadLetterReadSignal.Requested);
        Assert.False(DeadLetterReadSignal.Requested.IsCompleted);
    }
}
