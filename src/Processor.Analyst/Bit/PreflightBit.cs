using Json.Schema;
using Processor.Analyst.Model;

namespace Processor.Analyst.Bit;

/// <summary>
/// Checked every dispatch, run on a cache miss. One model call — the scenario lives inside the
/// judging prompt as text, so there is no tool loop, no panel read and no fixture reader.
/// </summary>
internal sealed class PreflightBit(IAnalystModel model, BitCache cache)
{
    internal async Task<FitnessVerdict> CheckAsync(string prompt, CancellationToken ct)
    {
        var hash = PromptHash.Of(prompt);

        if (cache.TryGet(hash, out var cached))
        {
            return cached;
        }

        ModelTurn[] transcript = [new(ModelRole.User, BitPrompt.Wrap(prompt), [], [])];

        var reply = await model
            .SendAsync(BitPrompt.System, transcript, [BitPrompt.Tool], ct)
            .ConfigureAwait(false);

        var call = reply.ToolCalls.FirstOrDefault(c => c.ToolName == BitPrompt.ToolName)
            ?? throw new InvalidOperationException(
                "the fitness judge answered without calling report_fitness; a verdict it can phrase "
                + "freely is a gate that can talk itself into passing");

        // Client-side validation, same as every tool call InvestigationLoop trusts: there is no
        // server-side `strict` enforcement on the on-prem path, and there is no retry here to hand a
        // malformed call back to the model for correction -- this is one call, not a loop. A
        // report_fitness that fails its own schema means the gate could not evaluate the prompt at
        // all, which is the same class of failure as the judge never calling it.
        if (!JsonSchema.FromText(BitPrompt.Tool.InputSchemaJson).Evaluate(call.Input).IsValid)
        {
            throw new InvalidOperationException(
                "the fitness judge's report_fitness call does not match its own schema; a malformed "
                + "verdict cannot be trusted as either a pass or a fail");
        }

        var verdict = FitnessVerdict.From(BitPrompt.Read(call.Input));

        cache.Put(hash, verdict);

        return verdict;
    }
}
