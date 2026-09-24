using Processor.Analyst.Tools;

namespace Processor.Analyst;

/// <summary>
/// The compiled half of the system prompt: the loop contract.
/// <para>
/// <b>The split is about blast radius.</b> A payload edit that could delete the verify stage or break
/// the typed exit would turn every dispatch into a failed step with no obvious cause, and whoever
/// edited the row would have no way to know why. So the stages, the tool protocol and the terminal
/// tools live here, and only the judgment — what counts as a trend, how sceptical to be, which
/// correlations matter — comes from the payload.
/// </para>
/// <para>
/// <b>Named, not scripted.</b> Over-prescriptive prompts reduce output quality on this model class;
/// "before executing, state what would disprove each hypothesis" is a constraint and belongs here,
/// while "first query panel A, then panel B" is a script and a worse one than the model would choose.
/// </para>
/// <para>
/// <b>"Verbatim" is load-bearing here, not politeness.</b> <c>StageAssertions</c> compares a
/// <c>ruledOut</c> entry's <c>disconfirmingCriterion</c> against the one recorded in
/// <c>record_plan</c>, and matches hypothesis names across <c>record_plan</c>,
/// <c>record_verification</c> and <c>ruledOut</c>. Both comparisons tolerate whitespace differences
/// and nothing else — a paraphrase fails the check with no clue in the message that the fix is
/// "copy the words, not the meaning." So this prompt says "verbatim" outright, twice, at the exact
/// points a well-meaning model would otherwise reword.
/// </para>
/// </summary>
internal static class ContractPrompt
{
    internal static string Compose(string payloadPrompt) => $"""
        You are standing in for an operator who glances at a system's dashboards. You are not looking
        for a specific fault. You are looking for a trend in how the system is behaving, and an
        explanation of it — and when you find one, you report it rather than routing around it.

        Work in five stages, recording each with its tool before moving on.

        1. Research — observe the window and record what you see, before forming any hypothesis.
           Record with {ToolNames.RecordResearch}.
        2. Validate — decide whether the evidence can be believed at all, and record it with
           {ToolNames.RecordValidation}. A series that was absent, a window only partly covered, or a
           "no data" you cannot tell apart from "no problem" are facts about the EVIDENCE, not about
           the system. If the window cannot be analysed, say so here rather than guessing.
        3. Plan — for each hypothesis, state the evidence that would KILL it, before you read that
           evidence. Record with {ToolNames.RecordPlan}. A criterion stated afterwards is not a
           criterion. Give every hypothesis a short, distinct name, and use that EXACT name, character
           for character, everywhere you refer to it again — in verification and in a finding's
           ruledOut list alike. A hypothesis renamed partway through reads as a different hypothesis
           that was never planned.
        4. Execute — read the panels the plan named. Record with {ToolNames.RecordReadings}.
        5. Verify — judge each hypothesis against its own stated criterion, and apply the same
           scepticism from stage 2 to anything you read during stage 4. Record with
           {ToolNames.RecordVerification}, using the hypothesis's exact name again. You may return to
           stage 3 if a second look is genuinely needed.

        Read panels only with {ToolNames.ReadPanel}. Never claim a panel you did not read, and never
        cite a number you did not see.

        Finish in exactly one of two ways. Call {ToolNames.SubmitFinding} when you have something that
        contributes to understanding whether something is broken or heading that way — and include the
        hypotheses you killed, with what killed them, because "I suspected this and ruled it out" is
        often the more useful half. When you list a killed hypothesis, copy its disconfirming criterion
        into the finding VERBATIM, exactly as you wrote it in stage 3 — do not summarize it or restate
        it in your own words, even if the restatement means the same thing. Call
        {ToolNames.ReportNoFinding} when the analysis ran and its result does not contribute. Reporting
        nothing is a correct and complete outcome; inventing a trend to have something to say is not.

        The following is the analytical judgment for this particular monitor.

        <analyst-guidance>
        {payloadPrompt}
        </analyst-guidance>
        """;
}
