using BaseProcessor.Core.Processing;
using Messaging.Transport;

namespace BaseApi.Tests.Support;

/// <summary>The dispatch state an author test opens: branches go to <paramref name="sender"/>.</summary>
internal static class TestDispatch
{
    public static DispatchState State(
        IQueueSender sender, Guid correlationId, Guid workflowId, Guid stepId, Guid processorId,
        Guid inputEntryId = default)
        => new(new SenderBranchSink(sender), inputEntryId, correlationId, workflowId, stepId, processorId);
}
