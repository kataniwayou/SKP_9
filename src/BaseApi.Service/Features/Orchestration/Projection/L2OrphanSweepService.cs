using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Runs <see cref="L2OrphanSweeper"/> on a fixed period for the lifetime of the host.
/// <para>
/// <b>Off the request path deliberately.</b> The work is unbounded in the number of processors and
/// blocks nothing that a caller is waiting for, so it belongs on a timer rather than in the liveness
/// gate — see the sweeper's own note on why pruning during a short-circuiting scan cannot be
/// complete.
/// </para>
/// <para>
/// The first pass is delayed by one period rather than running at startup, so a cold start spends its
/// first seconds serving traffic rather than scanning Redis. Nothing depends on the sweep having run:
/// an unswept index produces correct gate verdicts, just with dead members counted and skipped.
/// </para>
/// <para>
/// A failed pass is logged and the loop continues. The next pass sees the same orphans and retries
/// them, so there is nothing to recover and no reason to end the loop.
/// </para>
/// </summary>
internal sealed class L2OrphanSweepService : BackgroundService
{
    private static readonly TimeSpan Period = TimeSpan.FromMinutes(5);

    private readonly L2OrphanSweeper _sweeper;
    private readonly ILogger<L2OrphanSweepService> _logger;

    public L2OrphanSweepService(L2OrphanSweeper sweeper, ILogger<L2OrphanSweepService> logger)
    {
        _sweeper = sweeper ?? throw new ArgumentNullException(nameof(sweeper));
        _logger  = logger  ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Period);

        while (await SafeWaitAsync(timer, stoppingToken).ConfigureAwait(false))
        {
            try
            {
                await _sweeper.SweepAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "orphan sweep pass failed; retrying next period");
            }
        }
    }

    private static async Task<bool> SafeWaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { return false; }
    }
}
