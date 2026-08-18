using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// Writes one workflow definition into the projection store: the root, its entry in the parent index,
/// and one key per step.
/// <para>
/// <b>The write is an overwrite, and the whole graph goes in one batch.</b> Writing the keys
/// individually would let a failure leave a root pointing at steps that were never written — a graph
/// that walks into nothing, and one that looks complete to every reader. Batched, a failure leaves the
/// previous state, which the caller's clean has usually already removed; either way the message is
/// returned to the queue and the whole sequence runs again from the top.
/// </para>
/// <para>
/// <b>Nothing here compensates for a partial failure, and nothing needs to.</b> The sequence is
/// clean-then-write and it is driven by a message that is only acknowledged once it completes — so a
/// failure at any point is repaired by running it again, not by unwinding. That is the difference
/// between doing this work behind a queue and doing it inside a request that has to answer someone.
/// </para>
/// </summary>
internal sealed class L2ProjectionWriter
{
    private readonly IConnectionMultiplexer _multiplexer;
    private readonly TimeProvider _clock;

    public L2ProjectionWriter(IConnectionMultiplexer multiplexer, TimeProvider clock)
    {
        _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));
        _clock       = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    /// <summary>Projects <paramref name="workflow"/> into the store, replacing whatever it names.</summary>
    public async Task WriteAsync(WorkflowL1 workflow, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(workflow);

        var now = _clock.GetUtcNow().UtcDateTime;

        // Interval is left at zero and status at pending: this writer knows when the definition was
        // stored, not how often it will run. Deriving an interval here would mean parsing the cron in
        // a component that has no other reason to understand one, and would go stale the moment
        // whoever schedules it computes its own.
        var liveness = new LivenessProjection(now, 0, "Pending");

        var steps = workflow.Steps ?? new List<StepL1>();

        // Recorded from the same list the step keys are written from, in this method, so the root
        // cannot describe a key set the write did not produce. Deriving it anywhere else — from the
        // entry steps, or by walking successors — would let the two drift, and a step missing from
        // this list is a key nothing will ever delete.
        var root = new WorkflowRootProjection(
            EntryStepIds: workflow.EntryStepIds ?? new List<Guid>(),
            StepIds: steps.Select(s => s.StepId).ToList(),
            Cron: workflow.Cron,
            Liveness: liveness);

        var db = _multiplexer.GetDatabase();
        var batch = db.CreateBatch();
        var writes = new List<Task>
        {
            batch.StringSetAsync(
                L2ProjectionKeys.Root(workflow.WorkflowId),
                JsonSerializer.Serialize(root, MessagingJson.Options)),

            // Adding a member that is already present is a no-op, so this needs no existence check
            // and stays correct when the same definition is written twice.
            batch.SetAddAsync(
                L2ProjectionKeys.ParentIndex(),
                workflow.WorkflowId.ToString("D")),
        };

        foreach (var step in steps)
        {
            var projection = new StepProjection(
                step.EntryCondition,
                step.ProcessorId,
                step.Payload,
                step.NextStepIds ?? new List<Guid>());

            writes.Add(batch.StringSetAsync(
                L2ProjectionKeys.Step(workflow.WorkflowId, step.StepId),
                JsonSerializer.Serialize(projection, MessagingJson.Options)));
        }

        batch.Execute();
        await Task.WhenAll(writes).ConfigureAwait(false);
    }
}
