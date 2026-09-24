using System.Text.Json;
using Json.Schema;
using Microsoft.Extensions.Logging;
using Processor.Analyst.Model;
using Processor.Analyst.Panels;
using Processor.Analyst.Tools;

namespace Processor.Analyst.Loop;

/// <summary>
/// Hypothesis, gather, revise, gather again — until the model calls a terminal tool or a ceiling is
/// reached. The loop owns the ceilings, the trace and every tool execution; the model owns only the
/// judgment.
/// </summary>
internal sealed class InvestigationLoop(
    IAnalystModel model,
    IPanelReader panels,
    TimeProvider clock,
    ILogger<InvestigationLoop> logger)
{
    internal async Task<LoopOutcome> RunAsync(
        string system, AnalystConfig config, TimeRange window, string promptHash, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(config);

        var budget = new BudgetLedger(
            config.MaxIterations, config.MaxTokens, TimeSpan.FromSeconds(config.WallClockSeconds), clock);
        var trace = new InvestigationTrace();
        var tools = ToolCatalog.Build([.. config.PanelSet.Select(panels.Describe)]);
        var transcript = new List<ModelTurn>
        {
            new(ModelRole.User,
                $"Investigate workflow {config.TargetWorkflowId} over {window.From:O} to {window.To:O}.",
                [], []),
        };

        while (budget.BeginTurn())
        {
            var reply = await model.SendAsync(system, transcript, tools, ct).ConfigureAwait(false);
            budget.RecordUsage(reply.InputTokens, reply.OutputTokens);

            if (budget.Exhausted)
            {
                throw new AnalysisImpossibleException(budget.Why!);
            }

            if (reply.ToolCalls.Count == 0)
            {
                // The model talked instead of acting. Nothing was executed, so there is nothing to
                // report and no way to continue honestly.
                throw new AnalysisImpossibleException(
                    "the model returned no tool calls; the investigation cannot proceed");
            }

            transcript.Add(new ModelTurn(ModelRole.Assistant, reply.Text, reply.ToolCalls, []));

            // A terminal call ends the run even if it arrived alongside others: there is nothing
            // after the end.
            var terminal = reply.ToolCalls.FirstOrDefault(c => ToolNames.Terminal.Contains(c.ToolName));
            if (terminal is not null)
            {
                return Terminate(terminal, trace, window, promptHash);
            }

            // EVERY result for this reply goes back in ONE user turn. Splitting them across several
            // silently trains the model to stop making parallel calls.
            var results = new List<ModelToolResult>(reply.ToolCalls.Count);
            foreach (var call in reply.ToolCalls)
            {
                results.Add(await ExecuteAsync(call, window, trace, config, tools, ct).ConfigureAwait(false));
            }

            transcript.Add(new ModelTurn(ModelRole.User, null, [], results));
        }

        throw new AnalysisImpossibleException(budget.Why!);
    }

    private async Task<ModelToolResult> ExecuteAsync(
        ModelToolCall call,
        TimeRange window,
        InvestigationTrace trace,
        AnalystConfig config,
        IReadOnlyList<ToolSpec> tools,
        CancellationToken ct)
    {
        // Client-side validation, always. Server-side `strict` enforcement exists on one adapter and
        // not the other, so trusting it would make the on-prem path silently laxer than the tests.
        // The schema is resolved from the catalog THIS loop already built, not re-derived from
        // ToolCatalog.SchemaFor: that static lookup has no case for read_panel (its schema depends on
        // the panel set, which only the catalog instance carries) and no case at all for a name the
        // model invented. An unrecognised tool name fails this same lookup and comes back as an error
        // tool_result -- a thing to correct the model on, not a reason to crash the loop.
        if (!Validates(call, tools))
        {
            logger.LogWarning("tool {Tool} was called with an input that fails its own schema", call.ToolName);
            return new ModelToolResult(call.CallId, $"input does not match the schema for {call.ToolName}", IsError: true);
        }

        switch (call.ToolName)
        {
            case ToolNames.ListPanels:
                var described = config.PanelSet.Select(panels.Describe);
                return new ModelToolResult(call.CallId, JsonSerializer.Serialize(described), IsError: false);

            case ToolNames.ReadPanel:
                var panelId = call.Input.GetProperty("panelId").GetString()!;
                PanelReading reading;
                try
                {
                    reading = await panels.ReadAsync(panelId, window, ct).ConfigureAwait(false);
                }
                catch (PanelUnavailableException ex)
                {
                    // The evidence source could not be reached. That is not a poor reading the agent
                    // can reason around -- it means the analysis cannot be completed.
                    throw new AnalysisImpossibleException(ex.Message);
                }

                trace.Record(panelId, reading.SampleCount > 0);
                return new ModelToolResult(call.CallId, JsonSerializer.Serialize(reading), IsError: false);

            default:
                // The five record_* tools. The loop keeps the artifact on the transcript, which is
                // where Task 9's assertions read them from, and acknowledges it.
                return new ModelToolResult(call.CallId, "recorded", IsError: false);
        }
    }

    /// <summary>
    /// Resolves the tool's schema from the catalog this loop already built, rather than
    /// <c>ToolCatalog.SchemaFor</c>: that method has no case for <c>read_panel</c> (built from the
    /// panel set inside <c>ToolCatalog.Build</c>) and would throw on the most common call, and it has
    /// no case at all for a tool name the model invented. A name absent from the catalog is treated
    /// as an invalid call -- handled by the caller as an error <c>tool_result</c> -- never an
    /// exception.
    /// </summary>
    private static bool Validates(ModelToolCall call, IReadOnlyList<ToolSpec> tools)
    {
        var spec = tools.FirstOrDefault(t => t.Name == call.ToolName);
        if (spec is null)
        {
            return false;
        }

        var schema = JsonSchema.FromText(spec.InputSchemaJson);
        return schema.Evaluate(call.Input).IsValid;
    }

    private static LoopOutcome Terminate(
        ModelToolCall terminal, InvestigationTrace trace, TimeRange window, string promptHash)
    {
        if (terminal.ToolName == ToolNames.ReportNoFinding)
        {
            return new LoopOutcome.NoFinding(terminal.Input.GetProperty("reason").GetString()!);
        }

        var input = terminal.Input;

        var finding = new AnalystFinding(
            Verdict: input.GetProperty("verdict").GetString()!,
            Window: new RealizedWindow(window.From, window.To, input.GetProperty("samplesExamined").GetInt32()),
            Narrative: input.GetProperty("narrative").GetString()!,
            Evidence: [.. input.GetProperty("evidence").EnumerateArray().Select(e => new FindingEvidence(
                e.GetProperty("panelId").GetString()!,
                e.GetProperty("layer").GetString()!,
                e.GetProperty("label").GetString()!,
                e.GetProperty("value").GetString()!))],
            RuledOut: [.. input.GetProperty("ruledOut").EnumerateArray().Select(r => new RuledOutHypothesis(
                r.GetProperty("hypothesis").GetString()!,
                r.GetProperty("disconfirmingCriterion").GetString()!,
                r.GetProperty("whatWasSeen").GetString()!))],
            // The loop's own record, never the model's claim about it.
            Trace: trace.Entries,
            PromptHash: promptHash);

        return new LoopOutcome.Finding(finding);
    }
}
