using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using Processor.Analyst;
using Processor.Analyst.Bit;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;
using Xunit;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// The Analyst is its workflow's entry step, so it must OPEN a lineage rather than forward the empty
/// id it was handed.
/// <para>
/// Forwarding it looked like success from every angle that was being watched: the branch went out,
/// the entry step reported Completed and the orchestrator advanced its successor. The only sign was
/// three steps downstream, where the exporter reported "it was dispatched as an entry step, with no
/// execution to export" and threw the finding away. It did that on both of the two occasions in
/// seven days that a finding existed at all.
/// </para>
/// </summary>
public sealed class AnalystOpensItsOwnLineageTests
{
    private static readonly Guid W = Guid.NewGuid();
    private static readonly Guid S = Guid.NewGuid();
    private static readonly Guid P = Guid.NewGuid();
    private static readonly Guid C = Guid.NewGuid();

    private static ModelReply FitBit() => ModelReply.Of(
        ScriptedModel.Call("report_fitness", new { problems = Array.Empty<object>() }));

    private static async Task<ProcessedData> SendFor(Guid incomingExecutionId)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new AnalystProcessor(
            new PreflightBit(new ScriptedModel(FitBit(), FitBit(), FitBit()), new BitCache(4)),
            new InvestigationLoop(
                new ScriptedModel([.. AnalystScript.Stages("queue-wait"), AnalystScript.Submit("queue-wait")]),
                new FixturePanelReader()
                    .Reading("queue-wait", "ops", """{"max":4}""", samples: 91)
                    .Reading("step-outcomes", "business", """{"Completed":12}""", samples: 12),
                new FakeTimeProvider(), NullLogger<InvestigationLoop>.Instance),
            NullLogger<AnalystProcessor>.Instance);

        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(
            [], System.Text.Json.JsonSerializer.Serialize(new
            {
                targetWorkflowId = Guid.NewGuid(),
                windowMinutes = 15,
                prompt = AnalystProcessorTests.StagedPrompt,
                panelSet = new[] { "queue-wait", "step-outcomes" },
                maxIterations = 12,
                maxTokens = 1_000_000,
                wallClockSeconds = 240,
            }),
            incomingExecutionId,
            CancellationToken.None);

        return Assert.Single(sends);
    }

    [Fact]
    public async Task AnEntryDispatchOpensANewLineage()
    {
        // Guid.Empty is what an entry step is handed. Passing it straight on produces a branch the
        // exporter cannot read.
        var sent = await SendFor(Guid.Empty);

        Assert.NotEqual(Guid.Empty, sent.ExecutionId);
    }

    [Fact]
    public async Task ADispatchThatAlreadyHasALineageStaysInIt()
    {
        // The conditional matters both ways: an Analyst wired downstream of something else is
        // continuing that lineage and must not fork a new one.
        var existing = Guid.NewGuid();

        var sent = await SendFor(existing);

        Assert.Equal(existing, sent.ExecutionId);
    }
}
