using BaseConsole.Core.Loop;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using RabbitMQ.Client;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class QueueStatsProbeHeartbeatTests
{
    /// <summary>
    /// A probe whose declare always throws, so the test exercises the case that matters: the
    /// heartbeat must be stamped by an iteration that measured NOTHING.
    /// <para>
    /// It overrides <c>DeclareAsync</c> rather than passing a null connection, because the base
    /// constructor guards that argument -- a null would throw before the loop ever ran. The
    /// override is the same kind of seam <c>IRabbitMqConnectivityCheck</c> and
    /// <c>ITopologyDeclarer</c> already exist for: <c>RabbitMqConnection</c> is sealed with
    /// non-virtual methods, so there is no way to stand up one that fails on demand.
    /// </para>
    /// </summary>
    private sealed class AlwaysFailingProbe : QueueStatsProbe
    {
        public AlwaysFailingProbe(RabbitMqConnection connection, ILoopHeartbeat heartbeat)
            : base(
                connection,
                queues: ["q"],
                interval: TimeSpan.FromMilliseconds(10),
                logger: NullLogger.Instance,
                heartbeat: heartbeat)
        {
        }

        protected override string Purpose => "test";

        protected override Task<QueueDeclareOk> DeclareAsync(string queue, CancellationToken ct) =>
            throw new InvalidOperationException("the broker is unreachable in this test");

        protected override void Report(string queue, QueueDeclareOk ok) { }
    }

    private static RabbitMqConnection TestConnection() =>
        new(
            Options.Create(new RabbitMqOptions()),
            Array.Empty<IRabbitMqTopology>(),
            NullLogger<RabbitMqConnection>.Instance);

    [Fact]
    public async Task AnIterationThatMeasuredNothingStillCountsAsAlive()
    {
        var clock = new FakeTimeProvider();
        var heartbeat = new LoopHeartbeat(clock);

        // Any constructible connection will do -- the override below means it is never dialled.
        // Build it the way the existing transport tests build one.
        var probe = new AlwaysFailingProbe(TestConnection(), heartbeat);

        using var cts = new CancellationTokenSource();

        // DeclareAsync throws on the first queue of the first pass -- which is exactly the
        // broker-outage shape. If Beat() were stamped after the I/O, or only on success, this
        // stays null and an outage in a dependency becomes a restart of the process observing it.
        var run = probe.StartAsync(cts.Token);
        await Task.Delay(200, TestContext.Current.CancellationToken);
        await cts.CancelAsync();
        await probe.StopAsync(CancellationToken.None);

        Assert.NotNull(heartbeat.Last);
    }
}
