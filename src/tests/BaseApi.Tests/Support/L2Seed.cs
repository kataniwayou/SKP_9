using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;

namespace BaseApi.Tests.Support;

/// <summary>Puts a workflow into an <see cref="InMemoryL2"/> exactly as a start leaves it.</summary>
internal static class L2Seed
{
    public static Task StoreAsync(InMemoryL2 l2, WorkflowL1 definition) =>
        l2.Db.HashSetAsync(
            L2ProjectionKeys.Workflow(definition.WorkflowId), L2ProjectionKeys.StoreField,
            JsonSerializer.Serialize(
                new WorkflowStoreProjection(definition.EntryStepIds, definition.Cron, definition.Steps),
                MessagingJson.Options));

    public static async Task LiveAsync(InMemoryL2 l2, WorkflowL1 definition)
    {
        await StoreAsync(l2, definition);
        await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), definition.WorkflowId.ToString("D"));
    }
}
