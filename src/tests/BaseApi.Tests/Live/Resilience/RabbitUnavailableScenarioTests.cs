using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S3. The broker is scaled to zero for a minute mid-orchestration.
/// <para>
/// <b>Scale-down is the right lever here, where it is the wrong one for Redis.</b> The RabbitMQ
/// StatefulSet provisions a 1Gi per-pod PVC on the mnesia directory, so queues and durable messages
/// survive the pod. It also declares no liveness probe, so nothing restarts it underneath the test.
/// </para>
/// <para>
/// Unacknowledged deliveries return to their queues when the channel dies, so the expectation is
/// redelivery and completion rather than merely a survivable failure.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class RabbitUnavailableScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileTheBrokerIsDown()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Rabbit,
                ct => ClusterControl.HoldScaledDownAsync("statefulset", "rabbitmq", 1, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
