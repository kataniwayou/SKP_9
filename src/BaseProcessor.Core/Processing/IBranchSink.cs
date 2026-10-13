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
    Task FinishAsync(ProcessedData branch, CancellationToken ct);
}
