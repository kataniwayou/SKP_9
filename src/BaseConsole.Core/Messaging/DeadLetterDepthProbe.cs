using Messaging.Transport;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Reads how deep this process's dead-letter queues are, on a loop, and publishes it as a level.
/// <para>
/// <b>Passive declare, not the management API and not a broker exporter.</b> <c>queue.declare</c>
/// with <c>passive</c> returns the queue's message count over the AMQP connection this process
/// already holds, inside the vhost it was given. That matters because the broker and Prometheus are
/// both org-owned in production: a scrape target cannot be added, a plugin cannot be enabled, and
/// broker-wide metrics would span other tenants' queues. Everything here travels the same path as
/// every other pipeline metric — OTLP to the collector — and needs nothing from anyone.
/// </para>
/// <para>
/// <b>A fresh channel per pass, deliberately.</b> A passive declare against a queue that does not
/// exist does not return an error to the caller: the broker closes the CHANNEL with a 404. Sharing
/// one long-lived channel would mean a single missing queue silently killed every later reading on
/// it. A channel per pass costs one round trip per interval and contains the blast radius to the
/// queue that was actually missing.
/// </para>
/// <para>
/// <b>Failure is logged and swallowed, never fatal.</b> This is an observability loop; a process
/// that died because it could not measure its own dead-letter queue would have turned a reporting
/// gap into an outage. The gauge simply keeps reporting the last value it saw, which is why the
/// staleness of the whole telemetry path is already covered by <c>TelemetryStale</c>.
/// </para>
/// </summary>
public sealed class DeadLetterDepthProbe : BackgroundService
{
    private readonly RabbitMqConnection _connection;
    private readonly IReadOnlyList<string> _queues;
    private readonly TimeSpan _interval;
    private readonly ILogger<DeadLetterDepthProbe> _logger;

    /// <summary>Queues currently failing to read, so each episode warns once rather than per tick.</summary>
    private readonly HashSet<string> _failing = [];

    public DeadLetterDepthProbe(
        RabbitMqConnection connection,
        IReadOnlyList<string> queues,
        TimeSpan interval,
        ILogger<DeadLetterDepthProbe> logger)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _queues     = queues ?? throw new ArgumentNullException(nameof(queues));
        _interval   = interval > TimeSpan.Zero
            ? interval
            : throw new ArgumentOutOfRangeException(nameof(interval), interval, "must be positive");
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_queues.Count == 0)
        {
            // Said once, loudly. A probe measuring nothing looks identical from outside to a probe
            // reporting zero, and the difference is the whole point of the instrument.
            _logger.LogWarning("no dead-letter queues configured; depth will never be reported");
            return;
        }

        // The only record that this loop exists at all. Without it, "the probe never started" and
        // "the probe is running and the queues are empty" are the same observation from outside the
        // process -- both are silence plus a gauge reading zero. That ambiguity cost a debugging
        // cycle on this very class.
        _logger.LogInformation(
            "dead-letter depth probe watching {QueueCount} queue(s) every {Interval}: {Queues}",
            _queues.Count, _interval, string.Join(", ", _queues));

        while (!stoppingToken.IsCancellationRequested)
        {
            foreach (var queue in _queues)
            {
                try
                {
                    Report(queue, await DepthAsync(queue, stoppingToken).ConfigureAwait(false));

                    // Recovered: re-arm the warning so the next episode is reported too.
                    if (_failing.Remove(queue))
                    {
                        _logger.LogInformation("reading the depth of {Queue} again", queue);
                    }
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    // ONE WARNING PER QUEUE PER EPISODE, then silence until it recovers.
                    //
                    // This was written at Debug first, to keep a broker outage from logging once per
                    // queue per interval for its whole length. That made a probe which could not
                    // measure ANYTHING indistinguishable from a probe reporting zero -- the gauge had
                    // no series, the board's `or vector(0)` rendered a confident green 0 while the
                    // broker held 7, and nothing anywhere said why. Debug is below the level shipped
                    // to the log store, which is the same trap WorkflowActivator documents for its
                    // own control-plane record.
                    //
                    // Latching keeps the outage case quiet without making the broken case silent.
                    if (_failing.Add(queue))
                    {
                        _logger.LogWarning(ex, "could not read the depth of {Queue}", queue);
                    }
                }
            }

            try
            {
                await Task.Delay(_interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task<uint> DepthAsync(string queue, CancellationToken ct)
    {
        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);
        var channel = await connection.CreateChannelAsync(cancellationToken: ct).ConfigureAwait(false);

        await using (channel.ConfigureAwait(false))
        {
            var ok = await channel.QueueDeclarePassiveAsync(queue, ct).ConfigureAwait(false);
            return ok.MessageCount;
        }
    }

    /// <summary>Separated so the loop reads as measure-then-publish and the cast lives in one place.</summary>
    private static void Report(string queue, uint depth) =>
        DeadLetterDepthMetrics.Report(queue, (long)depth);
}
