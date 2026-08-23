using BaseApi.Core.Diagnostics;
using Messaging.Transport;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BaseApi.Core.Health;

/// <summary>
/// Applies the migration set, retrying until it succeeds, and reports what is standing in the way
/// while it does not.
///
/// <para>
/// <b>Why this loops instead of running once.</b> It used to attempt the migration a single time and,
/// on failure, log critical and leave the startup gate unset. The startup probe then stayed red, and
/// at thirty attempts of five seconds the kubelet killed the container — so a Postgres outage lasting
/// more than about two and a half minutes turned into a restart loop, and each restart rotated away
/// the log that said why. A dependency outage must not consume a finite startup budget. The
/// orchestrator and every processor already had this shape; this is the API adopting it.
/// </para>
///
/// <para>
/// <b>The startup gate is marked on the first attempt, not on success.</b> It claims only that the
/// loop is running, which is true on every attempt including the ones that throw. The claim that the
/// schema is in place belongs to <see cref="IMigrationState"/>, which
/// <see cref="MigrationReadyHealthCheck"/> reads — and readiness is the one probe permitted to sit red
/// for the length of an outage.
/// </para>
///
/// <para>
/// <b>Failure semantics.</b> Nothing rethrows: an unhandled exception out of a
/// <see cref="BackgroundService"/> stops the host by default, which would take down the health
/// endpoint that exists to report the problem. Every failure is classified, recorded for the readiness
/// body, and logged — at error when an operator has something to do, at warning when the honest
/// advice is to wait.
/// </para>
/// </summary>
public sealed class StartupCompletionService : BackgroundService
{
    /// <summary>
    /// The ceiling the retry delay doubles towards. Matches the orchestrator's hydration loop rather
    /// than introducing a second number: both are "a dependency is down, ask again in a moment", and
    /// an operator reading two services should not have to learn two cadences.
    /// </summary>
    internal static readonly TimeSpan BackoffCap = TimeSpan.FromSeconds(30);

    private readonly IStartupGate _gate;
    private readonly IMigrationState _migrations;
    private readonly IMigrationRunner _runner;
    private readonly TimeProvider _clock;
    private readonly ILogger<StartupCompletionService> _logger;

    public StartupCompletionService(
        IStartupGate gate,
        IMigrationState migrations,
        IMigrationRunner runner,
        TimeProvider clock,
        ILogger<StartupCompletionService> logger)
    {
        _gate         = gate ?? throw new ArgumentNullException(nameof(gate));
        _migrations   = migrations ?? throw new ArgumentNullException(nameof(migrations));
        _runner       = runner ?? throw new ArgumentNullException(nameof(runner));
        _clock        = clock ?? throw new ArgumentNullException(nameof(clock));
        _logger       = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken) => RunAsync(stoppingToken);

    /// <summary>
    /// Attempts the migration until one succeeds, backing off between failures. Returns once the
    /// schema is applied; throws <see cref="OperationCanceledException"/> on shutdown, which is the
    /// only other way out. Internal so a test can drive it without a host — the same seam
    /// <c>HydrationService.RunUntilHydratedAsync</c> exposes.
    /// </summary>
    internal async Task RunAsync(CancellationToken ct)
    {
        // Before anything that can block, and unconditionally. The loop is genuinely running, which is
        // all the startup probe claims — and claiming it here is what stops an outage from exhausting
        // the startup budget. Idempotent, so calling it once per attempt would cost nothing; it is
        // called once because there is nothing to re-assert.
        _gate.MarkReady();

        var delay = TimeSpan.FromSeconds(1);
        var attempt = 0;

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            attempt++;

            try
            {
                await _runner.MigrateAsync(ct).ConfigureAwait(false);

                _migrations.MarkApplied();
                _logger.LogInformation(
                    "schema applied on attempt {Attempt}; the API can now serve requests that read it",
                    attempt);
                return;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;   // shutdown, not a verdict on Postgres
            }
            catch (Exception ex)
            {
                Report(PostgresFaultClassifier.Classify(ex), ex, attempt, delay);
            }

            await Task.Delay(delay, _clock, ct).ConfigureAwait(false);
            delay = TimeSpan.FromTicks(Math.Min(delay.Ticks * 2, BackoffCap.Ticks));
        }
    }

    /// <summary>
    /// One failed attempt, said in the terms the operator has to act in.
    /// <para>
    /// The level is the verdict, not the severity of the exception: a transient outage is a wait and
    /// reads as a warning, while anything an operator must act on is an error. Logging a recoverable
    /// outage at error is what trains people to ignore errors.
    /// </para>
    /// </summary>
    private void Report(DependencyVerdict verdict, Exception ex, int attempt, TimeSpan delay)
    {
        _migrations.RecordFailure(verdict);

        if (verdict.Fault == DependencyFault.Transient)
        {
            _logger.LogWarning(
                ex,
                "schema not applied (attempt {Attempt}): {Reason} — {Guidance}. Retrying in {Delay}.",
                attempt, verdict.Reason, verdict.Guidance, delay);
            return;
        }

        _logger.LogError(
            ex,
            "schema not applied (attempt {Attempt}): {Reason} — {Guidance}. Still retrying every "
            + "{Delay}, and readiness stays red until it succeeds.",
            attempt, verdict.Reason, verdict.Guidance, delay);
    }
}
