namespace Processor.Analyst.Loop;

/// <summary>
/// How an investigation ended, when it ended at all. There is no third case: anything that is not one
/// of these two throws <see cref="AnalysisImpossibleException"/>, because the only two legitimate
/// endings are the two terminal tools.
/// </summary>
internal abstract record LoopOutcome
{
    /// <summary>The model called <c>submit_finding</c>. Maps to a Completed step and an export.</summary>
    internal sealed record Finding(AnalystFinding Value) : LoopOutcome;

    /// <summary>
    /// The analysis ran and reached no insight: the model called <c>report_no_finding</c>
    /// (<c>Quiet</c>) or judged its evidence unbelievable (<c>Inconclusive</c>). It still carries a
    /// document, and still maps to a Completed step and an export -- a conclusion never decides the
    /// step, and "nothing wrong" must reach the topic as plainly as a finding does.
    /// </summary>
    internal sealed record NoFinding(string Reason, AnalystFinding Value) : LoopOutcome;
}
