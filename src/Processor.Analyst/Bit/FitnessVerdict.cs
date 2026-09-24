namespace Processor.Analyst.Bit;

/// <summary>One thing wrong with one stage of the prompt under evaluation.</summary>
/// <param name="Stage">research | validate | plan | execute | verify</param>
/// <param name="Kind">missing | malformed | contradicting</param>
/// <param name="Offending">The text the judge is objecting to, quoted, so a human can see what it saw.</param>
internal sealed record StageProblem(string Stage, string Kind, string Offending);

/// <summary>
/// The BIT's answer.
/// <para>
/// <b>The judge fills in <see cref="Problems"/>; this type decides <see cref="Fit"/>.</b> The model is
/// never asked whether the prompt passes — only what is wrong with it. A judge that can emit a
/// free-form "looks fine" is a gate that can talk itself into passing.
/// </para>
/// </summary>
internal sealed record FitnessVerdict(bool Fit, IReadOnlyList<StageProblem> Problems)
{
    /// <summary>The compiled threshold: any problem at all is unfit.</summary>
    internal static FitnessVerdict From(IReadOnlyList<StageProblem> problems)
        => new(problems.Count == 0, problems);
}
