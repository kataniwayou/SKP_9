using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseProcessor.Core.Liveness;

/// <summary>
/// The steady-state liveness loop: every <see cref="ProcessorLivenessOptions.IntervalSeconds"/> it
/// stamps the loop heartbeat and, once the processor is healthy, republishes its per-instance L2 key.
/// <para>
/// <b>The beat is unconditional and comes first.</b> It sits above the healthy gate, before any I/O,
/// so a replica still resolving its identity — or one whose Redis is down — keeps reporting live.
/// Gating the beat on health would restart a pod during precisely the outage it is waiting out, and
/// gating it on a successful write would do the same for a store outage.
/// </para>
/// <para>
/// <b>The gate governs only the write.</b> A not-yet-healthy tick writes nothing and does not wait;
/// the L2 reader sees the replica as absent, which is the honest answer, since it cannot serve.
/// </para>
/// <para>
/// <b>This loop never retires.</b> It runs for process life, so a stopped beat always means a fault.
/// </para>
/// </summary>
public sealed class ProcessorLivenessHeartbeat : BackgroundService
{
    private readonly ProcessorLivenessWriter _writer;
    private readonly IProcessorContext _context;
    private readonly ProcessorLivenessOptions _options;
    private readonly TimeProvider _clock;
    private readonly ILoopHeartbeat _heartbeat;
    private readonly IStartupGate _gate;
    private readonly InstanceId _instanceId;
    private readonly ILogger<ProcessorLivenessHeartbeat> _logger;

    private bool _firstBeat = true;
    private bool _announcedHealthy;

    public ProcessorLivenessHeartbeat(
        ProcessorLivenessWriter writer,
        IProcessorContext context,
        IOptions<ProcessorLivenessOptions> options,
        TimeProvider clock,
        ILoopHeartbeat heartbeat,
        IStartupGate gate,
        InstanceId instanceId,
        ILogger<ProcessorLivenessHeartbeat> logger)
    {
        _writer     = writer ?? throw new ArgumentNullException(nameof(writer));
        _context    = context ?? throw new ArgumentNullException(nameof(context));
        _options    = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _clock      = clock ?? throw new ArgumentNullException(nameof(clock));
        _heartbeat  = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _gate       = gate ?? throw new ArgumentNullException(nameof(gate));
        _instanceId = instanceId ?? throw new ArgumentNullException(nameof(instanceId));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var period = TimeSpan.FromSeconds(_options.IntervalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            await BeatOnceAsync().ConfigureAwait(false);

            try
            {
                await Task.Delay(period, _clock, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;   // host shutdown
            }
        }
    }

    /// <summary>
    /// One iteration: stamp, then write if healthy. Separated from the schedule above so the
    /// behaviour is one unit — the loop decides *when*, this decides *what*.
    /// </summary>
    public async Task BeatOnceAsync()
    {
        _heartbeat.Beat();

        if (_firstBeat)
        {
            // The loop is genuinely running, which is all readiness claims. Deliberately not gated on
            // health: a processor waiting on an unregistered DB row is starting correctly, not failing.
            _gate.MarkReady();
            _firstBeat = false;
            _logger.LogInformation("liveness loop started");
        }

        if (!_context.IsHealthy || _context.Identity is not { } identity)
        {
            return;
        }

        if (!_announcedHealthy)
        {
            // The edge, not the tick: every subsequent beat republishes this same value.
            _logger.LogInformation(
                "processor {ProcessorId} is healthy; publishing liveness every {Interval}s",
                identity.Id, _options.IntervalSeconds);
            _announcedHealthy = true;
        }

        // Frozen healthy: all outcomes succeed, so Create derives Healthy. The definitions are not
        // re-examined here — reaching Healthy is what settled them, and re-deriving per beat would
        // only invent a way for a steady-state replica to contradict its own startup.
        var entry = ProcessorLivenessEntry.Create(
            inputOutcome:  SchemaOutcome.Success,
            outputOutcome: SchemaOutcome.Success,
            configOutcome: SchemaOutcome.Success,
            timestamp:     _clock.GetUtcNow().UtcDateTime,
            interval:      _options.IntervalSeconds);

        await _writer.WriteAsync(identity.Id, _instanceId.Value, entry).ConfigureAwait(false);
    }
}
