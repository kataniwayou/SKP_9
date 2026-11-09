using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
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
    internal (WatchedSection Section, ReportWindow Window, TimeSpan Trail)? Asked { get; private set; }

    public Task<IReadOnlyList<ExecutionTrail>> ReadAsync(WatchedSection section, ReportWindow window, TimeSpan trail, CancellationToken ct)
    {
        Asked = (section, window, trail);
        return Task.FromResult<IReadOnlyList<ExecutionTrail>>(trails);
    }
}

/// <summary>Keeps every line logged through it, with its level, so a test can read what the operator would see.</summary>
internal sealed class CapturingLogger<T> : ILogger<T>
{
    internal List<(LogLevel Level, string Message)> Lines { get; } = [];

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        => Lines.Add((logLevel, formatter(state, exception)));
}

public sealed class NapoleProcessorTests
{
    internal static readonly Guid Watched = Guid.Parse("8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02");
    internal static readonly Guid FromStep = Guid.Parse("95225f8c-56b2-494b-a59d-d9b34fbde441");
    internal static readonly Guid ToStep = Guid.Parse("06f1c5fd-bdfc-43ae-93c9-5bde2995e167");

    /// <summary>The whole-run section of the split chain with the dev dimensions (reach spec §2.5), one field overridable.</summary>
    internal static NapoleConfig Config(
        Guid? workflow = null, Guid? from = null, Guid? to = null, int window = 10, ReportDimensions? dimensions = null)
    {
        var d = dimensions ?? ReportBuilderTests.Dimensions();
        return new(
            workflow ?? Watched, from ?? FromStep, to ?? ToStep, window,
            d.ReporterComponentName, d.ReporterSubComponentName, d.ReporterNetworkName, d.SrcCode, d.SagCode);
    }

    // (roots, reached, endCompleted, endFailed, endCancelled, wayFailed, wayCancelled)
    internal static ExecutionTrail Reached2() => new(Guid.NewGuid(), 1, 2, 2, 0, 0, 0, 0);
    internal static ExecutionTrail FailedOnTheWay() => new(Guid.NewGuid(), 1, 0, 0, 0, 0, 1, 0);
    internal static ExecutionTrail CancelledOnTheWay() => new(Guid.NewGuid(), 1, 0, 0, 0, 0, 0, 1);
    internal static ExecutionTrail NoEnd() => new(Guid.NewGuid(), 1, 0, 0, 0, 0, 0, 0);
    internal static ExecutionTrail ReImported() => new(Guid.NewGuid(), 2, 1, 1, 0, 0, 0, 0);

    internal static NapoleProcessor Processor(IExecutionTrailSource source, ILogger<NapoleProcessor>? logger = null)
        => new(
            source,
            Options.Create(new NapoleOptions
            {
                ElasticBaseUrl = "http://es.test",
                LagSeconds = 60,
                TrailMinutes = 10,
            }),
            new FakeTimeProvider(ReportBuilderTests.InsertedAt),
            logger ?? NullLogger<NapoleProcessor>.Instance);

    internal static string Payload(Guid? workflow = null, int window = 10)
        => JsonSerializer.Serialize(new
        {
            watchedWorkflowId = workflow ?? Watched,
            fromStepId = FromStep,
            toStepId = ToStep,
            windowMinutes = window,
            reporterComponentName = "myDepartment",
            reporterSubComponentName = "myTeam",
            reporterNetworkName = "myNetwork",
            srcCode = "928",
            sagCode = "LLL",
        });

    [Fact]
    public async Task ItAsksForTheSectionAndTheSnappedWindow()
    {
        var source = new FakeTrailSource(Reached2());

        await Processor(source).ReportAsync(Config(), TestContext.Current.CancellationToken);

        Assert.Equal(
            (new WatchedSection(Watched, FromStep, ToStep), ReportBuilderTests.Window, TimeSpan.FromMinutes(10)),
            source.Asked);
    }


    [Fact]
    public async Task TheReportCountsStepOutcomes()
    {
        var source = new FakeTrailSource(Reached2(), FailedOnTheWay(), CancelledOnTheWay(), NoEnd());

        var report = await Processor(source).ReportAsync(Config(), TestContext.Current.CancellationToken);

        Assert.NotNull(report);
        Assert.Equal(new MandatoryMeasurments(InputCount: 3, OutputCount: 2, DiscardedCount: 1, FailedCount: 1), report.MandatoryMeasurments);
        Assert.Equal(1794135060412, report.CommonDimentions.InsertionTime);
        Assert.Equal("myDepartment", report.CommonDimentions.ReporterComponentName);
        Assert.Equal("LLL", report.CommonDimentions.SagCode);
        Assert.Equal("myTeam", report.CommonDimentions.ReporterSubComponentName);
    }

    [Fact]
    public async Task NothingCountedIsCancelledAndNamesTheSection()
    {
        // Not a silent return: the framework reports a step that sends nothing as Failed. The message
        // names both step ids, because a typo in one matches nothing and this is where it shows.
        var sender = Substitute.For<IQueueSender>();
        var processor = Processor(new FakeTrailSource(NoEnd(), ReImported()));
        processor.BeginDispatch(TestDispatch.State(sender, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid()));

        var ex = await Assert.ThrowsAsync<CancelledException>(
            () => processor.ExecuteAsync([], Payload(), Guid.Empty, TestContext.Current.CancellationToken));

        Assert.Contains(Watched.ToString(), ex.Message, StringComparison.Ordinal);
        Assert.Contains(FromStep.ToString(), ex.Message, StringComparison.Ordinal);
        Assert.Contains(ToStep.ToString(), ex.Message, StringComparison.Ordinal);
        Assert.Contains("2026-11-08T10:40:00", ex.Message, StringComparison.Ordinal);
        Assert.Empty(sender.ReceivedCalls());
    }

    [Fact]
    public async Task NoPayloadFails()
    {
        var processor = Processor(new FakeTrailSource(Reached2()));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", Guid.Empty, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AnEmptyWorkflowIdFails()
    {
        var processor = Processor(new FakeTrailSource(Reached2()));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ReportAsync(Config(workflow: Guid.Empty), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AWindowBelowOneFails()
    {
        var processor = Processor(new FakeTrailSource(Reached2()));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ReportAsync(Config(window: 0), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AnEmptyFromStepFails()
    {
        var processor = Processor(new FakeTrailSource(Reached2()));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ReportAsync(Config(from: Guid.Empty), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AnEmptyToStepFails()
    {
        var processor = Processor(new FakeTrailSource(Reached2()));

        await Assert.ThrowsAsync<FailedException>(
            () => processor.ReportAsync(Config(to: Guid.Empty), TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData("reporterComponentName")]
    [InlineData("reporterSubComponentName")]
    [InlineData("reporterNetworkName")]
    [InlineData("srcCode")]
    [InlineData("sagCode")]
    public async Task AWhitespaceDimensionFails(string field)
    {
        // The schema refuses "" at publish; "  ", or a payload row edited by hand, gets here.
        var d = ReportBuilderTests.Dimensions();
        d = field switch
        {
            "reporterComponentName" => d with { ReporterComponentName = "  " },
            "reporterSubComponentName" => d with { ReporterSubComponentName = "  " },
            "reporterNetworkName" => d with { ReporterNetworkName = "  " },
            "srcCode" => d with { SrcCode = "  " },
            _ => d with { SagCode = "  " },
        };
        var processor = Processor(new FakeTrailSource(Reached2()));

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ReportAsync(Config(dimensions: d), TestContext.Current.CancellationToken));

        Assert.Contains(field, ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheReportCarriesThePayloadsDimensions()
    {
        var mine = new ReportDimensions("dept-x", "split-whole-run", "net-y", "111", "ZZZ");

        var report = await Processor(new FakeTrailSource(Reached2()))
            .ReportAsync(Config(dimensions: mine), TestContext.Current.CancellationToken);

        var c = report!.CommonDimentions;
        Assert.Equal(mine, new ReportDimensions(c.ReporterComponentName, c.ReporterSubComponentName, c.ReporterNetworkName, c.SrcCode, c.SagCode));
    }

    [Fact]
    public async Task ASingleStepSectionIsAccepted()
    {
        var source = new FakeTrailSource(Reached2());

        await Processor(source).ReportAsync(Config(to: FromStep), TestContext.Current.CancellationToken);

        Assert.NotNull(source.Asked);
    }

    [Fact]
    public async Task ATickWhereNoRunReachedTheEndWarnsNamingTheEndStep()
    {
        // A typo in toStepId still selects runs by fromStepId, so it sends a plausible report with
        // output 0 every tick (final review, Important 2). The warning is how the operator finds out.
        var logger = new CapturingLogger<NapoleProcessor>();

        var report = await Processor(new FakeTrailSource(FailedOnTheWay(), NoEnd()), logger)
            .ReportAsync(Config(), TestContext.Current.CancellationToken);

        Assert.NotNull(report);
        var warning = Assert.Single(logger.Lines, l => l.Level == LogLevel.Warning);
        Assert.Contains(ToStep.ToString(), warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ATickWhereARunReachedTheEndDoesNotWarn()
    {
        var logger = new CapturingLogger<NapoleProcessor>();

        await Processor(new FakeTrailSource(Reached2(), FailedOnTheWay()), logger)
            .ReportAsync(Config(), TestContext.Current.CancellationToken);

        Assert.DoesNotContain(logger.Lines, l => l.Level == LogLevel.Warning);
    }

    [Fact]
    public async Task TheReportLineCountsTheRunsLeftOut()
    {
        // Executions with no proven end, and re-imports, are in no count; the log line is the only place they show.
        var logger = new CapturingLogger<NapoleProcessor>();

        await Processor(new FakeTrailSource(Reached2(), NoEnd(), ReImported(), ReImported()), logger)
            .ReportAsync(Config(), TestContext.Current.CancellationToken);

        var line = Assert.Single(logger.Lines, l => l.Level == LogLevel.Information).Message;
        Assert.Contains("1 not in report", line, StringComparison.Ordinal);
        Assert.Contains("2 re-imported", line, StringComparison.Ordinal);
    }
}
