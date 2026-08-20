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
/// <b>A torn projection is survivable; a broken store is not this type's problem.</b> A step the root
/// still lists but L2 has no usable value for — the key is gone, or what is under it will not
/// deserialize — is skipped with a warning: the workflow is worth running with the steps that are
/// there, and the next start rewrites the whole key set anyway. A Redis fault, by contrast, propagates
/// untouched — spec §7.4 classifies an L2 read fault as RequeueAndTrip, and that decision belongs to
/// the consumer that can act on it, not to the reader. That split is why the only <c>catch</c> in this
/// file sits around a single <c>Deserialize</c> call and cannot reach a read.
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

            // The read is deliberately outside ReadStep: a Redis fault must propagate, and the only way
            // to be sure it cannot be swallowed is for no catch to be anywhere near it.
            var stepJson = await db.StringGetAsync(L2ProjectionKeys.Step(workflowId, stepId))
                .ConfigureAwait(false);

            var step = ReadStep(stepJson);
            if (step is null)
            {
                logger.LogWarning(
                    "workflow {WorkflowId} lists step {StepId} but L2 holds no usable value for it; skipping the step",
                    workflowId, stepId);
                continue;
            }

            steps.Add(new StepL1(
                stepId, step.EntryCondition, step.ProcessorId, step.Payload, step.NextStepIds));
        }

        return new WorkflowL1(workflowId, root.EntryStepIds ?? new List<Guid>(), root.Cron, steps);
    }

    /// <summary>
    /// One stored step value, or null when there is nothing usable there — the key is gone, or what is
    /// under it will not deserialize.
    /// <para>
    /// <b>The two are one outcome, and the catch is deliberately this narrow.</b> A torn projection is
    /// survivable by design, and a value corrupt in place is torn in exactly the way a missing key is:
    /// the root names a step this workflow can no longer run, the rest of the workflow is still worth
    /// running, and the next start rewrites the whole key set. Without this the workflow's own damage
    /// would surface as a <see cref="JsonException"/> escaping <see cref="ReadAsync"/> — indistinguishable
    /// to a caller from the Redis fault that must escape, and enough to end a hydration pass over every
    /// other workflow in the store.
    /// </para>
    /// <para>
    /// It takes an already-read value rather than a key precisely so the catch cannot reach the read.
    /// A <c>try</c> one line wider would put a Redis outage inside a swallow, and spec §7.4's
    /// RequeueAndTrip depends on that fault escaping.
    /// </para>
    /// </summary>
    private static StepProjection? ReadStep(RedisValue stepJson)
    {
        if (stepJson.IsNullOrEmpty)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<StepProjection>(stepJson!, MessagingJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
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
