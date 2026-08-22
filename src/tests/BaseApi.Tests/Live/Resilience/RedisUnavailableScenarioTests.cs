using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S2. Redis is made unavailable for a minute in the middle of a five-minute orchestration, without
/// losing its data.
/// <para>
/// <b>CLIENT PAUSE, not a scale-down and not a NetworkPolicy.</b> Redis here runs with
/// --save "" --appendonly no, so scaling it to zero destroys L2 rather than interrupting it — that is
/// S5, and it cannot satisfy "no lost steps" by construction. A NetworkPolicy is accepted by this
/// cluster's API server and enforced by nothing at all.
/// </para>
/// <para>
/// The pause surfaces as RedisTimeoutException, which L2FaultClassifier names alongside the
/// connection fault, so DeliveryClassifier returns RequeueAndTrip: the message goes back to its queue
/// and the gate closes. That is the same disposition a refused connection would take, through a
/// branch the code documents.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class RedisUnavailableScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileRedisIsUnavailable()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(FaultKind.Redis, ClusterControl.HoldRedisPausedAsync),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
