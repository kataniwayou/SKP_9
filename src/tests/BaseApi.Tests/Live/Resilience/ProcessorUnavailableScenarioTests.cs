using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S6. The processor deployment is scaled to zero for a minute mid-orchestration.
/// <para>
/// <b>Nothing suppresses the dispatch while it is gone.</b> <c>ProcessorLivenessValidator</c> lives
/// in the API and runs at <c>POST /start</c>, not in the orchestrator's dispatch path, so the
/// orchestrator keeps firing and keeps sending process-dispatch messages to the processor's work
/// queue throughout. Those sit in a durable queue on a broker with a PVC and are drained when the
/// processor returns — which is why this scenario expects completion, not merely survival.
/// </para>
/// <para>
/// The full nine-fire floor applies: the orchestrator never stopped scheduling, so every fire of the
/// soak still happened. That is the difference between this scenario and S7.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
public sealed class ProcessorUnavailableScenarioTests
{
    [Fact]
    public async Task NoStepIsLostWhileTheProcessorIsGone()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Processor,
                ct => ClusterControl.HoldScaledDownAsync("deployment", "processor-sample", 2, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
