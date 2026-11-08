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
/// Aligns one cache's dictionary with its row in every running workflow that projected it — the items
/// edit of <c>PUT /caches/{id}/items</c> reaching workflows that are already running, without a start.
/// <para>
/// <b>The row is read here, not carried by the message.</b> Whatever order edits arrive in, and however
/// often one is redelivered, the store ends up holding what the database holds when the last one runs.
/// </para>
/// <para>
/// <b>Only the cache, only running workflows.</b> A stopped workflow is left for its next start, which
/// reads the row anyway; a workflow being deleted is left to its deletion; and a workflow whose last
/// start did not project this root is skipped by the writer, because a cache bound after a start is a
/// binding change and waits for the next one. Nothing is announced: processors read L2 on every lookup,
/// and no orchestrator reads caches.
/// </para>
/// </summary>
internal sealed class RefreshCacheHandler : IQueueMessageHandler
{
    private readonly BaseDbContext _db;
    private readonly L2LiveSet _live;
    private readonly L2ProjectionWriter _writer;
    private readonly IWorkflowRunGuard _runGuard;
    private readonly ILogger<RefreshCacheHandler> _logger;

    public RefreshCacheHandler(
        BaseDbContext db, L2LiveSet live, L2ProjectionWriter writer, IWorkflowRunGuard runGuard,
        ILogger<RefreshCacheHandler> logger)
    {
        _db       = db ?? throw new ArgumentNullException(nameof(db));
        _live     = live ?? throw new ArgumentNullException(nameof(live));
        _writer   = writer ?? throw new ArgumentNullException(nameof(writer));
        _runGuard = runGuard ?? throw new ArgumentNullException(nameof(runGuard));
        _logger   = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.RefreshCache;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // A body that will not deserialize is a producer defect, parked rather than retried.
        var message = JsonSerializer.Deserialize<RefreshCache>(body.Span, MessagingJson.Options)
                      ?? throw new JsonException("refresh message deserialized to null");

        if (message.CacheId == Guid.Empty)
        {
            throw new JsonException("refresh message carries an empty cache id");
        }

        var cache = await _db.Set<CacheEntity>().AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == message.CacheId, ct).ConfigureAwait(false);

        // Deleted since the edit. A cache any workflow is bound to cannot be deleted, so nothing ran on it.
        if (cache is null)
        {
            _logger.LogInformation("cache {CacheId} no longer exists; nothing to refresh", message.CacheId);
            return;
        }

        var bound = await _db.Set<WorkflowCaches>().AsNoTracking()
            .Where(j => j.CacheId == message.CacheId).Select(j => j.WorkflowId)
            .ToListAsync(ct).ConfigureAwait(false);

        var live = (await _live.ListAsync(ct).ConfigureAwait(false)).ToHashSet();

        // The validator holds a stored row to a flat object of strings, so this parse cannot fail on one.
        var items = new CacheL1(cache.Root,
            JsonSerializer.Deserialize<Dictionary<string, string>>(cache.Items) ?? new Dictionary<string, string>());

        foreach (var workflowId in bound.Where(live.Contains))
        {
            if (await _runGuard.IsDeletingAsync(workflowId, ct).ConfigureAwait(false))
            {
                continue;
            }

            if (await _writer.WriteCacheAsync(workflowId, items, ct).ConfigureAwait(false))
            {
                _logger.LogInformation(
                    "refreshed cache {CacheRoot} of running workflow {WorkflowId} with {ItemCount} item(s)",
                    cache.Root, workflowId, items.Items.Count);
            }
        }
    }
}
