namespace Processor.Analyst.Loop;

/// <summary>
/// The analysis could not run. NOT a verdict about the system — a verdict is never a failure, good or
/// bad. This is the loop's internal signal; <c>AnalystProcessor</c> turns it into a
/// <c>FailedException</c> so the step is loud in the boards and the exporter never fires.
/// <para>
/// The distinction it protects: "everything is fine" and "I could not see" must never reach an
/// operator as the same event. Silence is the all-clear, so an agent that could not analyse must not
/// be silent.
/// </para>
/// </summary>
internal sealed class AnalysisImpossibleException(string why, Exception? innerException = null)
    : Exception(why, innerException);
