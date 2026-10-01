using System.Text.Json;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace Processor.Analyst.Graph;

/// <summary>
/// Reads the running graph from the projection the start wrote: <c>skp:wf:{id}</c>'s <c>store</c>
/// field, deserialized with the same contract and options the orchestrator reads it with, plus the
/// workflow's membership of <c>skp:live</c> and the names of everything in it.
/// <para>
/// <b>Never fails the dispatch.</b> A graph the model cannot see costs it context, not the run: an
/// absent projection, an unreadable one or an unreachable store comes back as
/// <see cref="GraphBriefing.Missing"/> with the reason, and the model is told exactly that. An absent
/// projection is itself evidence — a workflow that is not started has none.
/// </para>
/// </summary>
internal sealed class L2WorkflowGraphSource(IConnectionMultiplexer redis, IEntityNameSource? names = null)
    : IWorkflowGraphSource
{
    private static readonly TimeSpan NameBudget = TimeSpan.FromSeconds(2);

    public async Task<GraphBriefing> ReadAsync(Guid workflowId, CancellationToken ct)
    {
        WorkflowStoreProjection? store;
        bool live;

        try
        {
            var db = redis.GetDatabase();
            var raw = await db.HashGetAsync(L2ProjectionKeys.Workflow(workflowId), L2ProjectionKeys.StoreField)
                .WaitAsync(ct).ConfigureAwait(false);
            live = await db.SetContainsAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"))
                .WaitAsync(ct).ConfigureAwait(false);

            if (raw.IsNullOrEmpty)
            {
                return GraphBriefing.Missing(live
                    ? "the workflow is in the live set but has no projected graph"
                    : "the workflow has no projected graph and is not in the live set: it is not started");
            }

            store = JsonSerializer.Deserialize<WorkflowStoreProjection>(raw.ToString(), MessagingJson.Options);
        }
        catch (Exception ex) when (ex is RedisException or JsonException or TimeoutException)
        {
            return GraphBriefing.Missing($"the running graph could not be read: {ex.GetType().Name}: {ex.Message}");
        }

        if (store is null)
        {
            return GraphBriefing.Missing("the projected graph deserialized to nothing");
        }

        return GraphBriefing.Of(new RunningGraph(
            workflowId, live, store.Cron, store.EntryStepIds, store.Steps,
            await NamesAsync(workflowId, store).ConfigureAwait(false)));
    }

    /// <summary>Best effort and bounded, like the finding's target name: a name is context, never a reason to fail.</summary>
    private async Task<IReadOnlyDictionary<Guid, string>> NamesAsync(Guid workflowId, WorkflowStoreProjection store)
    {
        if (names is null)
        {
            return new Dictionary<Guid, string>();
        }

        EntityRef[] refs =
        [
            new(L2EntityKind.Workflow, workflowId),
            .. store.Steps.Select(s => new EntityRef(L2EntityKind.Step, s.StepId)),
            .. store.Steps.Select(s => s.ProcessorId).Distinct().Select(p => new EntityRef(L2EntityKind.Processor, p)),
        ];

        try
        {
            return await names.ReadNamesAsync(refs).WaitAsync(NameBudget).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return new Dictionary<Guid, string>();
        }
    }
}
