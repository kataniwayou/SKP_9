using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using Processor.OutcomeRecorder;
using Xunit;

namespace BaseApi.Tests.OutcomeRecorder;

public sealed class ProcessorOutcomeRecorderTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private static readonly DateTimeOffset Now =
        new(2026, 9, 13, 8, 54, 57, TimeSpan.Zero);

    /// <summary>Runs the real processor and returns the single branch it sent.</summary>
    private static async Task<ProcessedData> Run(
        byte[] data, Guid executionId, string payload = "")
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new OutcomeRecorderProcessor(
            new RecordingLogger<OutcomeRecorderProcessor>(),
            new FakeTimeProvider(Now));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(data, payload, executionId, CancellationToken.None);

        return Assert.Single(sends);
    }

    /// <summary>
    /// Like <see cref="Run"/>, but hands back the logger too -- for the one test that needs to read
    /// the shape the processor logs rather than the envelope it sends.
    /// </summary>
    private static async Task<(ProcessedData Sent, RecordingLogger<OutcomeRecorderProcessor> Log)> RunLogging(
        byte[] data, Guid executionId, string payload = "")
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var log = new RecordingLogger<OutcomeRecorderProcessor>();
        var processor = new OutcomeRecorderProcessor(log, new FakeTimeProvider(Now));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(data, payload, executionId, CancellationToken.None);

        return (Assert.Single(sends), log);
    }

    private static JsonElement Record(ProcessedData sent) => JsonDocument.Parse(sent.Data).RootElement;

    [Fact]
    public async Task RendersTheCorrelationIdWithoutDashes()
    {
        // "N", matching CorrelationKeys.Render and therefore the value Elasticsearch holds. A dashed
        // guid pasted into a term query matches nothing, silently.
        var record = Record(await Run([], E));

        Assert.Equal(C.ToString("N"), record.GetProperty("correlationId").GetString());
    }

    [Fact]
    public async Task CarriesTheExecutionIdDashedWhenThePredecessorHadALineage()
    {
        var record = Record(await Run([], E));

        Assert.Equal(E.ToString("D"), record.GetProperty("executionId").GetString());
    }

    [Fact]
    public async Task OmitsTheExecutionIdWhenThePredecessorHadNoLineage()
    {
        // An importer that ended before opening one. Omitted rather than zeroed, matching
        // ExecutionLogScope: "does not apply" must stay distinguishable from "is the zero guid".
        var record = Record(await Run([], Guid.Empty));

        Assert.False(record.TryGetProperty("executionId", out _));
    }

    [Fact]
    public async Task OpensALineageWhenItWasHandedNone()
    {
        // Without this the exporter step downstream is dispatched as an entry step and trips
        // BaseExporter's edge guard, so an importer's outcome would never be exported.
        var sent = await Run([], Guid.Empty);

        Assert.NotEqual(Guid.Empty, sent.ExecutionId);
    }

    [Fact]
    public async Task ContinuesTheLineageItWasHanded()
    {
        var sent = await Run([], E);

        Assert.Equal(E, sent.ExecutionId);
    }

    [Fact]
    public async Task StampsTheTimeFromTheClock()
    {
        var record = Record(await Run([], E));

        Assert.Equal(Now, record.GetProperty("recordedAtUtc").GetDateTimeOffset());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("{}")]
    [InlineData("""{"topic":"left over from another step"}""")]
    public async Task EveryPayloadIsAccepted(string payload)
    {
        // Nothing reads the payload, so nothing may reject one. This is ArchiveCollapser's rule and
        // it is pinned here for the same reason: a null check added later would fail every step.
        var record = Record(await Run([], E, payload));

        Assert.Equal(C.ToString("N"), record.GetProperty("correlationId").GetString());
    }

    [Fact]
    public async Task IgnoresTheInputItWasHanded()
    {
        // The orchestrator hands over the predecessor's input blob. It is neither parsed nor
        // forwarded: a megabyte of arbitrary bytes produces the same three-field record as none.
        var cargo = new byte[1024 * 1024];
        Random.Shared.NextBytes(cargo);

        var record = Record(await Run(cargo, E));

        Assert.Equal(3, record.EnumerateObject().Count());
    }

    [Fact]
    public async Task TheLogLineForAnEntryStepOutcomeCarriesNoExecutionIdAtAll()
    {
        // A prose sentinel in the structured attribute would defeat the same distinction the record
        // itself preserves by omitting the field. The rendered message is what RecordingLogger keeps,
        // so it is what this asserts against.
        var (_, log) = await RunLogging([], Guid.Empty);

        var line = Assert.Single(log.Records, r => r.Message.Contains("recorded a step outcome"));

        Assert.DoesNotContain("none", line.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("execution", line.Message, StringComparison.OrdinalIgnoreCase);
    }
}
