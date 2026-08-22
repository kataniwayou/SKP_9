using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// Proves the levers move before a five-minute scenario bets on them. The pause here is two
/// seconds — long enough to be real, short enough that an idle stack does not notice.
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class ClusterControlLiveTests
{
    [Fact]
    public async Task TheRedisPauseIsAcceptedAndReleased()
    {
        Chaos.SkipUnlessEnabled();

        var ct = TestContext.Current.CancellationToken;

        await ClusterControl.PauseRedisAsync(TimeSpan.FromSeconds(2), ct);
        await ClusterControl.UnpauseRedisAsync(ct);

        // The proof the release landed: a command answers immediately afterwards.
        var (exitCode, stdout, _) = await Kubectl.RunAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--", "redis-cli", "PING");

        Assert.Equal(0, exitCode);
        Assert.Contains("PONG", stdout, StringComparison.Ordinal);
    }

    /// <summary>
    /// The lever this suite refuses to use for an outage, asserted so the reason stays checked:
    /// redis runs with --save "" --appendonly no, so a restart empties L2 rather than interrupting it.
    /// </summary>
    [Fact]
    public async Task RedisIsConfiguredWithoutPersistenceWhichIsWhyScaleDownIsItsOwnScenario()
    {
        Chaos.SkipUnlessEnabled();

        var ct = TestContext.Current.CancellationToken;

        var (exitCode, stdout, _) = await Kubectl.RunAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--",
            "redis-cli", "CONFIG", "GET", "appendonly");

        Assert.Equal(0, exitCode);
        Assert.Contains("no", stdout, StringComparison.Ordinal);
    }

    /// <summary>
    /// The lever as the scenarios actually use it: held through a disposable, renewed on its
    /// keepalive, and released on disposal. The mid-window probe is what makes this more than a
    /// smoke test -- a CLIENT PAUSE that returned OK but did nothing would satisfy the other two
    /// tests, and this one is the only place a functionally inert lever would be caught.
    /// </summary>
    [Fact]
    public async Task TheHeldPauseBlocksCommandsAndReleasesOnDisposal()
    {
        Chaos.SkipUnlessEnabled();

        var ct = TestContext.Current.CancellationToken;

        await using (await ClusterControl.HoldRedisPausedAsync(ct))
        {
            // The held pause is 45s and renewed, so a probe bounded well inside that window cannot
            // finish. Deterministic rather than racy: the margin is the whole pause, not a few ms.
            using var probe = CancellationTokenSource.CreateLinkedTokenSource(ct);
            probe.CancelAfter(TimeSpan.FromSeconds(10));

            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => Kubectl.RunAsync(
                    probe.Token, "-n", Chaos.Namespace, "exec", "redis-0", "--", "redis-cli", "PING"));
        }

        var (exitCode, stdout, _) = await Kubectl.RunAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--", "redis-cli", "PING");

        Assert.Equal(0, exitCode);
        Assert.Contains("PONG", stdout, StringComparison.Ordinal);
    }
}
