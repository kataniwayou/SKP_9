using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;

namespace BaseApi.Tests.Support;

/// <summary>
/// A branch sink that hands each finished branch to a substituted sender, so an author test keeps
/// capturing <see cref="ProcessedData"/> with <c>Arg.Do&lt;ProcessedData&gt;</c> exactly as it did
/// when branches went to the post queue. Through <c>SendTransientAsync</c>, so a substituted fault is
/// classified the same way a real send fault is.
/// <para>
/// The queue and type names are literals on purpose: no queue exists, and nothing must look up a
/// production constant that Part 3 of the in-process post plan deletes.
/// </para>
/// </summary>
internal sealed class SenderBranchSink(IQueueSender sender) : IBranchSink
{
    public Task FinishAsync(ProcessedData branch, CancellationToken ct)
        => sender.SendTransientAsync("test-branch-sink", "processed-data", branch, ct);
}
