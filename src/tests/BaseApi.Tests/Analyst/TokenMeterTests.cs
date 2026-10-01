using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;
using Xunit;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// What a dispatch spent, and the case that matters: the attempt that failed. A failure is not
/// retried in process — it reschedules and pays for the whole gate again — so an attempt whose cost
/// went unrecorded is a running cost nobody can see.
/// </summary>
public sealed class TokenMeterTests
{
    private static ModelReply Reply(int input, int output) =>
        new([ScriptedModel.Call("report_fitness", new { problems = Array.Empty<object>() })],
            Text: null, input, output);

    [Fact]
    public async Task EveryCallThroughTheDecoratorIsCounted()
    {
        var meter = new TokenMeter();
        var model = new MeteredAnalystModel(
            new ScriptedModel(Reply(10, 5), Reply(100, 50)), meter);

        await model.SendAsync("s", [], [], CancellationToken.None);
        await model.SendAsync("s", [], [], CancellationToken.None);

        var reading = meter.Snapshot();

        Assert.Equal(2, reading.Calls);
        Assert.Equal(110, reading.Input);
        Assert.Equal(55, reading.Output);
        Assert.Equal(165, reading.Total);
    }

    [Fact]
    public async Task ACallThatThrowsRecordsNothing()
    {
        // A request that never came back was never billed for output; counting it would invent spend.
        var meter = new TokenMeter();
        var model = new MeteredAnalystModel(new ScriptedModel(), meter);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => model.SendAsync("s", [], [], CancellationToken.None));

        Assert.Equal(0, meter.Snapshot().Calls);
    }

    [Fact]
    public void ASnapshotDifferenceIsWhatOneDispatchSpent()
    {
        var meter = new TokenMeter();
        meter.Record(10, 5);

        var before = meter.Snapshot();
        meter.Record(200, 100);
        var spent = meter.Snapshot() - before;

        Assert.Equal(1, spent.Calls);
        Assert.Equal(300, spent.Total);
        Assert.Contains("300 tokens", spent.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFailedDispatchStillReportsWhatItSpent()
    {
        var meter = new TokenMeter();
        var logger = new RecordingLogger<AnalystProcessor>();

        // Five unfit ballots: the gate rejects the prompt, so the dispatch fails — and must still
        // account for the five calls it paid for on the way there.
        var unfit = new ModelReply(
            [ScriptedModel.Call("report_fitness", new
            {
                problems = new[] { new { stage = "plan", kind = "missing", offending = "…" } },
            })],
            Text: null, InputTokens: 40, OutputTokens: 20);

        var model = new MeteredAnalystModel(
            new ScriptedModel(unfit, unfit, unfit, unfit, unfit), meter);

        var processor = new AnalystProcessor(
            new PreflightBit(model, new BitCache(new BaseApi.Tests.Support.InMemorySharedState(), "test-model/high")),
            new InvestigationLoop(model, new FixturePanelReader()
                    .Reading("queue-wait", "ops", """{"max":4}""", samples: 91)
                    .Reading("step-outcomes", "business", """{"Completed":12}""", samples: 12),
                new FakeTimeProvider(), NullLogger<InvestigationLoop>.Instance),
            logger,
            meter);

        await Assert.ThrowsAsync<FailedException>(
            () => processor.AnalyseAsync(
                new AnalystConfig(
                    TargetWorkflowId: Guid.NewGuid(),
                    WindowMinutes: 15,
                    Prompt: AnalystProcessorTests.StagedPrompt,
                    PanelSet: ["queue-wait", "step-outcomes"],
                    MaxIterations: 12,
                    MaxTokens: 1_000_000,
                    WallClockSeconds: 240),
                CancellationToken.None));

        var spend = logger.Records.Single(r => r.Message.Contains("spent", StringComparison.Ordinal));

        Assert.Contains("5 call(s)", spend.Message, StringComparison.Ordinal);
        Assert.Contains("300 tokens", spend.Message, StringComparison.Ordinal);
    }
}
