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

        var wallClock = TimeSpan.FromSeconds(config.WallClockSeconds);
        var budget = new BudgetLedger(config.MaxIterations, config.MaxTokens, wallClock, clock);
        var trace = new InvestigationTrace();
        var artifacts = new StageArtifacts();
        var tools = ToolCatalog.Build([.. config.PanelSet.Select(panels.Describe)]);
        var transcript = new List<ModelTurn>
        {
            new(ModelRole.User,
                $"Investigate workflow {config.TargetWorkflowId} over {window.From:O} to {window.To:O}.",
                [], []),
        };

        // F5: BudgetLedger's wall-clock check only runs BETWEEN turns (BeginTurn), so it bounds the
        // gap between model calls, never a single call itself. Production passes
        // CancellationToken.None all the way down and the model client is configured with
        // Timeout.InfiniteTimeSpan -- deliberately, because a thinking model at `high` effort can
        // legitimately run for minutes -- so without this a hung model call would wedge the pod's
        // one consumer indefinitely while the liveness probe kept passing, and the pod would stay
        // green forever, processing nothing. `dispatchCt` is what actually bounds the
        // model call and every panel read below; `ct` itself is left untouched so a cancellation
        // from THIS deadline can still be told apart, by AnalystProcessor's existing filter, from
        // the caller's own token being cancelled. Timer-based, driven by `clock` rather than real
        // time, so a test can arm and trip it with a FakeTimeProvider exactly like BudgetLedger's
        // own deadline.
        using var deadlineOnlyCts = new CancellationTokenSource(wallClock, clock);
        using var deadlineCts = CancellationTokenSource.CreateLinkedTokenSource(ct, deadlineOnlyCts.Token);
        var dispatchCt = deadlineCts.Token;

        while (budget.BeginTurn())
        {
            var reply = await model.SendAsync(system, transcript, tools, dispatchCt).ConfigureAwait(false);

            // Usage is recorded before anything else, but the budget is not enforced yet: a reply
            // that both answers and crosses a ceiling still carries an answer that was already paid
            // for, and the budget must not throw it away underneath a terminal call.
            budget.RecordUsage(reply.InputTokens, reply.OutputTokens);

            if (reply.ToolCalls.Count == 0)
            {
                // The model talked instead of acting. Nothing was executed, so there is nothing to
                // report and no way to continue honestly.
                throw new AnalysisImpossibleException(
                    "the model returned no tool calls; the investigation cannot proceed");
            }

            transcript.Add(new ModelTurn(ModelRole.Assistant, reply.Text, reply.ToolCalls, []));

            var terminalCalls = reply.ToolCalls.Where(c => ToolNames.Terminal.Contains(c.ToolName)).ToArray();

            if (terminalCalls.Length > 1)
            {
                // A self-contradicting reply -- e.g. both submit_finding and report_no_finding -- is
                // a broken run, not a quiet one. Resolving it by list position would let the same two
                // calls export a finding in one order and report silence in the other.
                throw new AnalysisImpossibleException(
                    "the model called more than one terminal tool in the same reply: "
                    + string.Join(", ", terminalCalls.Select(c => c.ToolName)));
            }

            if (terminalCalls.Length == 1 && Validates(terminalCalls[0], tools))
            {
                // The only path whose payload becomes a persisted, frozen-schema document (or is
                // read as the reason for silence) gets the same client-side validation as every
                // other call before it is trusted. A terminal call ends the run even if it arrived
                // alongside others: there is nothing after the end, so nothing else in this reply is
                // executed and no non-terminal sibling leaves a trace entry behind.
                return Terminate(terminalCalls[0], artifacts, trace, window, promptHash);
            }

            // Either there was no terminal call, or the one terminal call failed its own schema. A
            // schema-invalid terminal call is handled by the SAME client-side validation as any other
            // call -- inside ExecuteAsync -- and comes back as an error tool_result the model can
            // correct, never a crash and never an unchecked document. Every call in this reply
            // still needs a matching result before the transcript goes back to the model, so siblings
            // run normally.
            //
            // EVERY result for this reply goes back in ONE user turn. Splitting them across several
            // silently trains the model to stop making parallel calls.
            var results = new List<ModelToolResult>(reply.ToolCalls.Count);
            foreach (var call in reply.ToolCalls)
            {
                results.Add(await ExecuteAsync(call, window, trace, artifacts, config, tools, dispatchCt).ConfigureAwait(false));
            }

            transcript.Add(new ModelTurn(ModelRole.User, null, [], results));

            // Only now, with a terminal call either absent or already handled as an error the model
            // can act on, does the budget get to end the run. An invalid terminal call still
            // falls through to this check rather than looping forever against an exhausted budget.
            if (budget.Exhausted)
            {
                throw new AnalysisImpossibleException(budget.Why!);
            }
        }

        throw new AnalysisImpossibleException(budget.Why!);
    }

    private async Task<ModelToolResult> ExecuteAsync(
        ModelToolCall call,
        TimeRange window,
        InvestigationTrace trace,
        StageArtifacts artifacts,
        AnalystConfig config,
        IReadOnlyList<ToolSpec> tools,
        CancellationToken ct)
    {
        // Client-side validation, always. No server-side schema enforcement may ever be load-bearing
        // above the seam, regardless of what any single backend happens to enforce -- see
        // IAnalystModel's own doc comment.
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
                    reading = await panels.ReadAsync(panelId, config.TargetWorkflowId, window, ct).ConfigureAwait(false);
                }
                catch (PanelUnavailableException ex)
                {
                    // The evidence source could not be reached. That is not a poor reading the agent
                    // can reason around -- it means the analysis cannot be completed.
                    throw new AnalysisImpossibleException(ex.Message, ex);
                }

                trace.Record(panelId, reading.SampleCount > 0);
                return new ModelToolResult(call.CallId, JsonSerializer.Serialize(reading), IsError: false);

            case ToolNames.RecordValidation:
                artifacts.Record(call.ToolName, call.Input, trace.Entries.Count);

                // F2 / design §15, §18.6: validate OWNS the Cancelled-vs-Failed call. `analysable`
                // is the field that call is made through, and before this nothing in production
                // code read it -- a compliant model that correctly concluded it could not see the
                // window had no terminal tool that said so, and report_no_finding's own description
                // ("the analysis ran and its result does not contribute") was the closest match it
                // would find. That reaches the operator as the same event as "everything is fine",
                // which §3.1 exists to prevent. An unanalysable window is not a quiet ending; it is
                // an analysis that could not run.
                if (!call.Input.GetProperty("analysable").GetBoolean())
                {
                    throw new AnalysisImpossibleException(
                        "validate found the window unanalysable: " + call.Input.GetProperty("reason").GetString());
                }

                return new ModelToolResult(call.CallId, "recorded", IsError: false);

            default:
                // The five record_* tools. Keeping the artifact -- and how many panels the trace had
                // already recorded a read for at this moment -- is what makes the cross-reference
                // checks at termination possible; acknowledging it is what keeps the model moving.
                artifacts.Record(call.ToolName, call.Input, trace.Entries.Count);
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
        ModelToolCall terminal, StageArtifacts artifacts, InvestigationTrace trace, TimeRange window, string promptHash)
    {
        if (terminal.ToolName == ToolNames.ReportNoFinding)
        {
            // There is no finding to cross-reference, but there is still a claim that the analysis
            // RAN -- and presence of the five stage artifacts alone does not prove it: the record_*
            // schemas require only non-empty strings, so five invented stage calls followed by
            // report_no_finding would otherwise pass with the trace still empty. Silence is the
            // all-clear, so an unearned silence must fail just as loudly as an unearned finding --
            // CheckNoFindingIsGrounded checks presence AND cross-references the plan's panelsToRead
            // and the verification's citedPanels against the trace, the same ground truth the
            // finding path is checked against.
            var stageProblems = StageAssertions.CheckNoFindingIsGrounded(artifacts, trace);
            if (stageProblems.Count > 0)
            {
                throw new AnalysisImpossibleException(
                    "report_no_finding was called without completing the investigation: "
                    + string.Join("; ", stageProblems));
            }

            return new LoopOutcome.NoFinding(terminal.Input.GetProperty("reason").GetString()!);
        }

        var input = terminal.Input;

        // A finding that fails these is not a weaker finding, it is an investigation whose own record
        // does not support it -- so it must not be exported, and it must not be silent either.
        var problems = StageAssertions.Check(artifacts, trace, input);
        if (problems.Count > 0)
        {
            throw new AnalysisImpossibleException(
                "the investigation's own record does not support its finding: " + string.Join("; ", problems));
        }

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
            // The loop's own record, never the model's claim about it. Copied rather than passed by
            // reference so the finding does not alias live loop state that a caller could still be
            // writing to.
            Trace: [.. trace.Entries],
            PromptHash: promptHash);

        return new LoopOutcome.Finding(finding);
    }
}
