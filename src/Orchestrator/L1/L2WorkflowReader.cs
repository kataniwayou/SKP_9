using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Orchestrator.L1;

/// <summary>
/// Reads workflows out of L2. The one place in the orchestrator that knows L2's key layout, and the
/// one place in the orchestrator that touches Redis at all.
/// <para>
/// <b>It reads, and it never writes.</b> The API is the sole writer of L2 (spec invariant 1); the
/// orchestrator is a consumer of the API's projections. Three operations appear here —
/// <c>SetMembersAsync</c>, <c>StringGetAsync</c> and <c>KeyExistsAsync</c> — and no fourth is
/// permitted. A delete or a set here
/// would let this replica's view of the world become a fact about the world, which is precisely the
/// inversion the two invariants exist to prevent.
/// </para>
/// <para>
/// <b>A torn projection is survivable; a broken store is not this type's problem.</b> A step key
/// missing while its root still lists it is skipped with a warning: the workflow is worth running with
/// the steps that are there, and the next start rewrites the whole key set anyway. A Redis fault, by
/// contrast, propagates untouched — spec §7.4 classifies an L2 read fault as RequeueAndTrip, and that
/// decision belongs to the consumer that can act on it, not to the reader.
/// </para>
/// </summary>
public sealed class L2WorkflowReader(IConnectionMultiplexer redis, ILogger<L2WorkflowReader> logger)
{
    /// <summary>
    /// Every workflow id in the parent-index SET. A member that is not a workflow id is skipped with a
    /// warning rather than failing the read: one unusable index entry must not hide the rest of L2
    /// from a hydration pass.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> ReadAllIdsAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var members = await redis.GetDatabase()
            .SetMembersAsync(L2ProjectionKeys.ParentIndex()).ConfigureAwait(false);

        var ids = new List<Guid>(members.Length);
        foreach (var member in members)
        {
            if (Guid.TryParseExact(member.ToString(), "D", out var id))
            {
                ids.Add(id);
            }
            else
            {
                // The member itself is not logged: it is whatever happens to be in the store, and this
                // service logs ids and outcomes only.
                logger.LogWarning("parent index holds a member that is not a workflow id; skipping it");
            }
        }

        return ids;
    }

    /// <summary>
    /// The workflow <paramref name="workflowId"/> as L2 holds it, or null when the root key is absent —
    /// which is not a fault. A stop may have cleaned L2 after the announcement that brought us here was
    /// published, and L2 saying the workflow is gone is L2 being the source of truth.
    /// </summary>
    public async Task<WorkflowL1?> ReadAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var db = redis.GetDatabase();

        var rootJson = await db.StringGetAsync(L2ProjectionKeys.Root(workflowId)).ConfigureAwait(false);
        if (rootJson.IsNullOrEmpty)
        {
            return null;
        }

        var root = JsonSerializer.Deserialize<WorkflowRootProjection>(rootJson!, MessagingJson.Options);
        if (root is null)
        {
            return null;
        }

        var stepIds = root.StepIds ?? new List<Guid>();
        var steps = new List<StepL1>(stepIds.Count);

        foreach (var stepId in stepIds)
        {
            ct.ThrowIfCancellationRequested();

            var stepJson = await db.StringGetAsync(L2ProjectionKeys.Step(workflowId, stepId))
                .ConfigureAwait(false);

            var step = stepJson.IsNullOrEmpty
                ? null
                : JsonSerializer.Deserialize<StepProjection>(stepJson!, MessagingJson.Options);

            if (step is null)
            {
                logger.LogWarning(
                    "workflow {WorkflowId} lists step {StepId} but L2 does not hold it; skipping the step",
                    workflowId, stepId);
                continue;
            }

            steps.Add(new StepL1(
                stepId, step.EntryCondition, step.ProcessorId, step.Payload, step.NextStepIds));
        }

        return new WorkflowL1(workflowId, root.EntryStepIds ?? new List<Guid>(), root.Cron, steps);
    }

    /// <summary>
    /// Whether L2 still holds a root for <paramref name="workflowId"/>. The stop path's verify step:
    /// it asks whether the removal it was told about has actually happened before tearing anything
    /// down.
    /// </summary>
    public async Task<bool> ExistsAsync(Guid workflowId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        return await redis.GetDatabase()
            .KeyExistsAsync(L2ProjectionKeys.Root(workflowId)).ConfigureAwait(false);
    }
}
