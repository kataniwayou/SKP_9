using Messaging.Transport;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseConsole.Core.Startup;

/// <summary>
/// The operator-facing diagnostic that answers, at the top of every startup's console output, whether
/// this process's own RabbitMQ connection and Redis connection actually work — reachability and
/// credentials, nothing about what either dependency holds.
/// <para>
/// <b>This is not a gate and not a watchdog.</b> It reads no <c>IStartupGate</c>, marks
/// nothing ready, and registers no liveness check. The startup loops that already exist —
/// <c>HydrationService</c>, <c>ProcessorStartupOrchestrator</c> — keep sole ownership of retrying and
/// recovering; this component only ever calls into the connections they already share, observes what
/// happens, and logs it. It could be deleted entirely and no other behaviour in the process would
/// change.
/// </para>
/// <para>
/// <b>Why it resolves the process's own connections rather than opening its own.</b> A preflight that
/// dialled its own copy of the configuration could report green while the connection the rest of the
/// process actually uses is broken — worse than no preflight, because it would be trusted. Checking
/// through <see cref="IRabbitMqConnectivityCheck"/> and <see cref="IConnectionMultiplexer"/> means a
/// green result here is also a warm connection the real startup loop no longer has to open cold.
/// </para>
/// <para>
/// <b>The flood is deliberate.</b> While any dependency is still unreachable, the failing ones are
/// re-logged every <see cref="RetryInterval"/> — a single warning that scrolls off screen during a
/// slow broker recovery is exactly the failure mode this exists to prevent. A dependency that has
/// already succeeded is never logged again; only the ones still failing repeat.
/// </para>
/// <para>
/// <b>It must not delay host startup.</b> <see cref="ExecuteAsync"/> yields before doing anything, so
/// <c>BackgroundService.StartAsync</c> — and therefore the rest of the host, including the health
/// endpoint — returns immediately regardless of how long the checks below end up taking.
/// </para>
/// </summary>
internal sealed class StartupPreflightService : BackgroundService
{
    /// <summary>
    /// How often the still-failing dependencies are re-checked and re-logged, governed by
    /// <see cref="TimeProvider"/> so a test can fast-forward it. The same duration is reused, as a
    /// plain wall-clock value, for the deadline the Redis ping is raced against (see
    /// <see cref="PingRedisAsync"/>) — deliberately <b>not</b> governed by the same clock: that ping
    /// bounds one real network round-trip, the same way <c>L2GateProbe.IsHealthyAsync</c>'s does, and
    /// a round-trip is not a delay a test — or an operator — should be able to freeze. A ping that ran
    /// longer than the loop's own cadence would already have missed this pass either way, which is why
    /// one literal number is reused for both rather than two configured separately.
    /// </summary>
    internal static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(5);

    private const string RabbitMq = "RabbitMQ";
    private const string Redis = "Redis";

    private readonly IRabbitMqConnectivityCheck _rabbit;
    private readonly string _rabbitEndpoint;
    private readonly IConnectionMultiplexer _redis;
    private readonly string _redisEndpoint;
    private readonly TimeProvider _clock;
    private readonly ILogger<StartupPreflightService> _logger;

    public StartupPreflightService(
        IRabbitMqConnectivityCheck rabbit,
        IOptions<RabbitMqOptions> rabbitOptions,
        IConnectionMultiplexer redis,
        string redisEndpoint,
        TimeProvider clock,
        ILogger<StartupPreflightService> logger)
    {
        _rabbit        = rabbit ?? throw new ArgumentNullException(nameof(rabbit));
        _redis         = redis ?? throw new ArgumentNullException(nameof(redis));
        _redisEndpoint = redisEndpoint ?? throw new ArgumentNullException(nameof(redisEndpoint));
        _clock         = clock ?? throw new ArgumentNullException(nameof(clock));
        _logger        = logger ?? throw new ArgumentNullException(nameof(logger));

        ArgumentNullException.ThrowIfNull(rabbitOptions);
        var options = rabbitOptions.Value ?? throw new ArgumentNullException(nameof(rabbitOptions));

        // Host, port, vhost and username are configuration facts, not secrets — Password never rides
        // along. See RabbitMqOptions for which fields are which.
        //
        // VirtualHost is free-form config and not guaranteed to carry its own leading slash — "/" (the
        // default), "prod", and "/prod" are all legal values of it. TrimStart('/') before rebuilding
        // the separator ourselves is what keeps "prod" from concatenating onto the port with nothing
        // between them (amqp://host:5672prod) and keeps "/prod" from doubling up (amqp://host:5672//prod).
        _rabbitEndpoint =
            $"amqp://{options.Username}@{options.Host}:{options.Port}/{options.VirtualHost.TrimStart('/')}";
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken) => RunAsync(stoppingToken);

    /// <summary>
    /// Checks both dependencies, repeating only the ones still failing every <see cref="RetryInterval"/>,
    /// until both succeed — then logs one all-clear line and returns. Internal so a test can drive it
    /// directly, the same seam <c>HydrationService.RunUntilHydratedAsync</c> exposes.
    /// <para>
    /// Throws <see cref="OperationCanceledException"/> on shutdown and logs nothing more when it does:
    /// a cancellation is the host stopping, not a verdict on either dependency. <see cref="CheckAsync"/>
    /// tells the two apart by asking <paramref name="ct"/> directly — <c>ct.IsCancellationRequested</c>
    /// — rather than by an exception's type, because a dependency's own client can raise an
    /// <see cref="OperationCanceledException"/> that has nothing to do with this token, and this
    /// token's own cancellation can surface as an exception type that is not
    /// <see cref="OperationCanceledException"/> (see <see cref="PingRedisAsync"/>, whose ping-vs-deadline
    /// race throws <see cref="TimeoutException"/> even when the real cause is shutdown).
    /// </para>
    /// </summary>
    internal async Task RunAsync(CancellationToken ct)
    {
        await Task.Yield();

        // Before the checks, not after: this block is what the endpoints below were built from, so an
        // operator reading a failure needs it already on screen. Logged once even though the checks
        // repeat — the environment cannot change under a running process, and repeating it would push
        // the failures it explains off the top of the console.
        var settings = EnvironmentSnapshot.Lines();
        _logger.LogInformation(
            "Loaded {SettingCount} application environment variable(s):{NewLine}{Settings}",
            settings.Count, Environment.NewLine, string.Join(Environment.NewLine, settings));

        _logger.LogInformation(
            "Startup preflight beginning: checking RabbitMQ (connect + declare topology) and " +
            "Redis (connect + PING).");

        var rabbitOk = false;
        var redisOk = false;

        while (!rabbitOk || !redisOk)
        {
            ct.ThrowIfCancellationRequested();

            if (!rabbitOk)
            {
                rabbitOk = await CheckAsync(
                    RabbitMq, _rabbitEndpoint, _rabbit.CheckAsync,
                    static ex => BrokerFaultClassifier.Classify(ex).ToString(), ct)
                    .ConfigureAwait(false);
            }

            if (!redisOk)
            {
                redisOk = await CheckAsync(
                    Redis, _redisEndpoint, PingRedisAsync, static ex => ex.Message, ct)
                    .ConfigureAwait(false);
            }

            if (rabbitOk && redisOk)
            {
                break;
            }

            await Task.Delay(RetryInterval, _clock, ct).ConfigureAwait(false);
        }

        // Restates both endpoints rather than just naming the dependencies: this is the line an
        // operator screenshots, and "PASSED" with no record of what it passed against is not
        // actionable if it turns out to be the wrong endpoint. Worded to avoid the literal phrase
        // "reachable at" that the per-dependency success line below uses, so a test matching on that
        // phrase can't accidentally pick this line up too.
        _logger.LogInformation(
            "Startup preflight PASSED: RabbitMQ ({RabbitEndpoint}) and Redis ({RedisEndpoint}) are " +
            "both reachable.",
            _rabbitEndpoint, _redisEndpoint);
    }

    /// <summary>
    /// One dependency, one attempt: a success line naming the endpoint, or an error line naming the
    /// endpoint and the dependency's own exception — attached, so the operator can see the full
    /// exception if the console view is widened, and its message quoted inline, so it is not hidden
    /// behind that widening for the operator only skimming.
    /// </summary>
    private async Task<bool> CheckAsync(
        string dependency,
        string endpoint,
        Func<CancellationToken, Task> probe,
        Func<Exception, string> describe,
        CancellationToken ct)
    {
        try
        {
            await probe(ct).ConfigureAwait(false);
            _logger.LogInformation(
                "Startup preflight: {Dependency} reachable at {Endpoint}.", dependency, endpoint);
            return true;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            _logger.LogError(
                ex,
                "Startup preflight: {Dependency} unreachable at {Endpoint}: {Reason}",
                dependency, endpoint, describe(ex));
            return false;
        }
    }

    /// <summary>
    /// One bounded PING through the process's own multiplexer. Mirrors
    /// <c>BaseConsole.Core.Gating.L2GateProbe.IsHealthyAsync</c>: the call takes no cancellation token
    /// of its own, so racing it against a deadline built from <paramref name="ct"/> is the only way to
    /// bound it — a token the call never reads would look like a bound while being none.
    /// </summary>
    private async Task PingRedisAsync(CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(RetryInterval);

        var ping = _redis.GetDatabase().PingAsync();
        var winner = await Task.WhenAny(
            ping, Task.Delay(Timeout.InfiniteTimeSpan, deadline.Token)).ConfigureAwait(false);

        if (!ReferenceEquals(winner, ping))
        {
            // Abandoned, not cancelled: the ping is still running and will eventually complete or
            // fault. Observe that fault so it is not raised as unobserved later, far from here.
            //
            // Attached ahead of the shutdown check below rather than after it, because that check
            // throws: both ways out of this branch abandon the same running ping, and a ping left
            // behind by a stopping host faults exactly as readily as one left behind by a timeout.
            // The process is usually exiting moments later, which is why this was easy to miss — but
            // "usually exiting" is not a reason to leave one of the two exits unobserved.
            _ = ping.ContinueWith(
                static t => _ = t.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);

            // deadline is linked to ct, so losing this race has two different causes that must not be
            // told apart by exception type: a slow-but-reachable Redis (deadline's own CancelAfter
            // fired), or the caller's own token being cancelled (host shutdown, which cancels deadline
            // too). ct is the only authority on which one happened — checked before either exception
            // is even constructed, so a shutdown never gets dressed up as a timed-out ping.
            ct.ThrowIfCancellationRequested();

            throw new TimeoutException($"Redis PING did not complete within {RetryInterval}.");
        }

        await ping.ConfigureAwait(false);   // surface a faulted ping
    }
}
