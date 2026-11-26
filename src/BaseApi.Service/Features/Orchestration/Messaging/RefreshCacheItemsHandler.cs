using System.Text.Json;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Delete;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Messaging;

/// <summary>
/// Carries an append or remove of cache items to the workflows already running on that cache: the keys
/// the edit touched, no more, so the work grows with the edit rather than with the cache.
/// <para>
/// <b>The rows are read here, not carried by the message.</b> Each touched key's current value (or its
/// absence) is read once per message and applied as SET or DEL, so messages arriving out of order, or
/// redelivered, leave the store holding what the database holds when the last one runs.
/// </para>
/// <para>
/// Same filter as <see cref="RefreshCacheHandler"/>: running workflows bound to the cache, not being
/// deleted, whose last start projected the root (the writer skips the rest).
/// </para>
/// </summary>
internal sealed class RefreshCacheItemsHandler : IQueueMessageHandler
{
    private readonly BaseDbContext _db;
    private readonly CacheItemsStore _items;
    private readonly L2LiveSet _live;
    private readonly L2ProjectionWriter _writer;
    private readonly IWorkflowRunGuard _runGuard;
    private readonly ILogger<RefreshCacheItemsHandler> _logger;

    public RefreshCacheItemsHandler(
        BaseDbContext db, CacheItemsStore items, L2LiveSet live, L2ProjectionWriter writer,
        IWorkflowRunGuard runGuard, ILogger<RefreshCacheItemsHandler> logger)
    {
        _db       = db ?? throw new ArgumentNullException(nameof(db));
        _items    = items ?? throw new ArgumentNullException(nameof(items));
        _live     = live ?? throw new ArgumentNullException(nameof(live));
        _writer   = writer ?? throw new ArgumentNullException(nameof(writer));
        _runGuard = runGuard ?? throw new ArgumentNullException(nameof(runGuard));
        _logger   = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.RefreshCacheItems;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // A body that will not deserialize is a producer defect, parked rather than retried.
        var message = JsonSerializer.Deserialize<RefreshCacheItems>(body.Span, MessagingJson.Options)
                      ?? throw new JsonException("refresh-items message deserialized to null");

        if (message.CacheId == Guid.Empty)
        {
            throw new JsonException("refresh-items message carries an empty cache id");
        }

        var root = await _db.Set<CacheEntity>().AsNoTracking()
            .Where(c => c.Id == message.CacheId).Select(c => c.Root)
            .FirstOrDefaultAsync(ct).ConfigureAwait(false);

        // Deleted since the edit. A cache any workflow is bound to cannot be deleted, so nothing ran on it.
        if (root is null)
        {
            _logger.LogInformation("cache {CacheId} no longer exists; nothing to refresh", message.CacheId);
            return;
        }

        var keys = (message.Keys ?? []).Distinct(StringComparer.Ordinal).ToList();
        if (keys.Count == 0)
        {
            return;
        }

        var bound = await _db.Set<WorkflowCaches>().AsNoTracking()
            .Where(j => j.CacheId == message.CacheId).Select(j => j.WorkflowId)
            .ToListAsync(ct).ConfigureAwait(false);

        var live = (await _live.ListAsync(ct).ConfigureAwait(false)).ToHashSet();
        var targets = bound.Where(live.Contains).ToList();
        if (targets.Count == 0)
        {
            return;
        }

        // One read for the whole message, however many workflows it fans out to.
        var current = await _items.ReadKeysAsync(message.CacheId, keys, ct).ConfigureAwait(false);

        foreach (var workflowId in targets)
        {
            if (await _runGuard.IsDeletingAsync(workflowId, ct).ConfigureAwait(false))
            {
                continue;
            }

            if (await _writer.ApplyCacheKeysAsync(workflowId, root, current, ct).ConfigureAwait(false))
            {
                _logger.LogInformation(
                    "refreshed {KeyCount} key(s) of cache {CacheRoot} in running workflow {WorkflowId}",
                    keys.Count, root, workflowId);
            }
        }
    }
}
