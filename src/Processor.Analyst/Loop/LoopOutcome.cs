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

    /// <summary>The model called <c>report_no_finding</c>. Maps to a Cancelled step and silence.</summary>
    internal sealed record NoFinding(string Reason) : LoopOutcome;
}
