using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Workflow.Delete;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Cache;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Messaging;

/// <summary>
/// Projects a workflow definition into L2 and marks it live. The only component that writes a workflow store; the one
/// other writer under a workflow's key, <see cref="RefreshCacheHandler"/>, rewrites a single cache's dictionary.
/// <para>
/// <b>Write, then join the live set, unconditionally.</b> There is no check for whether the workflow is
/// already projected: a start is a statement about what the stored workflow should be, not a request to
/// create something new, so it applies whether or not something is there. Running it twice with the
/// same definition leaves the same state, which is what lets the message be redelivered freely — after
/// a failure part-way through, after a broker redelivery, or after the gate reopens.
/// </para>
/// <para>
/// <b>The live set is joined only after the write.</b> Every orchestrator hydrates from the live set and
/// reads the store of each id it finds there, so an id that joined first could be read before its store
/// exists. The write itself aligns only what this workflow owns — its hash, its caches and its steps'
/// names — and deletes nothing that belongs to any other workflow.
/// </para>
/// <para>
/// <b>Validation already happened, upstream, before this message existed.</b> Nothing is re-checked
/// here: a definition that reached the queue was accepted, and refusing it now would park work the
/// caller was already told had been accepted. What this handler still refuses is a body it cannot
/// read at all, which is a different failure and is not recoverable by retrying.
/// </para>
/// </summary>
internal sealed class StartOrchestrationHandler : IQueueMessageHandler
{
    private readonly L2ProjectionWriter _writer;
    private readonly L2LiveSet _live;
    private readonly IQueueFanoutPublisher _publisher;
    private readonly ILogger<StartOrchestrationHandler> _logger;
    private readonly IWorkflowRunGuard? _runGuard;
    private readonly BaseDbContext? _db;
    private readonly CacheItemsStore? _items;

    public StartOrchestrationHandler(
        L2ProjectionWriter writer, L2LiveSet live, IQueueFanoutPublisher publisher,
        ILogger<StartOrchestrationHandler> logger, IWorkflowRunGuard? runGuard = null,
        BaseDbContext? db = null, CacheItemsStore? items = null)
    {
        _db        = db;
        _items     = items;
        _runGuard  = runGuard;
        _writer    = writer ?? throw new ArgumentNullException(nameof(writer));
        _live      = live ?? throw new ArgumentNullException(nameof(live));
        _publisher = publisher ?? throw new ArgumentNullException(nameof(publisher));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.StartOrchestration;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // A body that will not deserialize, or one carrying no workflow, is a producer defect. It
        // throws, and the consumer parks it — retrying cannot turn an unreadable message into a
        // readable one, and the message is worth more parked where it can be inspected.
        var message = JsonSerializer.Deserialize<StartOrchestration>(body.Span, MessagingJson.Options)
                      ?? throw new JsonException("start message deserialized to null");

        var workflow = message.Workflow
                       ?? throw new JsonException("start message carries no workflow");

        if (workflow.WorkflowId == Guid.Empty)
        {
            throw new JsonException("start message carries an empty workflow id");
        }

        // A start queued before its workflow's deletion began is never projected (2026-10-10): applied now, the id
        // would be live with no row left to stop it by. Acknowledged, not parked: there is nothing to retry.
        if (_runGuard is not null && await _runGuard.IsDeletingAsync(workflow.WorkflowId, ct).ConfigureAwait(false))
        {
            _logger.LogWarning("workflow {WorkflowId} is being deleted or was deleted; its start is not projected", workflow.WorkflowId);
            return;
        }

        _logger.LogInformation(
            "projecting workflow {WorkflowId} with {StepCount} step(s)",
            workflow.WorkflowId, workflow.Steps?.Count ?? 0);

        await _writer.WriteAsync(await ResolveCachesAsync(workflow, ct).ConfigureAwait(false), ct).ConfigureAwait(false);

        // Live only once written: a replica hydrating from the live set must never find an id whose
        // store is not there yet.
        await _live.AddAsync(workflow.WorkflowId).ConfigureAwait(false);

        // The announcement goes out only now, because only now is "validated AND written" true. The
        // service validated before it sent this message; the write happened just above. A replica
        // reading L2 on an announcement published any earlier could see the previous definition, or
        // none, and could not distinguish that from a workflow that was never started.
        //
        // A failure here escapes as a transient send fault, so the delivery is requeued and the whole
        // handler runs again — the write and the live-set add are unconditional and idempotent by
        // design, so the repeat is safe, and the replicas learn about the projection on the retry.
        await _publisher.PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStarted,
            new OrchestrationStarted(workflow.WorkflowId), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The message carries each bound cache as (id, root); the rows are read here, so the write sees
    /// them as they are now. A cache deleted since the start was queued is skipped: a cache a workflow
    /// is bound to cannot be deleted, so this is a race the next start settles. Caches carried inline
    /// (a message from before refs existed) are kept as they came.
    /// </summary>
    private async Task<WorkflowL1> ResolveCachesAsync(WorkflowL1 workflow, CancellationToken ct)
    {
        if (workflow.CacheRefs is not { Count: > 0 } refs)
        {
            return workflow;
        }

        if (_db is null || _items is null)
        {
            throw new InvalidOperationException("start message carries cache refs but the handler has no database");
        }

        var ids = refs.Select(r => r.CacheId).Distinct().ToList();
        var existing = (await _db.Set<CacheEntity>().AsNoTracking()
            .Where(c => ids.Contains(c.Id)).Select(c => c.Id).ToListAsync(ct).ConfigureAwait(false)).ToHashSet();

        var caches = new List<CacheL1>(workflow.Caches ?? []);
        foreach (var r in refs)
        {
            if (!existing.Contains(r.CacheId))
            {
                _logger.LogWarning("cache {CacheId} ({CacheRoot}) no longer exists; not projected", r.CacheId, r.Root);
                continue;
            }

            caches.Add(new CacheL1(r.Root, await _items.ReadAllAsync(r.CacheId, ct).ConfigureAwait(false)));
        }

        return workflow with { Caches = caches };
    }
}
