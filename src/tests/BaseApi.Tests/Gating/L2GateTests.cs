using BaseApi.Core.Gating;
using BaseApi.Tests.Support;
using Microsoft.Extensions.Logging;
using Xunit;

namespace BaseApi.Tests.Gating;

public sealed class L2GateTests
{
    private static (L2Gate Gate, RecordingLogger<L2Gate> Log) Build()
    {
        var log = new RecordingLogger<L2Gate>();
        return (new L2Gate(log), log);
    }

    [Fact]
    public async Task LogsWhenTheGateOpens()
    {
        var (gate, log) = Build();

        await gate.ReportHealthyAsync();

        var record = Assert.Single(log.Records);
        Assert.Equal(LogLevel.Information, record.Level);
        Assert.Contains("open", record.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task LogsWhenTheGateCloses()
    {
        var (gate, log) = Build();
        await gate.ReportHealthyAsync();
        log.Records.Clear();

        await gate.TripAsync();

        var record = Assert.Single(log.Records);
        Assert.Equal(LogLevel.Warning, record.Level);
        Assert.Contains("closed", record.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DoesNotLogWhenTheStateIsUnchanged()
    {
        // The probe calls ReportHealthyAsync on every healthy tick, so a per-call log would bury the
        // transitions this exists to surface. Only the edge is worth a line.
        var (gate, log) = Build();
        await gate.ReportHealthyAsync();
        log.Records.Clear();

        await gate.ReportHealthyAsync();
        await gate.ReportHealthyAsync();

        Assert.Empty(log.Records);
    }

    [Fact]
    public async Task DoesNotLogTrippingAGateThatStartedClosed()
    {
        // Constructed closed, so a trip before any opening is not a transition.
        var (gate, log) = Build();

        await gate.TripAsync();

        Assert.Empty(log.Records);
    }
}
