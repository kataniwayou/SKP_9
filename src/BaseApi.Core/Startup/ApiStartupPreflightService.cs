using BaseApi.Core.Diagnostics;
using Messaging.Transport;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseApi.Core.Startup;

/// <summary>
/// The operator-facing diagnostic that answers, at the top of every startup's console output, whether
/// this process's own RabbitMQ connection and Redis connection actually work — reachability and
/// credentials, nothing about what either dependency holds.
/// <para>
/// <b>Why the API needed one at all.</b> Every other component here reports a dependency only when it
/// trips over one, and on a cold start into an outage several of them never trip: the L2 gate begins
/// closed and logs only on transition, its probe logs failures at Debug, and the gated consumer
/// announces a pause only if it was consuming first. Each of those is right on its own — together
/// they let a fresh pod come up with Redis unreachable and say nothing at all. This says it.
/// </para>
/// <para>
/// <b>This is not a gate and not a watchdog.</b> It reads no <see cref="Health.IStartupGate"/>, marks
/// nothing ready, and registers no health check. Migration, the gate probe and the consumer keep sole
/// ownership of retrying and recovering; this only calls into the connections they already share,
/// observes what happens, and logs it. Deleting it would change no other behaviour in the process.
/// </para>
/// <para>
/// <b>Why it resolves the process's own connections rather than opening its own.</b> A preflight that
/// dialled its own copy of the configuration could report green while the connection the rest of the
/// process actually uses is broken — worse than no preflight, because it would be trusted. Going
/// through <see cref="IApiBrokerConnectivityCheck"/> and <see cref="IConnectionMultiplexer"/> means a
/// green result here is also a warm connection nothing else has to open cold.
/// </para>
/// <para>
/// <b>The message templates are character-identical to the console host's.</b> One saved query over
/// the log index then covers the API, the orchestrator and every processor, which is the whole value
/// of a preflight to someone who does not already know which service failed.
/// </para>
/// <para>
/// <b>The repetition is deliberate.</b> While any dependency is still unreachable the failing ones are
/// re-logged every <see cref="RetryInterval"/> — a single warning that scrolls off screen during a
/// slow broker recovery is exactly the failure mode this exists to prevent. A dependency that has
/// already succeeded is never logged again; only the ones still failing repeat.
/// </para>
/// <para>
/// <b>It must not delay host startup.</b> <see cref="ExecuteAsync"/> yields before doing anything, so
/// <c>BackgroundService.StartAsync</c> — and therefore migration and the health endpoint behind it —
/// returns immediately regardless of how long the checks below take.
/// </para>
/// </summary>
internal sealed class ApiStartupPreflightService : BackgroundService
{
    /// <summary>
    /// How often the still-failing dependencies are re-checked and re-logged, governed by
    /// <see cref="TimeProvider"/> so a test can fast-forward it. The same duration is reused, as a
    /// plain wall-clock value, for the deadline the Redis ping is raced against — deliberately not
    /// governed by the same clock: that ping bounds one real network round-trip, and a round-trip is
    /// not a delay a test, or an operator, should be able to freeze.
    /// </summary>
    internal static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(5);

    private const string RabbitMq = "RabbitMQ";
    private const string Redis = "Redis";

    private readonly IApiBrokerConnectivityCheck _rabbit;
    private readonly string _rabbitEndpoint;
    private readonly IConnectionMultiplexer _redis;
    private readonly string _redisEndpoint;
    private readonly TimeProvider _clock;
    private readonly ILogger<ApiStartupPreflightService> _logger;

    public ApiStartupPreflightService(
        IApiBrokerConnectivityCheck rabbit,
        IOptions<RabbitMqOptions> rabbitOptions,
        IConnectionMultiplexer redis,
        string redisEndpoint,
        TimeProvider clock,
        ILogger<ApiStartupPreflightService> logger)
    {
        _rabbit        = rabbit ?? throw new ArgumentNullException(nameof(rabbit));
        _redis         = redis ?? throw new ArgumentNullException(nameof(redis));
        _redisEndpoint = redisEndpoint ?? throw new ArgumentNullException(nameof(redisEndpoint));
        _clock         = clock ?? throw new ArgumentNullException(nameof(clock));
        _logger        = logger ?? throw new ArgumentNullException(nameof(logger));

        ArgumentNullException.ThrowIfNull(rabbitOptions);
        var options = rabbitOptions.Value ?? throw new ArgumentNullException(nameof(rabbitOptions));

        // Host, port, vhost and username are configuration facts, not secrets — Password never rides
        // along. VirtualHost is free-form and not guaranteed to carry its own leading slash: "/", "prod"
        // and "/prod" are all legal. TrimStart('/') before rebuilding the separator is what keeps
        // "prod" from concatenating onto the port (amqp://host:5672prod) and "/prod" from doubling up.
        _rabbitEndpoint =
            $"amqp://{options.Username}@{options.Host}:{options.Port}/{options.VirtualHost.TrimStart('/')}";
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken) => RunAsync(stoppingToken);

    /// <summary>
    /// Checks both dependencies, repeating only the ones still failing every
    /// <see cref="RetryInterval"/>, until both succeed — then logs one all-clear line and returns.
    /// Throws <see cref="OperationCanceledException"/> on shutdown and logs nothing more when it does:
    /// a cancellation is the host stopping, not a verdict on either dependency. Internal so a test can
    /// drive it without a host.
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
                    Redis, _redisEndpoint, PingRedisAsync,
                    static ex => RedisFaultClassifier.Classify(ex).ToString(), ct)
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
        // actionable if it turns out to be the wrong endpoint.
        _logger.LogInformation(
            "Startup preflight PASSED: RabbitMQ ({RabbitEndpoint}) and Redis ({RedisEndpoint}) are " +
            "both reachable.",
            _rabbitEndpoint, _redisEndpoint);
    }

    /// <summary>
    /// One dependency, one attempt: a success line naming the endpoint, or an error line naming the
    /// endpoint and why it failed — the exception attached so the full detail is there when the
    /// console is widened, and <paramref name="describe"/>'s short answer quoted inline so it is not
    /// hidden behind that widening for the operator only skimming.
    /// <para>
    /// <paramref name="describe"/> is what turns a rejected password into something an operator can
    /// act on. It renders the whole verdict — what failed, whether waiting fixes it, and which setting
    /// to correct — where the raw exception says only that the connection failed.
    /// </para>
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
    /// <c>L2GateProbe.IsHealthyAsync</c>: the call takes no cancellation token of its own, so racing
    /// it against a deadline built from <paramref name="ct"/> is the only way to bound it — a token
    /// the call never reads would look like a bound while being none.
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
            // Attached ahead of the shutdown check below rather than after it, because that check
            // throws: both ways out of this branch abandon the same running ping.
            _ = ping.ContinueWith(
                static t => _ = t.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);

            // deadline is linked to ct, so losing this race has two causes that must not be told apart
            // by exception type: a slow-but-reachable Redis, or the caller's own token being cancelled.
            // ct is the only authority on which happened — checked before either exception is even
            // constructed, so a shutdown never gets dressed up as a timed-out ping.
            ct.ThrowIfCancellationRequested();

            throw new TimeoutException($"Redis PING did not complete within {RetryInterval}.");
        }

        await ping.ConfigureAwait(false);   // surface a faulted ping
    }
}
