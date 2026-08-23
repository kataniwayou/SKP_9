using BaseApi.Core.Gating;
using BaseApi.Tests.Support;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Gating;

/// <summary>
/// The probe's per-iteration records are Debug on purpose — at the default Information level they are
/// invisible, and raising them would flood the log for the length of an outage this design exists to
/// ride out. These tests cover the two Information/Warning records that exist so a cold start into a
/// Redis outage is not completely silent.
/// <para>
/// <b>The silence this closes was a composition of three correct decisions.</b> The gate begins
/// closed; <c>L2Gate</c> logs transitions only, so closed-to-closed emits nothing; and the gated
/// consumer announces a pause only if it was consuming first. Each is right alone. Together they let
/// a fresh pod come up with Redis unreachable and write not one line about it.
/// </para>
/// </summary>
public sealed class L2GateProbeTests
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(5);

    private sealed class Harness : IAsyncDisposable
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public IConnectionMultiplexer Redis { get; } = Substitute.For<IConnectionMultiplexer>();
        public RecordingLogger<L2GateProbe> Log { get; } = new();
        public L2Gate Gate { get; } = new(new RecordingLogger<L2Gate>());

        public L2GateOptions Options { get; } = new()
        {
            Interval            = TimeSpan.FromMilliseconds(10),
            ProbeTimeout        = TimeSpan.FromMilliseconds(200),
            HealthyChecksToOpen = 2,
        };

        private L2GateProbe? _probe;

        public Harness() => Redis.GetDatabase().Returns(Db);

        /// <summary>Makes every ping fail, the way an unreachable projection store does.</summary>
        public void RedisIsDown() =>
            Db.PingAsync().Returns(_ => Task.FromException<TimeSpan>(
                new RedisConnectionException(ConnectionFailureType.SocketFailure, "down")));

        /// <summary>Makes every ping succeed.</summary>
        public void RedisIsUp() => Db.PingAsync().Returns(Task.FromResult(TimeSpan.FromMilliseconds(1)));

        public async Task StartAsync()
        {
            _probe = new L2GateProbe(
                Gate,
                new LoopHeartbeat(TimeProvider.System, new RecordingLogger<LoopHeartbeat>()),
                Redis,
                Options.ToOptions(),
                Log);
            await _probe.StartAsync(CancellationToken.None);
        }

        /// <summary>
        /// Polls rather than sleeping a fixed span: the loop runs on real time at a 10ms cadence, and
        /// a fixed sleep would either be flaky or slow.
        /// </summary>
        public async Task UntilAsync(Func<bool> condition)
        {
            var deadline = DateTime.UtcNow + Wait;
            while (DateTime.UtcNow < deadline)
            {
                if (condition())
                {
                    return;
                }

                await Task.Delay(10, TestContext.Current.CancellationToken);
            }

            Assert.Fail($"condition not met within {Wait}. Records:\n"
                        + string.Join("\n", Log.Records.Select(r => $"  [{r.Level}] {r.Message}")));
        }

        public int Warnings(string fragment) => Log.Records.Count(r =>
            r.Level == LogLevel.Warning && r.Message.Contains(fragment, StringComparison.Ordinal));

        public async ValueTask DisposeAsync()
        {
            if (_probe is not null)
            {
                await _probe.StopAsync(CancellationToken.None);
                _probe.Dispose();
            }
        }
    }

    [Fact]
    public async Task AnnouncesThatTheGateStartsClosedAndWhatWillOpenIt()
    {
        // Without this line, "the gate is closed" has no record anywhere at startup: L2Gate reports
        // transitions, and there has not been one.
        await using var h = new Harness();
        h.RedisIsUp();

        await h.StartAsync();

        var opening = h.Log.Records[0];
        Assert.Equal(LogLevel.Information, opening.Level);
        Assert.Contains("starts closed", opening.Message, StringComparison.Ordinal);
        Assert.Contains("2", opening.Message, StringComparison.Ordinal);   // HealthyChecksToOpen
    }

    [Fact]
    public async Task WarnsOnceWhenTheStoreIsUnreachableFromTheVeryFirstProbe()
    {
        // The cold-start case: the gate never transitions, so this warning is the only evidence.
        await using var h = new Harness();
        h.RedisIsDown();

        await h.StartAsync();
        await h.UntilAsync(() => h.Warnings("projection store unreachable") >= 1);

        // And then stays quiet, however many iterations run. One line per episode, not per tick — the
        // reason the per-iteration records are Debug in the first place.
        await Task.Delay(300, TestContext.Current.CancellationToken);
        Assert.Equal(1, h.Warnings("projection store unreachable"));
    }

    [Fact]
    public async Task TheWarningNamesWhatWillEndTheOutage()
    {
        await using var h = new Harness();
        h.RedisIsDown();

        await h.StartAsync();
        await h.UntilAsync(() => h.Warnings("projection store unreachable") >= 1);

        var warning = Assert.Single(h.Log.Records, r => r.Level == LogLevel.Warning);
        Assert.Contains("consumers", warning.Message, StringComparison.Ordinal);
        Assert.Contains("2", warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RearmsSoASecondOutageIsAlsoReported()
    {
        // A latch that never reset would report the first outage of a pod's life and silently swallow
        // every one after it — which is worse than the silence this replaced, because it looks covered.
        await using var h = new Harness();
        h.RedisIsDown();

        await h.StartAsync();
        await h.UntilAsync(() => h.Warnings("projection store unreachable") >= 1);

        h.RedisIsUp();
        await h.UntilAsync(() => h.Gate.IsOpen);

        h.RedisIsDown();
        await h.UntilAsync(() => h.Warnings("projection store unreachable") >= 2);
    }

    [Fact]
    public async Task OpensTheGateAfterTheConfiguredRunOfHealthyProbes()
    {
        // The recovery path still works: the new records observe, they do not gate.
        await using var h = new Harness();
        h.RedisIsUp();

        await h.StartAsync();
        await h.UntilAsync(() => h.Gate.IsOpen);

        Assert.DoesNotContain(h.Log.Records, r => r.Level == LogLevel.Warning);
    }
}

file static class OptionsExtensions
{
    public static IOptions<T> ToOptions<T>(this T value) where T : class => Options.Create(value);
}
