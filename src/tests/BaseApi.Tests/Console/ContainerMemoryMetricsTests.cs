using BaseApi.Tests.Support;
using Messaging.Transport;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The container memory meter reads the cgroup's own files. These tests give it a fake cgroup root
/// in each layout a node can have, so what it reports is pinned without depending on the machine the
/// tests run on.
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class ContainerMemoryMetricsTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "cgroup-" + Guid.NewGuid().ToString("N"));

    public ContainerMemoryMetricsTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // a leftover temp folder is not a test failure
        }
    }

    private void Write(string relative, string content)
    {
        var path = Path.Combine(_root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    [Fact]
    public void CgroupV2ReportsTheChargeTheLimitAndTheAnonymousPart()
    {
        Write("memory.current", "399859712\n");
        Write("memory.max", "402653184\n");
        Write("memory.stat", "anon 354537472\nfile 43294720\nkernel 4243456\n");

        var reading = ContainerMemoryMetrics.Read(_root);

        Assert.Equal(new ContainerMemoryMetrics.Reading(399_859_712, 402_653_184, 354_537_472), reading);
    }

    [Fact]
    public void AnUnlimitedV2ContainerReportsNoLimit()
    {
        // "max" is v2's no-limit. A limit line drawn at some huge number would flatten every panel.
        Write("memory.current", "1048576");
        Write("memory.max", "max\n");

        Assert.Null(ContainerMemoryMetrics.Read(_root).Limit);
        Assert.Equal(1_048_576, ContainerMemoryMetrics.Read(_root).Charge);
    }

    [Fact]
    public void CgroupV1IsReadWhenV2IsAbsent()
    {
        Write(Path.Combine("memory", "memory.usage_in_bytes"), "83886080\n");
        Write(Path.Combine("memory", "memory.limit_in_bytes"), "536870912\n");
        Write(Path.Combine("memory", "memory.stat"), "cache 1000\nrss 48234496\nrss_huge 0\n");

        Assert.Equal(new ContainerMemoryMetrics.Reading(83_886_080, 536_870_912, 48_234_496), ContainerMemoryMetrics.Read(_root));
    }

    [Fact]
    public void V1sUnlimitedSentinelReportsNoLimit()
    {
        // LONG_MAX rounded down to the page size: v1's way of saying "no limit".
        Write(Path.Combine("memory", "memory.limit_in_bytes"), "9223372036854771712\n");

        Assert.Null(ContainerMemoryMetrics.Read(_root).Limit);
    }

    [Fact]
    public void AMissingOrUnreadableFileReportsNothingRatherThanZero()
    {
        // A zero would draw as "no memory used"; nothing draws as a gap, which is the truth.
        Write("memory.current", "not a number");
        Write("memory.stat", "file 10\n");   // no anon line

        Assert.Equal(new ContainerMemoryMetrics.Reading(null, null, null), ContainerMemoryMetrics.Read(_root));
        Assert.Equal(new ContainerMemoryMetrics.Reading(null, null, null),
            ContainerMemoryMetrics.Read(Path.Combine(_root, "does-not-exist")));
    }

    [Fact]
    public void TheInstrumentsPublishWhatTheRealCgroupHolds()
    {
        ContainerMemoryMetrics.EnsureRegistered();
        using var metrics = new MetricCollector(ContainerMemoryMetrics.MeterName);
        metrics.Collect();

        // The process figures exist on every platform.
        Assert.True(Assert.Single(metrics.For(ContainerMemoryMetrics.WorkingSetInstrument)).Value > 0);
        Assert.True(Assert.Single(metrics.For(ContainerMemoryMetrics.ThreadsInstrument)).Value > 0);

        // The container figures exist exactly when this machine has a readable cgroup: in the SDK
        // container these tests run in, yes; on a Windows host, no -- and then nothing, not a zero.
        var real = ContainerMemoryMetrics.Read(ContainerMemoryMetrics.DefaultCgroupRoot);
        Assert.Equal(real.Charge is null ? 0 : 1, metrics.For(ContainerMemoryMetrics.ChargeInstrument).Count);
        Assert.Equal(real.Limit is null ? 0 : 1, metrics.For(ContainerMemoryMetrics.LimitInstrument).Count);
        Assert.Equal(real.Anon is null ? 0 : 1, metrics.For(ContainerMemoryMetrics.AnonInstrument).Count);
    }
}
