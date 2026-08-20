using BaseConsole.Core.Loop;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseConsole.Core.Gating;

/// <summary>
/// The loop that measures the projection store and moves the gate, and — by stamping a heartbeat on
/// every iteration — the only evidence this process is still capable of recovering from an outage.
/// <para>
/// <b>It ticks on a fixed interval rather than sleeping until something trips the gate.</b> Waiting
/// on the gate would be cheaper while healthy, but a loop that is asleep is indistinguishable from a
/// loop that has died, and the whole liveness story here rests on telling those apart. The cost of
/// ticking regardless is one small round-trip per interval.
/// </para>
/// <para>
/// <b>The heartbeat is stamped first, before any I/O, and unconditionally.</b> That ordering is what
/// makes a store outage survivable: an iteration in which the measurement times out has still done
/// its job, and must still count as alive. Stamping after the measurement — or only on success —
/// turns an outage in a dependency into a restart of the process observing it, which is the exact
/// failure this design exists to avoid.
/// </para>
/// <para>
/// <b>This loop is the only thing that opens the gate.</b> Consumers may close it on proof of
/// failure, but nothing except a run of successful measurements reopens it.
/// </para>
/// </summary>
public sealed class L2GateProbe : BackgroundService
{
    private readonly L2Gate _gate;
    private readonly ILoopHeartbeat _heartbeat;
    private readonly IConnectionMultiplexer _redis;
    private readonly L2GateOptions _options;
    private readonly ILogger<L2GateProbe> _logger;

    public L2GateProbe(
        L2Gate gate,
        ILoopHeartbeat heartbeat,
        IConnectionMultiplexer redis,
        IOptions<L2GateOptions> options,
        ILogger<L2GateProbe> logger)
    {
        _gate      = gate ?? throw new ArgumentNullException(nameof(gate));
        _heartbeat = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _redis     = redis ?? throw new ArgumentNullException(nameof(redis));
        _options   = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var consecutiveHealthy = 0;

        while (!stoppingToken.IsCancellationRequested)
        {
            // FIRST, and before anything that can block. See the type remarks.
            _heartbeat.Beat();

            try
            {
                if (await IsHealthyAsync(stoppingToken).ConfigureAwait(false))
                {
                    consecutiveHealthy++;
                    if (consecutiveHealthy >= _options.HealthyChecksToOpen)
                    {
                        // Idempotent: a no-op once the gate is already open, which is the normal case
                        // on every healthy tick.
                        await _gate.ReportHealthyAsync().ConfigureAwait(false);
                    }
                }
                else
                {
                    consecutiveHealthy = 0;
                    await _gate.TripAsync().ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;   // host shutdown
            }
            catch (Exception ex)
            {
                // Never let an unexpected fault end the loop. A loop that returns here stops beating,
                // and the process keeps running with no probe, no gate transitions and no way back
                // from an outage — visible only as a liveness failure much later. Log, keep ticking.
                //
                // A cancellation that is NOT the stopping token lands here too, on purpose: it is not
                // a shutdown, so treating it as one would end the loop for a reason unrelated to the
                // host stopping.
                _logger.LogError(ex, "probe iteration failed; continuing");
            }

            try
            {
                await Task.Delay(_options.Interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;   // host shutdown
            }
        }
    }

    /// <summary>
    /// One bounded measurement. Any failure — refusal, timeout, or a fault inside the client — is a
    /// negative result rather than an exception, because the caller's job is to decide about the
    /// gate, not to distinguish between ways of being unreachable.
    /// </summary>
    private async Task<bool> IsHealthyAsync(CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(_options.ProbeTimeout);

        try
        {
            // The ping takes no cancellation token — it is governed by the multiplexer's own connect
            // and sync timeouts, which during a real outage run far longer than one iteration. Racing
            // it against the deadline is the only way to bound it; a token the call never reads would
            // look like a bound while being none.
            var ping = _redis.GetDatabase().PingAsync();
            var winner = await Task.WhenAny(
                ping,
                Task.Delay(Timeout.InfiniteTimeSpan, deadline.Token)).ConfigureAwait(false);

            if (!ReferenceEquals(winner, ping))
            {
                // Abandoned, not cancelled: the ping is still running and will eventually complete or
                // fault. Observe that fault so it is not raised as unobserved later, far from here.
                _ = ping.ContinueWith(
                    static t => _ = t.Exception,
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted,
                    TaskScheduler.Default);

                _logger.LogDebug("probe exceeded {Timeout}", _options.ProbeTimeout);
                return false;
            }

            await ping.ConfigureAwait(false);   // surface a faulted ping
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "probe failed");
            return false;
        }
    }
}
