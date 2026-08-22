using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S4. Redis and the broker are taken away over one window.
/// <para>
/// <b>The order is load-bearing in both directions.</b> Redis is paused first and released last, so
/// the broker's whole outage — including its pod start, which is unbounded — sits inside the Redis
/// fault. On the way back the consumer needs its channel before the gate reopens; reopening the gate
/// against a broker that is not there yet interleaves the heal records in an order the witness would
/// have to special-case.
/// </para>
/// <para>
/// The Redis pause is renewed on a keepalive throughout, so a slow broker start cannot let it lapse
/// and quietly turn this into S3 with a longer preamble.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
[Collection(Chaos.Category)]
public sealed class BothUnavailableScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileBothDependenciesAreUnavailable()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(FaultKind.Both, InjectBothAsync),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }

    private static async Task<IAsyncDisposable> InjectBothAsync(CancellationToken ct)
    {
        var redis = await ClusterControl.HoldRedisPausedAsync(ct);

        try
        {
            var rabbit = await ClusterControl.HoldScaledDownAsync("statefulset", "rabbitmq", 1, ct);
            return new BothFaults(redis, rabbit);
        }
        catch
        {
            // The broker never went down, so release Redis rather than leaving it paused behind a
            // scenario that is about to fail.
            await redis.DisposeAsync();
            throw;
        }
    }

    /// <summary>Releases the broker first, then Redis — the reverse of the order they were applied.</summary>
    private sealed class BothFaults : IAsyncDisposable
    {
        private readonly IAsyncDisposable _redis;
        private readonly IAsyncDisposable _rabbit;

        public BothFaults(IAsyncDisposable redis, IAsyncDisposable rabbit)
        {
            _redis = redis;
            _rabbit = rabbit;
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                await _rabbit.DisposeAsync();
            }
            finally
            {
                // In a finally: a broker that failed to come back must not strand Redis paused.
                await _redis.DisposeAsync();
            }
        }
    }
}
