namespace BaseProcessor.Core.Processing;

/// <summary>
/// An author ending their step with an explicit outcome.
/// <para>
/// <b>Thrown rather than returned, deliberately.</b> <c>ProcessAsync</c> returns nothing — the author
/// sends branches through a helper — so there is no return value left to carry an outcome. A
/// <c>ReportFailure(...)</c> method would also let execution continue afterwards, so an author who
/// forgot to return could report a failure and then send a branch, producing both a failure and a
/// success for one step. Throwing makes the abort structural instead of a discipline to remember.
/// </para>
/// <para>
/// The message reaches the orchestrator verbatim. That is safe precisely because an author wrote it;
/// a framework-caught exception's message never does.
/// </para>
/// </summary>
public abstract class ProcessStatusException(string message) : Exception(message);

/// <summary>The step failed for a business reason. Maps to <c>StepFailed.ErrorMessage</c>.</summary>
public sealed class FailedException(string message) : ProcessStatusException(message);

/// <summary>
/// The step ended its branch and wants the orchestrator told. Maps to
/// <c>StepCancelled.CancellationMessage</c>.
/// <para>
/// Distinct from returning without sending, which is also a legitimate way to end a branch — a sink
/// with no successor, or a filter dropping data. Use this one when a successor gated on a cancelled
/// predecessor needs to know it happened.
/// </para>
/// </summary>
public sealed class CancelledException(string message) : ProcessStatusException(message);
