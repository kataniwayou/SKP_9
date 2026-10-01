namespace Processor.Analyst.Loop;

/// <summary>
/// The analysis could not run. NOT a verdict about the system — a verdict is never a failure, good or
/// bad. This is the loop's internal signal; <c>AnalystProcessor</c> turns it into a
/// <c>FailedException</c> so the step is loud in the boards and the exporter never fires.
/// <para>
/// It covers the facilities only: a payload, model or panel source that did not work, or a reply
/// that is not a valid result. The model's own conclusions -- including "the evidence it returned
/// cannot be believed" -- never land here; they complete as a Quiet or Inconclusive document. A
/// facility failure is different: it fails the step and publishes nothing, so a Quiet verdict can
/// only ever come from a run whose tools answered.
/// </para>
/// </summary>
internal sealed class AnalysisImpossibleException(string why, Exception? innerException = null)
    : Exception(why, innerException);
