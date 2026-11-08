namespace Processor.Napole;

public interface IExecutionTrailSource
{
    /// <summary>
    /// One trail per execution the kafka-importer imported for <paramref name="workflowId"/> inside
    /// <paramref name="window"/>, looked for across <see cref="ReportWindow.TrailSpan"/>. An execution
    /// with no records in that span comes back with every count 0. Any answer that could be short --
    /// unreachable, partial, non-2xx, at the row limit -- is a <c>FailedException</c>, never a smaller list.
    /// </summary>
    Task<IReadOnlyList<ExecutionTrail>> ReadAsync(Guid workflowId, ReportWindow window, TimeSpan trail, CancellationToken ct);
}
