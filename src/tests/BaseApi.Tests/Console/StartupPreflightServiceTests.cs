using BaseApi.Tests.Support;
using BaseConsole.Core.Startup;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The preflight's whole job is a log an operator reads at startup, so these tests assert on the
/// rendered log output — not on which mocks were called — the same way
/// <c>ProcessorLivenessHeartbeatTests</c> and <c>HydrationServiceTests</c> do for their own loops.
/// <para>
/// <b>The redaction test matters more than the rest of this file.</b> A password embedded in the
/// Redis connection string must never reach a single record, in any of the three log lines the
/// component can emit about Redis (opening, success, failure).
/// </para>
/// </summary>
public sealed class StartupPreflightServiceTests
{
    private const string RedisPassword = "Tr0ub4dor&3Zebra";

    private sealed class Harness
    {
        public IRabbitMqConnectivityCheck Rabbit { get; } = Substitute.For<IRabbitMqConnectivityCheck>();

        public IDatabase Db { get; } = Substitute.For<IDatabase>();

        public IConnectionMultiplexer Redis { get; } = Substitute.For<IConnectionMultiplexer>();

        public RabbitMqOptions RabbitOptions { get; } = new()
        {
            Host        = "rmq-host",
            Port        = 5672,
            VirtualHost = "/",
            Username    = "svc-user",
            Password    = "rabbit-super-secret",
        };

        public string RedisConnectionString { get; set; } =
            $"redis-host:6379,password={RedisPassword},abortConnect=false";

        public FakeTimeProvider Clock { get; } = new();

        public RecordingLogger<StartupPreflightService> Log { get; } = new();

        public CancellationTokenSource Cts { get; } = new();

        public Harness()
        {
            Redis.GetDatabase().Returns(Db);

            // Nothing stubs Rabbit.CheckAsync or Db.PingAsync by default: an unstubbed Task-returning
            // member completes successfully, which is what "everything reachable" looks like here.
        }

        public StartupPreflightService Build() => new(
            Rabbit,
            Options.Create(RabbitOptions),
            Redis,
            RedisEndpointRedactor.Redact(RedisConnectionString),
            Clock,
            Log);

        /// <summary>
        /// Advances the fake clock a second at a time, the same worked example
        /// <c>HydrationServiceTests.Harness.PumpTime</c> uses: a <see cref="FakeTimeProvider"/> moves
        /// only when something reads it, so a loop waiting out its retry interval never wakes unless
        /// the clock is pushed from here.
        /// </summary>
        public void PumpTime(TimeSpan span)
        {
            for (var elapsed = TimeSpan.Zero; elapsed < span; elapsed += TimeSpan.FromSeconds(1))
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                Thread.Sleep(1);
            }
        }
    }

    [Fact]
    public async Task LogsAnOpeningLineNamingBothDependenciesBeforeCheckingAnything()
    {
        var h = new Harness();

        await h.Build().RunAsync(CancellationToken.None);

        // Record 0 is the environment block, which precedes the checks deliberately: it is what the
        // endpoints below were built from, so a failure is unreadable without it already on screen.
        Assert.Contains(
            "application environment variable(s)", h.Log.Records[0].Message, StringComparison.Ordinal);

        var opening = h.Log.Records[1];
        Assert.Equal(LogLevel.Information, opening.Level);
        Assert.Contains("RabbitMQ", opening.Message, StringComparison.Ordinal);
        Assert.Contains("Redis", opening.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LogsSuccessForEachDependencyThenOneAllClearLine_WhenBothAreReachable()
    {
        var h = new Harness();

        await h.Build().RunAsync(CancellationToken.None);

        // Environment block + opening + one success per dependency + one all-clear. Nothing else — a
        // pass that is healthy from the first attempt must not repeat or delay. The environment block
        // is logged once and never repeats, so this count holds however many times the checks run.
        Assert.Equal(5, h.Log.Records.Count);

        // "reachable at" rather than a bare "reachable" — the all-clear line also says "reachable"
        // ("...are both reachable."), and this is the phrase that is unique to the per-dependency line.
        var rabbitLine = Assert.Single(h.Log.Records, r =>
            r.Level == LogLevel.Information
            && r.Message.Contains("RabbitMQ reachable at", StringComparison.Ordinal));
        Assert.Contains("rmq-host", rabbitLine.Message, StringComparison.Ordinal);
        Assert.Contains("5672", rabbitLine.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("rabbit-super-secret", rabbitLine.Message, StringComparison.Ordinal);

        var redisLine = Assert.Single(h.Log.Records, r =>
            r.Level == LogLevel.Information
            && r.Message.Contains("Redis reachable at", StringComparison.Ordinal));
        Assert.Contains("redis-host", redisLine.Message, StringComparison.Ordinal);

        var allClear = Assert.Single(h.Log.Records, r =>
            r.Level == LogLevel.Information
            && r.Message.Contains("PASSED", StringComparison.Ordinal));
        Assert.Contains("RabbitMQ", allClear.Message, StringComparison.Ordinal);
        Assert.Contains("Redis", allClear.Message, StringComparison.Ordinal);

        // The line an operator screenshots must carry what it passed against, not just that it passed.
        Assert.Contains("rmq-host", allClear.Message, StringComparison.Ordinal);
        Assert.Contains("redis-host", allClear.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RendersTheRabbitMqEndpointUnambiguouslyForANonDefaultVirtualHost()
    {
        // The old "{Host}:{Port}{VirtualHost}" concatenation rendered a non-default vhost as
        // "5672prod" — indistinguishable from a typo'd port. VirtualHost is free-form config, not
        // guaranteed to carry its own leading slash, so this covers both shapes.
        var h = new Harness();
        h.RabbitOptions.VirtualHost = "prod";

        await h.Build().RunAsync(CancellationToken.None);

        var rabbitLine = Assert.Single(h.Log.Records, r =>
            r.Message.Contains("RabbitMQ reachable at", StringComparison.Ordinal));
        Assert.Contains("rmq-host:5672/prod", rabbitLine.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("5672prod", rabbitLine.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RendersTheRabbitMqEndpointUnambiguouslyWhenVirtualHostAlreadyCarriesItsSlash()
    {
        var h = new Harness();
        h.RabbitOptions.VirtualHost = "/prod";

        await h.Build().RunAsync(CancellationToken.None);

        var rabbitLine = Assert.Single(h.Log.Records, r =>
            r.Message.Contains("RabbitMQ reachable at", StringComparison.Ordinal));
        Assert.Contains("rmq-host:5672/prod", rabbitLine.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("5672//prod", rabbitLine.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RepeatsOnlyTheStillFailingDependencyEveryRetryInterval_UntilItRecovers()
    {
        // RabbitMQ refuses twice, then a third attempt succeeds — the outage this loop backs off
        // through. Redis is healthy throughout, so it must be logged as reachable exactly once despite
        // the pass repeating for RabbitMQ's sake.
        var h = new Harness();
        var attempts = 0;
        h.Rabbit.CheckAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            Interlocked.Increment(ref attempts) <= 2
                ? Task.FromException(new IOException("connection refused"))
                : Task.CompletedTask);

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));

        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        var rabbitFailures = h.Log.Records.Count(r =>
            r.Level == LogLevel.Error && r.Message.Contains("RabbitMQ", StringComparison.Ordinal));
        Assert.Equal(2, rabbitFailures);

        var rabbitSuccesses = h.Log.Records.Count(r =>
            r.Level == LogLevel.Information
            && r.Message.Contains("RabbitMQ reachable at", StringComparison.Ordinal));
        Assert.Equal(1, rabbitSuccesses);

        var redisSuccesses = h.Log.Records.Count(r =>
            r.Level == LogLevel.Information
            && r.Message.Contains("Redis reachable at", StringComparison.Ordinal));
        Assert.Equal(1, redisSuccesses);   // never re-logged while only RabbitMQ was still failing

        Assert.Single(h.Log.Records, r => r.Message.Contains("PASSED", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AttachesTheUnderlyingExceptionAndItsOwnMessage_OnFailure()
    {
        var h = new Harness();
        var fault = new IOException("ACCESS_REFUSED - user 'svc-user' does not have permission");
        h.Rabbit.CheckAsync(Arg.Any<CancellationToken>()).ThrowsAsync(fault);

        var run = h.Build().RunAsync(h.Cts.Token);
        // Under the retry interval on purpose: this test is about what one failure line carries, not
        // about the repeat cadence — RepeatsOnlyTheStillFailingDependencyEveryRetryInterval_... owns
        // that. One second is enough real time for the pool to run the first attempt.
        h.PumpTime(TimeSpan.FromSeconds(1));
        h.Cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);

        var failure = Assert.Single(h.Log.Records, r =>
            r.Level == LogLevel.Error && r.Message.Contains("RabbitMQ", StringComparison.Ordinal));

        // The broker's own words, not a paraphrase — and the exception object itself, attached rather
        // than merely quoted, so the operator can see the full stack if they widen the log view.
        Assert.Contains("ACCESS_REFUSED", failure.Message, StringComparison.Ordinal);
        Assert.Same(fault, failure.Exception);
        Assert.Contains("rmq-host", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EndsSilentlyOnCancellation()
    {
        // Both dependencies stay down for the life of the test. Cancelling must not itself produce a
        // log line — a cancellation is a shutdown, not a dependency verdict.
        var h = new Harness();
        h.Rabbit.CheckAsync(Arg.Any<CancellationToken>()).ThrowsAsync(new IOException("down"));
        h.Db.PingAsync(Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(6));
        h.Cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);

        Assert.DoesNotContain(h.Log.Records, r => r.Exception is OperationCanceledException);
        Assert.DoesNotContain(h.Log.Records, r => r.Message.Contains("PASSED", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DoesNotLogAnErrorWhenCancelledWhileARedisPingIsOutstanding()
    {
        // PingRedisAsync races the ping against a deadline LINKED to the caller's token, so cancelling
        // that token also cancels the deadline. The only thing distinguishing "Redis is slow" from
        // "the host is stopping" is whether ct itself was cancelled -- never the exception's type,
        // and never merely which side of Task.WhenAny won. RabbitMQ is left to succeed by default so
        // the run is definitely sitting inside the Redis ping, not still on RabbitMQ, when we cancel.
        var h = new Harness();
        var pingNeverCompletes = new TaskCompletionSource<TimeSpan>();
        h.Db.PingAsync(Arg.Any<CommandFlags>()).Returns(pingNeverCompletes.Task);

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(1));   // real time for the pool to reach the outstanding ping
        h.Cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);

        Assert.DoesNotContain(h.Log.Records, r => r.Level == LogLevel.Error);
        Assert.DoesNotContain(
            h.Log.Records, r => r.Message.Contains("unreachable", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task NeverLogsThePasswordEmbeddedInTheRedisConnectionString()
    {
        // The one assertion this whole component exists to satisfy. Redis fails once (an
        // authentication-shaped fault, carrying no secret of its own) and then succeeds, so both the
        // failure line and the success line for Redis get exercised — either would be a place a raw
        // connection string could leak from.
        var h = new Harness();
        var attempts = 0;
        h.Db.PingAsync(Arg.Any<CommandFlags>()).Returns(_ =>
            Interlocked.Increment(ref attempts) == 1
                ? throw new RedisConnectionException(
                    ConnectionFailureType.AuthenticationFailure, "NOAUTH Authentication required.")
                : Task.FromResult(TimeSpan.FromMilliseconds(1)));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(10));
        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        Assert.DoesNotContain(
            h.Log.Records, r => r.Message.Contains(RedisPassword, StringComparison.Ordinal));
        Assert.DoesNotContain(
            h.Log.Records,
            r => r.Exception is not null
                && r.Exception.ToString().Contains(RedisPassword, StringComparison.Ordinal));

        // Not just silent about the secret — actually informative about the safe part.
        Assert.Contains(h.Log.Records, r => r.Message.Contains("redis-host", StringComparison.Ordinal));
    }
}
