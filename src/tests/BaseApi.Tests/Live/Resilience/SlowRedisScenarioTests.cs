using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// S10 and S11. Redis is slow for the processor rather than absent — the fault class every other
/// scenario in this suite misses.
/// <para>
/// <b>Why two scenarios and not one with a parameter.</b> The two bands ask different questions and
/// a single parameterised test would report one verdict for both. The boundary between them is a
/// number already in the code: <see cref="BaseConsole.Core.Gating.L2GateOptions.ProbeTimeout"/> is
/// <b>2 seconds</b>, probed every 5.
/// </para>
/// <para>
/// <b>S10, under the timeout (300 ms).</b> Every Redis round trip costs 300 ms more than it should.
/// The gate has no reason to close and the pipeline has no reason to lose anything. The question is
/// entirely about the boards: does <i>any</i> panel move? A pipeline that is a third of a second
/// slower on every store call is meaningfully degraded, and if nothing shows it then the boards
/// cannot see degradation at all — which is a finding, not a failure, and is the most likely
/// outcome given there is no Redis latency instrument on this stack.
/// </para>
/// <para>
/// <b>S11, over the timeout (3 s).</b> The probe cannot complete inside its 2-second budget, so the
/// gate should close. The question is whether the boards can then tell this from Redis being
/// <i>down</i>. If they cannot, slow and absent render identically — the same shape as the
/// wipe-versus-pause gap already recorded in <c>grafana/README.md</c>, and a second instance of the
/// same missing distinction rather than a coincidence.
/// </para>
/// <para>
/// <b>Only the processor's Redis is slow.</b> The orchestrator and the API still address Redis
/// directly, so these runs are attribution tests too: a board that reports the whole store as
/// degraded, when one workload's path to it is degraded, is reporting something untrue.
/// </para>
/// <para>
/// <b>Reuses <see cref="FaultKind.Redis"/>.</b> When the gate closes it writes the same records a
/// Redis outage does, because from the gate's point of view that is what happened. For S10 the gate
/// is not expected to close at all, so the witness has nothing to find — which is why that scenario
/// asserts on loss alone and leaves the board reading to the probe.
/// </para>
/// <para>
/// <b>This lever does not self-expire.</b> A killed run leaves Redis slow for the processor
/// indefinitely. If a run dies, check
/// <c>kubectl exec -n skp deploy/toxiproxy -- /toxiproxy-cli inspect redis</c> before trusting any
/// later measurement.
/// </para>
/// </summary>
[Trait("Category", Chaos.Category)]
[Collection(Chaos.Category)]
public sealed class SlowRedisScenarioTests
{
    /// <summary>Comfortably inside the 2s probe timeout: slow, but not slow enough to trip anything.</summary>
    private static readonly TimeSpan UnderTimeout = TimeSpan.FromMilliseconds(300);

    /// <summary>Past the 2s probe timeout, so the probe cannot finish inside its budget.</summary>
    private static readonly TimeSpan OverTimeout = TimeSpan.FromSeconds(3);

    [Fact]
    public async Task NoStepIsLostWhileRedisIsSlowButInsideTheProbeTimeout()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.None,
                ct => ClusterControl.HoldRedisSlowAsync(UnderTimeout, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }

    [Fact]
    public async Task NoStepIsLostWhileRedisIsSlowerThanTheProbeTimeout()
    {
        Chaos.SkipUnlessEnabled();

        var result = await OrchestrationSoak.RunAsync(
            new FaultSchedule(
                FaultKind.Redis,
                ct => ClusterControl.HoldRedisSlowAsync(OverTimeout, ct)),
            TestContext.Current.CancellationToken);

        OutageVerdict.AssertNoUnaccountedLoss(result);
    }
}
