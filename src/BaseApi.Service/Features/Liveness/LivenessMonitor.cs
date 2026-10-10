using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseApi.Service.Features.Liveness;

/// <summary>Sends the hub's changes to every connected client, in the order given.</summary>
public interface ILivenessPublisher
{
    Task PublishAsync(IReadOnlyList<object> changes, CancellationToken ct);
}

/// <summary>Broadcasts through the hub to all clients (one BaseApi replica: no backplane).</summary>
internal sealed class HubLivenessPublisher : ILivenessPublisher
{
    private readonly IHubContext<LivenessHub, ILivenessClient> _hub;

    public HubLivenessPublisher(IHubContext<LivenessHub, ILivenessClient> hub)
        => _hub = hub ?? throw new ArgumentNullException(nameof(hub));

    public async Task PublishAsync(IReadOnlyList<object> changes, CancellationToken ct)
    {
        foreach (var change in changes)
        {
            ct.ThrowIfCancellationRequested();
            await (change switch
            {
                WorkflowLiveDto w => _hub.Clients.All.WorkflowLive(w),
                ProcessorLivenessChangeDto p => _hub.Clients.All.ProcessorLiveness(p),
                MonitorStatusDto m => _hub.Clients.All.MonitorStatus(m),
                _ => throw new ArgumentException($"not a liveness change: {change.GetType().Name}", nameof(changes)),
            });
        }
    }
}

/// <summary>
/// Reads liveness every <see cref="LivenessMonitorOptions.IntervalSeconds"/> (the first read at once), feeds it to
/// <see cref="LivenessState"/> and broadcasts the changes. A failed read (Redis or the database) is logged and read
/// again next tick; after <see cref="LivenessMonitorOptions.UnknownAfterFailures"/> in a row the hub says "unknown".
/// Nothing a tick throws ends the loop or the host; only shutdown does.
/// </summary>
internal sealed class LivenessMonitor : BackgroundService
{
    private readonly ILivenessSource _source;
    private readonly LivenessState _state;
    private readonly ILivenessPublisher _publisher;
    private readonly TimeProvider _clock;
    private readonly LivenessMonitorOptions _options;
    private readonly ILogger<LivenessMonitor> _logger;
    private int _failures;

    public LivenessMonitor(
        ILivenessSource source, LivenessState state, ILivenessPublisher publisher, TimeProvider clock,
        IOptions<LivenessMonitorOptions> options, ILogger<LivenessMonitor> logger)
    {
        _source = source ?? throw new ArgumentNullException(nameof(source));
        _state = state ?? throw new ArgumentNullException(nameof(state));
        _publisher = publisher ?? throw new ArgumentNullException(nameof(publisher));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
        _options = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    private TimeSpan Period => TimeSpan.FromSeconds(Math.Max(0.1, _options.IntervalSeconds));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // off the startup path: the host finishes starting before the first read
        await Task.Yield();
        using var timer = new PeriodicTimer(Period, _clock);
        try
        {
            do
            {
                await TickAsync(stoppingToken).ConfigureAwait(false);
            }
            while (await WaitAsync(timer, stoppingToken).ConfigureAwait(false));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // host shutdown
        }
    }

    /// <summary>One read, one state update, one broadcast. Never throws, except when <paramref name="ct"/> is cancelled.</summary>
    public async Task TickAsync(CancellationToken ct)
    {
        IReadOnlyList<object> changes;
        try
        {
            changes = _state.Apply(await _source.ReadAsync(ct).ConfigureAwait(false));
            if (_failures > 0)
            {
                _logger.LogInformation("liveness read again after {Failures} failed reads", _failures);
                _failures = 0;
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // the first failure in a row, then one in every 30 (about a minute at 2 s), so an outage does not flood the log
            if (_failures++ % 30 == 0)
            {
                _logger.LogWarning(ex, "liveness read failed ({Failures} in a row); reading again next tick", _failures);
            }
            var status = _state.Fail(ex.Message, _options.UnknownAfterFailures);
            changes = status is null ? [] : [status];
        }

        if (changes.Count == 0) return;
        try
        {
            await _publisher.PublishAsync(changes, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // a client that misses a change sees the gap in the sequence numbers and takes a snapshot
            _logger.LogWarning(ex, "liveness broadcast failed");
        }
    }

    private static async Task<bool> WaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { return false; }
    }
}
