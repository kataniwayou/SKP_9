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
/// <b>The message is logged, not sent.</b> A <c>StepOutcome</c> carries no text at all, so this
/// string reaches an operator through this processor's own records, found by joining on the ids the
/// log scope carries. Author-authored text is safe to render verbatim there; a framework-caught
/// exception's message is not, and no longer has any route to the wire to be kept off.
/// </para>
/// <para>
/// <b>Pass the cause as <paramref name="innerException"/> whenever translating one.</b> The message
/// summarises; the inner exception is the only thing that says WHY. An author that reports
/// "the model backend could not be reached" and drops the <c>SocketException</c> underneath has
/// produced a step failure nobody can diagnose -- the distinction between DNS, a refused connection
/// and a TLS fault is gone, and the pod holding the detail is usually gone too by the time anyone
/// looks. <c>ProcessDispatchHandler</c> logs this exception object, so an inner exception reaches
/// Elasticsearch as exception.type, exception.message and exception.stacktrace. It never reaches the
/// wire: a StepOutcome still carries no text.
/// </para>
/// </summary>
public abstract class ProcessStatusException(string message, Exception? innerException = null)
    : Exception(message, innerException);

/// <summary>
/// The step failed for a business reason. Reported as a <c>StepOutcome</c> of
/// <c>StepResult.Failed</c>, whose entry id names the input this step did not consume.
/// </summary>
public sealed class FailedException(string message, Exception? innerException = null)
    : ProcessStatusException(message, innerException);

/// <summary>
/// The step ended its branch and wants the orchestrator told. Reported as a <c>StepOutcome</c> of
/// <c>StepResult.Cancelled</c>.
/// <para>
/// Distinct from returning without sending, which is also a legitimate way to end a branch — a sink
/// with no successor, or a filter dropping data. Use this one when a successor gated on a cancelled
/// predecessor needs to know it happened.
/// </para>
/// </summary>
public sealed class CancelledException(string message, Exception? innerException = null)
    : ProcessStatusException(message, innerException);
