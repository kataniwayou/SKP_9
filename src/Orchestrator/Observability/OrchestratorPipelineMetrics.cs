using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Hosting;
using Orchestrator.Election;
using Orchestrator.Hydration;

namespace Orchestrator.Observability;

/// <summary>
/// The two flags that explain why an orchestrator replica is doing less than another one.
/// <para>
/// <b>Neither is a reason to stop consuming, and the leader gauge especially is not.</b>
/// Leadership fences cron fires, where two replicas firing one schedule would double-dispatch. Exactly
/// one outcome exists per step that ran, so <c>StepOutcomeHandler</c> is deliberately NOT gated on
/// it — a replica reporting <c>pipeline.leader = 0</c> is expected to be consuming normally, and an
/// alert written the other way round would fire on every healthy follower.
/// </para>
/// <para>
/// <c>pipeline.hydration.admitted</c> distinguishes "not consuming because the store is down" from
/// "not consuming because the first hydration pass has not finished" — two states that otherwise
/// look identical from outside the process.
/// </para>
/// <para>
/// <b>Observables created once in a static constructor, over a registry, not in the instance
/// constructor.</b> <c>Meter.CreateObservableGauge</c> cannot be undone short of disposing the
/// <see cref="Meter"/> itself, so an observable created per instance leaks a live callback every time
/// one is constructed — every test in this class included. <see cref="Live"/> is what lets many
/// instances exist (as every test here does) while exactly one callback is ever registered; see
/// <c>L2GateMetrics</c> for the same shape and the same reasoning.
/// </para>
/// <para>
/// <b>Hosted only so the container constructs it.</b> A DI singleton nothing resolves is an
/// observable that never publishes, with no error to say so. Start and Stop do no work.
/// </para>
/// </summary>
internal sealed class OrchestratorPipelineMetrics : IHostedService, IDisposable
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>OrchestratorHost</c>. A constant
    /// rather than a literal in two places, because a typo produces no error and no metrics.
    /// </summary>
    internal const string MeterName = "Orchestrator";

    private static readonly Meter Meter = new(MeterName);

    /// <summary>
    /// Every live owner's leader and hydration state, keyed by the owner itself.
    /// <para>
    /// <b>This registry exists so there is ONE observable instrument per gauge rather than one per
    /// owner.</b> There is exactly one <see cref="OrchestratorPipelineMetrics"/> per process in
    /// production, but every test in this class constructs its own — and a second
    /// <c>CreateObservableGauge</c> call on the same instrument name is the duplicate-stream hazard
    /// <c>L2GateMetrics</c> documents: the OpenTelemetry SDK warns about it and may drop the
    /// duplicate. Reading each owner's state through this registry keeps
    /// exactly one callback alive per gauge for the process's lifetime, with <see cref="Dispose"/>
    /// removing an owner's entry rather than tearing down the instrument — which cannot be done
    /// short of disposing the Meter itself.
    /// </para>
    /// </summary>
    private static readonly ConcurrentDictionary<
        OrchestratorPipelineMetrics, (LeaderState Leader, HydrationAdmission Hydration)> Live = new();

    static OrchestratorPipelineMetrics()
    {
        // Registered once, in the static constructor, because an observable created more than once
        // is the duplicate-stream hazard the registry above exists to avoid. The returned instrument
        // is intentionally not stored: the Meter owns it and the callback keeps it alive.
        Meter.CreateObservableGauge(
            "pipeline.leader",
            ObserveLeader,
            unit: "1",
            description: "1 while this replica holds the lease and fires schedules. Followers still consume.");

        Meter.CreateObservableGauge(
            "pipeline.hydration.admitted",
            ObserveHydration,
            unit: "1",
            description: "1 once the first hydration pass finished and consumption was admitted. One-shot.");
    }

    public OrchestratorPipelineMetrics(LeaderState leader, HydrationAdmission hydration)
    {
        ArgumentNullException.ThrowIfNull(leader);
        ArgumentNullException.ThrowIfNull(hydration);

        Live[this] = (leader, hydration);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static IEnumerable<Measurement<int>> ObserveLeader() =>
        Live.Values.Select(entry => new Measurement<int>(entry.Leader.IsLeader ? 1 : 0));

    private static IEnumerable<Measurement<int>> ObserveHydration() =>
        Live.Values.Select(entry => new Measurement<int>(entry.Hydration.IsOpen ? 1 : 0));

    /// <summary>
    /// Leaves the registry, so a disposed owner is not merely stale in the next poll but genuinely
    /// absent from it — both gauges stop reporting this owner's state.
    /// </summary>
    public void Dispose() => Live.TryRemove(this, out _);
}
