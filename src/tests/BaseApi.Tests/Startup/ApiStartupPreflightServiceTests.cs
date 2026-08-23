using BaseApi.Core.Startup;
using BaseApi.Tests.Support;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using RabbitMQ.Client.Exceptions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Startup;

/// <summary>
/// The API's preflight exists because a cold start into a Redis outage used to say nothing at all:
/// the gate begins closed and logs only transitions, its probe logs at Debug, and the consumer
/// announces a pause only if it was consuming first. These tests assert on the rendered log, because
/// the rendered log is the entire product.
/// <para>
/// <b>The redaction tests matter more than the rest of this file.</b> Neither the Redis password nor
/// the broker password may reach a single record, in any line the component can emit.
/// </para>
/// </summary>
public sealed class ApiStartupPreflightServiceTests
{
    private const string RedisPassword = "Tr0ub4dor&3Zebra";
    private const string RabbitPassword = "rabbit-super-secret";

    private sealed class Harness
    {
        public IApiBrokerConnectivityCheck Rabbit { get; } =
            Substitute.For<IApiBrokerConnectivityCheck>();

        public IDatabase Db { get; } = Substitute.For<IDatabase>();

        public IConnectionMultiplexer Redis { get; } = Substitute.For<IConnectionMultiplexer>();

        public RabbitMqOptions RabbitOptions { get; } = new()
        {
            Host        = "rmq-host",
            Port        = 5672,
            VirtualHost = "/",
            Username    = "svc-user",
            Password    = RabbitPassword,
        };

        public string RedisConnectionString { get; set; } =
            $"redis-host:6379,password={RedisPassword},abortConnect=false";

        public FakeTimeProvider Clock { get; } = new();

        public RecordingLogger<ApiStartupPreflightService> Log { get; } = new();

        public CancellationTokenSource Cts { get; } = new();

        public Harness()
        {
            Redis.GetDatabase().Returns(Db);

            // Nothing stubs Rabbit.CheckAsync or Db.PingAsync by default: an unstubbed Task-returning
            // member completes successfully, which is what "everything reachable" looks like here.
        }

        public ApiStartupPreflightService Build() => new(
            Rabbit,
            Options.Create(RabbitOptions),
            Redis,
            ApiRedisEndpointRedactor.Redact(RedisConnectionString),
            Clock,
            Log);

        /// <summary>
        /// Advances the fake clock a second at a time. A <see cref="FakeTimeProvider"/> moves only
        /// when something reads it, so a loop waiting out its retry interval never wakes unless the
        /// clock is pushed from here.
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

        var opening = h.Log.Records[0];
        Assert.Equal(LogLevel.Information, opening.Level);
        Assert.Contains("RabbitMQ", opening.Message, StringComparison.Ordinal);
        Assert.Contains("Redis", opening.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LogsSuccessForEachDependencyThenOneAllClearLine_WhenBothAreReachable()
    {
        var h = new Harness();

        await h.Build().RunAsync(CancellationToken.None);

        // Opening + one success per dependency + one all-clear, and nothing else: a pass that is
        // healthy from the first attempt must not repeat or delay startup.
        Assert.Equal(4, h.Log.Records.Count);

        var rabbitLine = Assert.Single(h.Log.Records, r =>
            r.Message.Contains("RabbitMQ reachable at", StringComparison.Ordinal));
        Assert.Contains("rmq-host", rabbitLine.Message, StringComparison.Ordinal);
        Assert.Contains("5672", rabbitLine.Message, StringComparison.Ordinal);

        var redisLine = Assert.Single(h.Log.Records, r =>
            r.Message.Contains("Redis reachable at", StringComparison.Ordinal));
        Assert.Contains("redis-host", redisLine.Message, StringComparison.Ordinal);

        // The line an operator screenshots must carry what it passed against, not just that it passed.
        var allClear = Assert.Single(h.Log.Records, r =>
            r.Message.Contains("PASSED", StringComparison.Ordinal));
        Assert.Contains("rmq-host", allClear.Message, StringComparison.Ordinal);
        Assert.Contains("redis-host", allClear.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task NoRecordEverCarriesEitherPassword_OnTheSuccessPath()
    {
        var h = new Harness();

        await h.Build().RunAsync(CancellationToken.None);

        Assert.All(h.Log.Records, r =>
        {
            Assert.DoesNotContain(RedisPassword, r.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(RabbitPassword, r.Message, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task NoRecordEverCarriesEitherPassword_OnTheFailurePath()
    {
        // The failure path is the one that renders the endpoint beside an exception, so it is the one
        // where a leak would actually happen.
        var h = new Harness();
        var attempts = 0;
        h.Rabbit.CheckAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            Interlocked.Increment(ref attempts) <= 2
                ? Task.FromException(new IOException($"refused for {RabbitPassword}"))
                : Task.CompletedTask);

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));
        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        // The exception's own text is not the component's to sanitise — but the message it renders is.
        Assert.All(h.Log.Records, r =>
            Assert.DoesNotContain(RedisPassword, r.Message, StringComparison.Ordinal));

        var endpointLines = h.Log.Records.Where(r =>
            r.Message.Contains("unreachable at", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(endpointLines);
        Assert.All(endpointLines, r =>
            Assert.Contains("rmq-host:5672", r.Message, StringComparison.Ordinal));
    }

    [Fact]
    public async Task ARejectedPasswordIsNamedAsACredentialProblem_NotAsAnUnreachableHost()
    {
        // The gap this closes: the client wraps an authentication failure inside
        // BrokerUnreachableException, so the untreated message sends an operator to look at the
        // network for a problem that is in the secret.
        var h = new Harness();
        var attempts = 0;
        h.Rabbit.CheckAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            Interlocked.Increment(ref attempts) <= 1
                ? Task.FromException(new BrokerUnreachableException(
                    new AuthenticationFailureException("ACCESS_REFUSED - Login was refused")))
                : Task.CompletedTask);

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));
        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        var failure = Assert.Single(h.Log.Records, r => r.Level == LogLevel.Error);
        Assert.Contains("RabbitMq:Password", failure.Message, StringComparison.Ordinal);
        Assert.Contains("rmq-host:5672", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RepeatsOnlyTheStillFailingDependencyEveryRetryInterval_UntilItRecovers()
    {
        var h = new Harness();
        var attempts = 0;
        h.Rabbit.CheckAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            Interlocked.Increment(ref attempts) <= 2
                ? Task.FromException(new IOException("connection refused"))
                : Task.CompletedTask);

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));
        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        Assert.Equal(2, h.Log.Records.Count(r =>
            r.Level == LogLevel.Error && r.Message.Contains("RabbitMQ", StringComparison.Ordinal)));

        // Never re-logged while only RabbitMQ was still failing.
        Assert.Equal(1, h.Log.Records.Count(r =>
            r.Message.Contains("Redis reachable at", StringComparison.Ordinal)));

        Assert.Single(h.Log.Records, r => r.Message.Contains("PASSED", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ShutdownEndsTheLoopWithoutLoggingAVerdictOnEitherDependency()
    {
        // A cancellation is the host stopping, not a statement about a dependency. Logging one here
        // would put a red line in the log of every perfectly healthy pod deletion.
        var h = new Harness();
        h.Rabbit.CheckAsync(Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromException(new IOException("connection refused")));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(6));
        await h.Cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));

        Assert.DoesNotContain(h.Log.Records, r =>
            r.Message.Contains("PASSED", StringComparison.Ordinal));
    }
}
