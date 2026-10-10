using BaseApi.Service.Features.Liveness;
using BaseApi.Tests.Support;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Liveness;

/// <summary>The monitor: reads, diffs, broadcasts in order, and survives a failed read (never ends the host).</summary>
public sealed class LivenessMonitorTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly Guid Wf = Guid.Parse("00000000-0000-0000-0000-000000000001");
    private static readonly Guid P = Guid.Parse("00000000-0000-0000-0000-0000000000a1");

    private readonly ILivenessSource _source = Substitute.For<ILivenessSource>();
    private readonly LivenessState _state = new();
    private readonly CapturingPublisher _published = new();
    private readonly RecordingLogger<object> _log = new();
    private readonly FakeTimeProvider _clock = new();

    private LivenessMonitor Monitor(int unknownAfter = 2) => new(
        _source, _state, _published, _clock,
        Options.Create(new LivenessMonitorOptions { IntervalSeconds = 2, UnknownAfterFailures = unknownAfter }),
        new LoggerAdapter(_log));

    private static LivenessReading Reading(bool running, bool live) => new(
        running ? new HashSet<Guid> { Wf } : [],
        new Dictionary<Guid, ProcessorLivenessStateDto> { [P] = new(P, live, live ? 1 : 0, 1, live ? null : "stale") });

    [Fact]
    public async Task ATickBroadcastsTheChangesOfItsReadingInOrder()
    {
        var monitor = Monitor();
        _source.ReadAsync(Arg.Any<CancellationToken>()).Returns(Reading(false, true), Reading(true, false));

        await monitor.TickAsync(Ct);
        await monitor.TickAsync(Ct);
        await monitor.TickAsync(Ct);   // the same reading again: nothing

        Assert.Equal<object>([
            new MonitorStatusDto(true, null, 1),
            new WorkflowLiveDto(Wf, true, 2),
            new ProcessorLivenessChangeDto(P, false, 0, 1, "stale", false, 3),
        ], _published.Changes);
    }

    [Fact]
    public async Task ARedisErrorIsLoggedNotThrownAndTheNextTickReadsAgain()
    {
        var monitor = Monitor(unknownAfter: 2);
        _source.ReadAsync(Arg.Any<CancellationToken>()).Returns(
            _ => Reading(false, true),
            _ => throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "redis down"),
            _ => throw new RedisTimeoutException("timeout", CommandStatus.Unknown),
            _ => Reading(true, true));

        await monitor.TickAsync(Ct);
        await monitor.TickAsync(Ct);   // first failure: quiet for clients, logged
        await monitor.TickAsync(Ct);   // second in a row: unknown
        await monitor.TickAsync(Ct);   // read again: known, and the change since

        Assert.Equal<object>([
            new MonitorStatusDto(true, null, 1),
            new MonitorStatusDto(false, "timeout", 2),
            new MonitorStatusDto(true, null, 3),
            new WorkflowLiveDto(Wf, true, 4),
        ], _published.Changes);
        Assert.Contains(_log.Records, r => r.Level == LogLevel.Warning && r.Exception is RedisConnectionException);
        Assert.Contains(_log.Records, r => r.Level == LogLevel.Information && r.Message.Contains("read again", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AFailedBroadcastIsLoggedAndTheMonitorGoesOn()
    {
        var publisher = Substitute.For<ILivenessPublisher>();
        publisher.PublishAsync(Arg.Any<IReadOnlyList<object>>(), Arg.Any<CancellationToken>()).ThrowsAsync(new InvalidOperationException("socket"));
        var monitor = new LivenessMonitor(_source, _state, publisher, _clock, Options.Create(new LivenessMonitorOptions()), new LoggerAdapter(_log));
        _source.ReadAsync(Arg.Any<CancellationToken>()).Returns(Reading(false, true));

        await monitor.TickAsync(Ct);

        Assert.Contains(_log.Records, r => r.Level == LogLevel.Warning && r.Exception is InvalidOperationException);
        Assert.Equal(1, _state.Sequence);
    }

    [Fact]
    public async Task TheLastSequenceIsSentEveryFewSecondsSoALostLastBroadcastShowsAsAGap()
    {
        var monitor = Monitor();
        _source.ReadAsync(Arg.Any<CancellationToken>()).Returns(Reading(false, true), Reading(true, true), Reading(true, true));

        await monitor.TickAsync(Ct);                  // known (1), and the first sequence message
        _published.FailChanges = true;
        _clock.Advance(TimeSpan.FromSeconds(2));
        await monitor.TickAsync(Ct);                  // "running" (2) is lost; too soon for another sequence message
        _published.FailChanges = false;
        _clock.Advance(TimeSpan.FromSeconds(8));
        await monitor.TickAsync(Ct);                  // nothing changed, but 10 s on: the sequence says 2

        Assert.Equal<object>([new MonitorStatusDto(true, null, 1)], _published.Changes);
        Assert.Equal([1L, 2L], _published.Sequences);
    }

    [Fact]
    public async Task CancellationDuringARead_EndsTheTickWithoutLoggingAFailure()
    {
        using var cts = new CancellationTokenSource();
        var monitor = Monitor();
        _source.ReadAsync(Arg.Any<CancellationToken>()).Returns(async ci =>
        {
            await cts.CancelAsync();
            ci.Arg<CancellationToken>().ThrowIfCancellationRequested();
            return Reading(false, true);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => monitor.TickAsync(cts.Token));
        Assert.Empty(_log.Records);
        Assert.Empty(_published.Changes);
    }

    [Fact]
    public async Task TheLoopReadsAtOnceThenEveryIntervalSurvivesAThrowingReadAndStopsCleanly()
    {
        var reads = 0;
        _source.ReadAsync(Arg.Any<CancellationToken>()).Returns(_ =>
        {
            reads++;
            if (reads == 2) throw new RedisConnectionException(ConnectionFailureType.SocketFailure, "gone");
            return Task.FromResult(Reading(reads >= 3, true));
        });
        var monitor = Monitor();

        await monitor.StartAsync(Ct);
        await WaitUntil(() => reads == 1);
        _clock.Advance(TimeSpan.FromSeconds(2));
        await WaitUntil(() => reads == 2);
        _clock.Advance(TimeSpan.FromSeconds(2));
        await WaitUntil(() => _published.Changes.Count == 2);
        await monitor.StopAsync(Ct);

        Assert.Equal<object>([new MonitorStatusDto(true, null, 1), new WorkflowLiveDto(Wf, true, 2)], _published.Changes);
        Assert.True(monitor.ExecuteTask!.IsCompletedSuccessfully);
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++) await Task.Delay(10, Ct);
        Assert.True(condition(), "timed out waiting for the monitor");
    }

    private sealed class CapturingPublisher : ILivenessPublisher
    {
        private readonly List<object> _changes = [];
        private readonly List<long> _sequences = [];
        public IReadOnlyList<object> Changes { get { lock (_changes) return [.. _changes]; } }
        public IReadOnlyList<long> Sequences { get { lock (_sequences) return [.. _sequences]; } }
        /// <summary>When set, change broadcasts throw (the sequence messages still go out).</summary>
        public bool FailChanges { get; set; }

        public Task PublishAsync(IReadOnlyList<object> changes, CancellationToken ct)
        {
            if (FailChanges) throw new InvalidOperationException("socket");
            lock (_changes) _changes.AddRange(changes);
            return Task.CompletedTask;
        }

        public Task PublishSequenceAsync(long sequence, CancellationToken ct)
        {
            lock (_sequences) _sequences.Add(sequence);
            return Task.CompletedTask;
        }
    }

    /// <summary>The monitor takes an <c>ILogger&lt;LivenessMonitor&gt;</c>; the type is internal, so the recording logger is wrapped.</summary>
    private sealed class LoggerAdapter(RecordingLogger<object> inner) : ILogger<LivenessMonitor>
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => inner.BeginScope(state);
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => inner.Log(logLevel, eventId, state, exception, formatter);
    }
}

/// <summary>The hub's snapshot and the publisher's routing of each change to its client method.</summary>
public sealed class LivenessHubTests
{
    private static readonly Guid Wf = Guid.Parse("00000000-0000-0000-0000-000000000001");

    [Fact]
    public async Task SnapshotReturnsTheStateAndItsSequence()
    {
        var state = new LivenessState();
        state.Apply(new LivenessReading(new HashSet<Guid>(), new Dictionary<Guid, ProcessorLivenessStateDto>()));
        state.Apply(new LivenessReading(new HashSet<Guid> { Wf }, new Dictionary<Guid, ProcessorLivenessStateDto>()));
        var hub = new LivenessHub(state) { Context = Substitute.For<HubCallerContext>() };

        var snapshot = await hub.Snapshot();

        Assert.Equal(2, snapshot.Sequence);
        Assert.True(snapshot.Known);
        Assert.Equal([Wf], snapshot.RunningWorkflowIds);
    }

    [Fact]
    public async Task ThePublisherSendsEachChangeToItsClientMethodInOrder()
    {
        var hub = Substitute.For<IHubContext<LivenessHub, ILivenessClient>>();
        var all = Substitute.For<ILivenessClient>();
        hub.Clients.All.Returns(all);
        var calls = new List<string>();
        all.WorkflowLive(Arg.Do<WorkflowLiveDto>(_ => calls.Add("workflow"))).Returns(Task.CompletedTask);
        all.ProcessorLiveness(Arg.Do<ProcessorLivenessChangeDto>(_ => calls.Add("processor"))).Returns(Task.CompletedTask);
        all.MonitorStatus(Arg.Do<MonitorStatusDto>(_ => calls.Add("monitor"))).Returns(Task.CompletedTask);
        all.LivenessSequence(Arg.Do<LivenessSequenceDto>(s => calls.Add($"sequence {s.Sequence}"))).Returns(Task.CompletedTask);

        await new HubLivenessPublisher(hub).PublishAsync([
            new MonitorStatusDto(true, null, 1),
            new WorkflowLiveDto(Wf, true, 2),
            new ProcessorLivenessChangeDto(Wf, false, 0, 0, null, true, 3),
        ], TestContext.Current.CancellationToken);
        await new HubLivenessPublisher(hub).PublishSequenceAsync(3, TestContext.Current.CancellationToken);

        Assert.Equal(["monitor", "workflow", "processor", "sequence 3"], calls);
    }
}
