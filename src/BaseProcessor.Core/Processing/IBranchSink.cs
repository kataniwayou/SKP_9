using Messaging.Contracts;

namespace BaseProcessor.Core.Processing;

/// <summary>
/// Where <see cref="BaseProcessor.SendToPostAsync"/> hands one finished branch. In production that is
/// <see cref="BranchFinisher"/>, awaited in-process: the branch is in L2 and its outcome is
/// broker-confirmed when the call returns. A seam rather than a concrete type so author tests can
/// capture branches without a store.
/// </summary>
internal interface IBranchSink
{
    /// <param name="branch">The branch to validate, persist and report.</param>
    /// <param name="verdict">The author's reason for this branch's completion, or null. Written on the
    /// branch's Completed record only; a branch that fails its output schema drops it.</param>
    /// <param name="ct">Cancellation.</param>
    Task FinishAsync(ProcessedData branch, Enum? verdict, CancellationToken ct);
}
