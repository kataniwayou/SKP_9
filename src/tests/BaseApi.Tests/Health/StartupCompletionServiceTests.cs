using BaseApi.Core.Health;
using BaseApi.Tests.Support;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Npgsql;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Health;

/// <summary>
/// The behaviour this file exists to pin down is the one that used to be wrong: a Postgres outage must
/// not consume the pod's finite startup budget.
/// <para>
/// The old shape ran the migration once, and on failure left the startup gate unset. The startup probe
/// then stayed red, and at <c>failureThreshold: 30</c> × <c>periodSeconds: 5</c> the kubelet killed the
/// container — turning an outage into a restart loop where each restart rotated away the log that
/// explained it. The gate is now marked before the first attempt, and the schema's actual state moved
/// to readiness, which has no budget to exhaust.
/// </para>
/// </summary>
public sealed class StartupCompletionServiceTests
{
    private sealed class Harness
    {
        public IMigrationRunner Runner { get; } = Substitute.For<IMigrationRunner>();
        public StartupGate Gate { get; } = new();
        public MigrationState Migrations { get; } = new();
        public FakeTimeProvider Clock { get; } = new();
        public RecordingLogger<StartupCompletionService> Log { get; } = new();
        public CancellationTokenSource Cts { get; } = new();

        public StartupCompletionService Build() =>
            new(Gate, Migrations, Runner, Clock, Log);

        /// <summary>
        /// Advances the fake clock a second at a time. A <see cref="FakeTimeProvider"/> moves only when
        /// something reads it, so a loop waiting out its backoff never wakes unless it is pushed.
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

    private static PostgresException Refused(string sqlState) =>
        new("permission denied", "FATAL", "FATAL", sqlState);

    private static NpgsqlException Unreachable() =>
        new("failed to connect", new IOException("connection refused"));

    [Fact]
    public async Task MarksTheStartupGateBeforeTheFirstAttempt_EvenWhenEveryAttemptFails()
    {
        // The whole point. If this regresses, a Postgres outage kills the pod at ~155s again.
        var h = new Harness();
        h.Runner.MigrateAsync(Arg.Any<CancellationToken>()).Returns(_ => Task.FromException(Unreachable()));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(10));

        Assert.True(h.Gate.IsReady);

        await h.Cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task DoesNotClaimTheSchemaIsAppliedWhileItIsNot()
    {
        // The gate being green must not leak into the readiness answer — they are separate claims, and
        // conflating them is what put a migration failure on a budgeted probe in the first place.
        var h = new Harness();
        h.Runner.MigrateAsync(Arg.Any<CancellationToken>()).Returns(_ => Task.FromException(Unreachable()));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(10));

        Assert.False(h.Migrations.Applied);

        await h.Cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task KeepsRetryingUntilTheMigrationSucceeds()
    {
        var h = new Harness();
        var attempts = 0;
        h.Runner.MigrateAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            Interlocked.Increment(ref attempts) <= 3
                ? Task.FromException(Unreachable())
                : Task.CompletedTask);

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));
        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        Assert.True(h.Migrations.Applied);
        Assert.Equal(4, attempts);
        Assert.Contains(h.Log.Records, r =>
            r.Level == LogLevel.Information
            && r.Message.Contains("schema applied", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ATransientOutageIsAWarning_NotAnError()
    {
        // Logging a recoverable outage at error is what trains an operator to ignore errors.
        var h = new Harness();
        var attempts = 0;
        h.Runner.MigrateAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            Interlocked.Increment(ref attempts) <= 1
                ? Task.FromException(Unreachable())
                : Task.CompletedTask);

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(10));
        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        var failure = Assert.Single(h.Log.Records, r => r.Message.Contains(
            "schema not applied", StringComparison.Ordinal));
        Assert.Equal(LogLevel.Warning, failure.Level);
        Assert.Contains("no action needed", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARejectedPasswordIsAnError_AndSaysToFixTheSettingThenRestart()
    {
        var h = new Harness();
        h.Runner.MigrateAsync(Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromException(Refused(PostgresErrorCodes.InvalidPassword)));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(3));

        // First, not Single: the loop keeps retrying and keeps reporting, which is the intent — an
        // operator who scrolls to the bottom must still find the verdict.
        var failure = h.Log.Records.First(r => r.Level == LogLevel.Error);
        Assert.Contains("ConnectionStrings:Postgres", failure.Message, StringComparison.Ordinal);
        Assert.Contains("restart this pod", failure.Message, StringComparison.Ordinal);

        await h.Cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AMissingGrantSaysARestartWillNotHelp()
    {
        // The distinction three states exist for: deterministic, but touching the pod is the wrong move.
        var h = new Harness();
        h.Runner.MigrateAsync(Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromException(Refused(PostgresErrorCodes.InsufficientPrivilege)));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(3));

        var failure = h.Log.Records.First(r => r.Level == LogLevel.Error);
        Assert.Contains("a restart will not either", failure.Message, StringComparison.Ordinal);
        Assert.Equal(DependencyFault.BlockedExternal, h.Migrations.LastFailure!.Fault);

        await h.Cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task RecordsTheVerdictSoReadinessCanReportIt()
    {
        var h = new Harness();
        h.Runner.MigrateAsync(Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromException(Refused(PostgresErrorCodes.InvalidPassword)));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(3));

        var verdict = h.Migrations.LastFailure;
        Assert.NotNull(verdict);
        Assert.Equal(DependencyFault.BlockedConfiguration, verdict.Fault);
        Assert.True(verdict.RestartRequired);

        await h.Cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ShutdownDoesNotMarkTheSchemaApplied()
    {
        // A half-run migration must never publish itself as done.
        var h = new Harness();
        h.Runner.MigrateAsync(Arg.Any<CancellationToken>()).Returns(_ => Task.FromException(Unreachable()));

        var run = h.Build().RunAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(3));
        await h.Cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));

        Assert.False(h.Migrations.Applied);
    }
}
