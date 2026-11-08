using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

/// <summary>Answers every read with the trails it was given, and remembers what it was asked.</summary>
internal sealed class FakeTrailSource(params ExecutionTrail[] trails) : IExecutionTrailSource
{
    internal (Guid Workflow, ReportWindow Window, TimeSpan Trail)? Asked { get; private set; }

    public Task<IReadOnlyList<ExecutionTrail>> ReadAsync(Guid workflowId, ReportWindow window, TimeSpan trail, CancellationToken ct)
    {
        Asked = (workflowId, window, trail);
        return Task.FromResult<IReadOnlyList<ExecutionTrail>>(trails);
    }
}

public sealed class NapoleProcessorTests
{
    internal static readonly Guid Watched = Guid.Parse("8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02");

    internal static ExecutionTrail Complete() => new(Guid.NewGuid(), 1, 0, 2, 0, 0);
    internal static ExecutionTrail Failed() => new(Guid.NewGuid(), 1, 0, 1, 1, 0);
    internal static ExecutionTrail Cancelled() => new(Guid.NewGuid(), 1, 0, 0, 0, 1);
    internal static ExecutionTrail Open() => new(Guid.NewGuid(), 1, 1, 1, 0, 0);

    internal static NapoleProcessor Processor(IExecutionTrailSource source)
        => new(
            source,
            Options.Create(new NapoleOptions
            {
                ElasticBaseUrl = "http://es.test",
                LagSeconds = 60,
                TrailMinutes = 10,
                Report = ReportBuilderTests.Dimensions(),
            }),
            new FakeTimeProvider(ReportBuilderTests.InsertedAt),
            NullLogger<NapoleProcessor>.Instance);

    internal static string Payload(Guid? workflow = null, int window = 10)
        => JsonSerializer.Serialize(new { watchedWorkflowId = workflow ?? Watched, windowMinutes = window });

    [Fact]
    public async Task ItAsksForTheSnappedWindow()
    {
        var source = new FakeTrailSource(Complete());

        await Processor(source).ReportAsync(new NapoleConfig(Watched, 10), TestContext.Current.CancellationToken);

        Assert.Equal((Watched, ReportBuilderTests.Window, TimeSpan.FromMinutes(10)), source.Asked);
    }

    [Fact]
    public async Task TheReportCountsTheTrails()
    {
        var source = new FakeTrailSource(Complete(), Complete(), Failed(), Cancelled(), Open());

        var report = await Processor(source).ReportAsync(new NapoleConfig(Watched, 10), TestContext.Current.CancellationToken);

        Assert.NotNull(report);
        Assert.Equal(new MandatoryMeasurments(InputCount: 4, OutputCount: 2, DiscardedCount: 1, FailedCount: 1), report.MandatoryMeasurments);
        Assert.Equal(1794135060412, report.CommonDimentions.InsertionTime);
        Assert.Equal("myDepartment", report.CommonDimentions.ReporterComponentName);
        Assert.Equal("LLL", report.CommonDimentions.SagCode);
    }

    [Fact]
    public async Task NothingTerminatedIsCancelledAndSendsNothing()
    {
        // Not a silent return: the framework reports a step that sends nothing as Failed.
        var sender = Substitute.For<IQueueSender>();
        var processor = Processor(new FakeTrailSource(Open(), Open()));
        processor.BeginDispatch(TestDispatch.State(sender, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid()));

        var ex = await Assert.ThrowsAsync<CancelledException>(
            () => processor.ExecuteAsync([], Payload(), Guid.Empty, TestContext.Current.CancellationToken));

        Assert.Contains(Watched.ToString(), ex.Message, StringComparison.Ordinal);
        Assert.Contains("2026-11-08T10:40:00", ex.Message, StringComparison.Ordinal);
        Assert.Empty(sender.ReceivedCalls());
    }

    [Fact]
    public async Task NoPayloadFails()
    {
        var processor = Processor(new FakeTrailSource(Complete()));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", Guid.Empty, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AnEmptyWorkflowIdFails()
    {
        var processor = Processor(new FakeTrailSource(Complete()));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ReportAsync(new NapoleConfig(Guid.Empty, 10), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AWindowBelowOneFails()
    {
        var processor = Processor(new FakeTrailSource(Complete()));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ReportAsync(new NapoleConfig(Watched, 0), TestContext.Current.CancellationToken));
    }
}
