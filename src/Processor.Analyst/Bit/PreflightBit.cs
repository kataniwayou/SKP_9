using Json.Schema;
using Microsoft.Extensions.Logging;
using Processor.Analyst.Loop;
using Processor.Analyst.Model;

namespace Processor.Analyst.Bit;

/// <summary>
/// Checked every dispatch, decided once per prompt and model for every replica of the processor.
/// <para>
/// <b>The judge is a sampler, not a function.</b> Identical prompt text returns different verdicts
/// run to run: measured against <c>kimi-k3</c>, <c>temperature</c> other than 1 is rejected
/// (<c>400 "only 1 is allowed for this model"</c>), a forced <c>tool_choice</c> is rejected as
/// <c>"incompatible with thinking enabled"</c>, thinking cannot be switched off, and <c>seed</c> is
/// accepted but not honoured. No request parameter can make this reproducible, so a cold prompt is
/// judged by <see cref="QuorumSize"/> ballots with
/// <see cref="CorroborationThreshold"/>-way corroboration rather than one draw.
/// </para>
/// <para>
/// <b>Three parts, cheapest first, each able to reject on its own.</b>
/// <see cref="PromptStructure"/> is mechanical and free; the judge costs a few calls and grades
/// method against a hypothetical; <see cref="GroundTruthRehearsal"/> costs two full
/// investigations and is the only part that checks the prompt reaches the right CONCLUSION. The
/// ordering is not tidiness: a structureless prompt must never cost a model call, and an unfit one
/// must never cost a rehearsal.
/// </para>
/// <para>
/// <b>The verdict is shared by every replica and dies with the last one.</b> It lives in L2 as a
/// shared entry (see <see cref="BitCache"/>), re-armed by every replica's heartbeat, so a replica that
/// joins inherits the verdict its siblings earned instead of re-paying the gate. This reverses an
/// earlier per-process design, and with it the property that a restart re-proves fitness: a rolling
/// deploy never lets the entry lapse. What still clears a verdict is a changed prompt (a new hash), a
/// changed model, effort or image (a stamp mismatch), or every replica gone for one liveness TTL.
/// </para>
/// </summary>
internal sealed class PreflightBit(
    IAnalystModel model,
    BitCache cache,
    GroundTruthRehearsal? rehearsal = null,
    ILogger<PreflightBit>? logger = null,
    Microsoft.Extensions.Options.IOptions<AnalystBitOptions>? options = null)
{
    /// <summary>Read once, at construction: an unparseable mode fails the first resolve, not a dispatch.</summary>
    private readonly BitMode _mode = options?.Value.Mode ?? BitMode.Full;

    /// <summary>
    /// Ballots cast on a cold prompt. Odd, so a majority always exists. Paid once per prompt, and
    /// what stops a single unlucky draw from deciding a prompt's fate for every replica.
    /// </summary>
    private const int QuorumSize = 5;

    /// <summary>
    /// How many ballots must flag the SAME stage before it counts as a real defect.
    /// <para>
    /// <b>Corroboration, not unanimity, and it is measured rather than guessed.</b> Across ~50 runs
    /// the pattern was consistent: a genuine defect is flagged repeatedly (the read-everything fault
    /// drew <c>plan: malformed</c> on 3 of 3), while a spurious one appears exactly once and lands on
    /// a different stage next time (four separate prompts each drew a single, isolated, non-repeating
    /// flag). Counting any single flag as fatal — which is what a verdict-level majority does — makes
    /// one judge's idiosyncratic reading sink a sound prompt, and that is what froze an UNFIT verdict
    /// for a prompt later measured at 6/6 fit.
    /// </para>
    /// <para>
    /// <b>The cost is recall on marginal defects, and it is real.</b> At this threshold a fault that
    /// only half the judges notice is let through about a third of the time. That is accepted because a
    /// false alarm blocks a sound prompt outright while a late catch still has a net under it:
    /// <see cref="Loop.StageAssertions"/> audits the finished investigation at runtime and rejects
    /// it anyway, which is exactly how the read-everything fault was caught when this exam missed it.
    /// </para>
    /// </summary>
    private const int CorroborationThreshold = 3;

    internal async Task<FitnessVerdict> CheckAsync(string prompt, CancellationToken ct)
    {
        if (_mode == BitMode.StructureOnly)
        {
            return CheckStructureOnly(prompt);
        }

        var hash = PromptHash.Of(prompt);

        if (await cache.GetAsync(hash).ConfigureAwait(false) is { } cached)
        {
            return cached;
        }

        // The mechanical check first: it is free, it is the same answer every time, and a prompt with
        // no stage structure must not cost five model calls to reject.
        var structural = PromptStructure.Check(prompt);

        if (structural.Count > 0)
        {
            // Not cached: it is deterministic and costs nothing to recompute, so a cache entry would
            // only be one more thing able to go stale.
            return FitnessVerdict.From(structural);
        }

        var verdict = await JudgeByQuorumAsync(prompt, ct).ConfigureAwait(false);

        // Third and last: the only part that reads anything. Run only once the judge is satisfied,
        // because a rehearsal is the expensive check and there is nothing to learn from replaying a
        // prompt already known to be unfit.
        if (verdict.Fit && rehearsal is not null)
        {
            var wrong = await rehearsal.RunAsync(prompt, ct).ConfigureAwait(false);

            if (wrong.Count > 0)
            {
                verdict = FitnessVerdict.From(wrong);
            }
        }

        // Cached fit or unfit alike. A known-bad prompt must not re-pay the full quorum on every
        // dispatch, and the operator is never stuck by it: tuning the prompt changes the hash, which
        // is a different entry and a fresh judgement.
        await cache.PutAsync(hash, verdict).ConfigureAwait(false);

        return verdict;
    }

    /// <summary>
    /// The proof-of-concept gate: the free heading check and nothing else.
    /// <para>
    /// <b>It never touches the shared store, in either direction.</b> Writing would be the dangerous
    /// half: a "fit" recorded here was never earned, and switching back to <see cref="BitMode.Full"/>
    /// under the same prompt, model and image would inherit it as if the judge and the rehearsal had
    /// passed. Reading is skipped too, so a stored unfit verdict cannot block a prompt the operator has
    /// deliberately chosen to run unexamined.
    /// </para>
    /// <para>
    /// A Warning on every dispatch, not once at startup, so no finding produced in this mode can be
    /// read later as having passed the gate.
    /// </para>
    /// </summary>
    private FitnessVerdict CheckStructureOnly(string prompt)
    {
        var structural = PromptStructure.Check(prompt);

        if (structural.Count == 0)
        {
            logger?.LogWarning(
                "the preflight BIT is in {Mode} mode: the prompt's structure passed, the judge and the "
                + "ground-truth rehearsal were skipped, and no verdict was read from or written to L2",
                BitMode.StructureOnly);
        }

        return FitnessVerdict.From(structural);
    }

    /// <summary>
    /// Casts up to <see cref="QuorumSize"/> ballots, one at a time, and returns the majority.
    /// <para>
    /// <b>Sequential, and it stops as soon as the outcome is settled.</b> Once enough ballots are in
    /// and no stage can still reach corroboration, nothing later can change the answer, so the rest
    /// are never cast. Sequential rather than concurrent because the only thing concurrency buys is
    /// latency on a path that runs once per prompt, and the BIT sits outside
    /// <c>WallClockSeconds</c> — <see cref="Loop.InvestigationLoop"/> opens that budget after the
    /// gate — so there is nothing for the saved seconds to protect.
    /// </para>
    /// <para>
    /// <b>A spoiled ballot is tolerated; a spoiled election is not.</b> An individual call can end in
    /// <see cref="AnalysisImpossibleException"/> — the judge answering in prose instead of calling
    /// the tool is the common one, and no request parameter can prevent it here because a forced
    /// <c>tool_choice</c> is incompatible with this model's thinking. Those ballots are discarded.
    /// But a verdict every replica will inherit must not rest on one voice, so fewer
    /// than <see cref="CorroborationThreshold"/> valid ballots throws rather than deciding, leaving
    /// the prompt unjudged for the next dispatch to retry.
    /// </para>
    /// </summary>
    private async Task<FitnessVerdict> JudgeByQuorumAsync(string prompt, CancellationToken ct)
    {
        List<FitnessVerdict> cast = [];

        for (var i = 0; i < QuorumSize; i++)
        {
            try
            {
                cast.Add(await JudgeAsync(prompt, ct).ConfigureAwait(false));
            }
            catch (AnalysisImpossibleException ex)
            {
                // Discarded, but never silently. A check that ends on "0 usable verdicts" is
                // undiagnosable without this: a prose answer, a refusing backend and a connection
                // that never opened all look the same from the count alone. The exception carries
                // the transport or HTTP cause as its inner exception.
                logger?.LogWarning(
                    ex, "the fitness judge's ballot {Ballot} of {Quorum} was spoiled and discarded: {Why}",
                    i + 1, QuorumSize, ex.Message);
                continue;
            }

            // Stop once the outcome is settled: enough ballots to decide, and no stage that could
            // still reach the threshold even if every remaining ballot flagged it.
            var remaining = QuorumSize - i - 1;

            var stillReachable = cast
                .SelectMany(v => v.Problems)
                .Select(p => p.Stage)
                .Distinct()
                .Any(s => Flagging(cast, s) + remaining >= CorroborationThreshold);

            if (cast.Count >= CorroborationThreshold && !stillReachable)
            {
                break;
            }
        }

        if (cast.Count < CorroborationThreshold)
        {
            throw new AnalysisImpossibleException(
                $"the fitness judge returned {cast.Count} usable verdict(s) out of {QuorumSize}; "
                + $"a verdict every replica inherits needs at least {CorroborationThreshold}");
        }

        // A stage is condemned only when enough judges independently name it. One judge's reading is
        // an opinion; three converging on the same stage is a defect.
        var condemned = cast
            .SelectMany(v => v.Problems)
            .GroupBy(p => p.Stage)
            .Where(g => Flagging(cast, g.Key) >= CorroborationThreshold)
            // Among the corroborated reports of one stage, keep the fullest text: this verdict is the
            // only thing an operator will see for this prompt.
            .Select(g => g.MaxBy(p => p.Offending?.Length ?? 0)!)
            .ToList();

        return FitnessVerdict.From(condemned);
    }

    /// <summary>
    /// How many ballots name this stage. Counted per BALLOT, not per problem: a judge that reports
    /// two faults in one stage is still one voice about that stage, and must not corroborate itself.
    /// </summary>
    private static int Flagging(IEnumerable<FitnessVerdict> cast, string stage)
        => cast.Count(v => v.Problems.Any(p => p.Stage == stage));

    /// <summary>One ballot: a single model call, validated client-side.</summary>
    private async Task<FitnessVerdict> JudgeAsync(string prompt, CancellationToken ct)
    {
        ModelTurn[] transcript = [new(ModelRole.User, BitPrompt.Wrap(prompt), [], [])];

        var reply = await model
            .SendAsync(BitPrompt.System, transcript, [BitPrompt.Tool], ct)
            .ConfigureAwait(false);

        var call = reply.ToolCalls.FirstOrDefault(c => c.ToolName == BitPrompt.ToolName)
            ?? throw new AnalysisImpossibleException(
                "the fitness judge answered without calling report_fitness; a verdict it can phrase "
                + "freely is a gate that can talk itself into passing: " + reply.Describe());

        // Client-side validation, same as every tool call InvestigationLoop trusts: no server-side
        // schema enforcement may ever be load-bearing above the seam, regardless of what the backend
        // happens to enforce, and there is no retry here to hand a malformed call back to the model
        // for correction -- this is one ballot, not a loop. A
        // report_fitness that fails its own schema means the gate could not evaluate the prompt at
        // all, which is the same class of failure as the judge never calling it -- and, like
        // InvestigationLoop's own PanelUnavailableException mapping, that is an
        // AnalysisImpossibleException, not a raw exception the framework's generic-fault path would
        // log as a processor bug.
        if (!JsonSchema.FromText(BitPrompt.Tool.InputSchemaJson).Evaluate(call.Input).IsValid)
        {
            throw new AnalysisImpossibleException(
                "the fitness judge's report_fitness call does not match its own schema; a malformed "
                + "verdict cannot be trusted as either a pass or a fail");
        }

        return FitnessVerdict.From(BitPrompt.Read(call.Input));
    }
}
