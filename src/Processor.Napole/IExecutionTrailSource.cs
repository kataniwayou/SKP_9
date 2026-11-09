namespace Processor.Napole;

public interface IExecutionTrailSource
{
    /// <summary>
    /// One trail per execution of <paramref name="section"/>'s workflow whose first outcome at its
    /// <c>FromStepId</c> falls inside <paramref name="window"/>, looked for across
    /// <see cref="ReportWindow.TrailSpan"/>. Any answer that could be short -- unreachable, partial,
    /// non-2xx, at the row limit -- is a <c>FailedException</c>, never a smaller list.
    /// </summary>
    Task<IReadOnlyList<ExecutionTrail>> ReadAsync(
        WatchedSection section, ReportWindow window, TimeSpan trail, CancellationToken ct);
}
