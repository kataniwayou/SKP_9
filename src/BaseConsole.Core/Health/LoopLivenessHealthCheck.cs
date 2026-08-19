using BaseConsole.Core.Loop;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace BaseConsole.Core.Health;

public sealed class LoopLivenessHealthCheck : IHealthCheck
{
    private readonly ILoopHeartbeat _heartbeat;
    private readonly ConsoleLoopOptions _options;
    private readonly TimeProvider _clock;

    public LoopLivenessHealthCheck(
        ILoopHeartbeat heartbeat, IOptions<ConsoleLoopOptions> options, TimeProvider clock)
    {
        _heartbeat = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _options   = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _clock     = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        if (_heartbeat.Last is not { } last)
        {
            return Task.FromResult(HealthCheckResult.Unhealthy("discovery loop has not started"));
        }

        var window = _options.Interval * _options.StaleFactor;

        // Non-strict: the boundary instant counts as stale, so the threshold means what it reads as.
        // Matches BaseApi.Core's copy of this check — the two must not disagree about the edge.
        return Task.FromResult(_clock.GetUtcNow() - last >= window
            ? HealthCheckResult.Unhealthy("discovery loop stale")
            : HealthCheckResult.Healthy("discovery loop running"));
    }
}
