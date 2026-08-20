using System.Text.Json;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Orchestrator.L1;
using Orchestrator.Scheduling;

namespace Orchestrator.Messaging;

/// <summary>
/// Applies an <see cref="OrchestrationStopped"/> announcement.
/// <para>
/// <b>Spec §7.3 — verify first, then act.</b> The API can process a stop and then a start for the same
/// workflow: it cleans L2, publishes the stop, writes L2 again, publishes the start — and both
/// announcements can be sitting on this replica's queue in that order. By the time the stop is
/// handled, L2 may already hold the re-written workflow. Unscheduling first would halt a workflow L2
/// says is live, until the start behind it in the queue is processed. Reading L2 before touching
/// anything makes that window not exist: L2 is the source of truth, and if it still holds the
/// workflow, the correct action is none.
/// </para>
/// <para>
/// <b>A workflow this replica never activated is a no-op, not a fault.</b> The replica may have missed
/// the start while it was down, or this may be a duplicate stop for something already torn down. Both
/// leave <see cref="WorkflowL1Store.TryGet"/> empty, and finding nothing there is success.
/// </para>
/// </summary>
internal sealed class ApplyStopHandler : IQueueMessageHandler
{
    private readonly L2WorkflowReader _reader;
    private readonly WorkflowL1Store _store;
    private readonly IWorkflowScheduler _scheduler;
    private readonly ILogger<ApplyStopHandler> _logger;

    public ApplyStopHandler(
        L2WorkflowReader reader,
        WorkflowL1Store store,
        IWorkflowScheduler scheduler,
        ILogger<ApplyStopHandler> logger)
    {
        _reader    = reader ?? throw new ArgumentNullException(nameof(reader));
        _store     = store ?? throw new ArgumentNullException(nameof(store));
        _scheduler = scheduler ?? throw new ArgumentNullException(nameof(scheduler));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.OrchestrationStopped;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // Above the deserialization boundary. A body that will not parse, or one naming no workflow,
        // carries nothing retrying could fix, so it throws and the consumer parks it.
        var m = JsonSerializer.Deserialize<OrchestrationStopped>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("stop announcement deserialized to null");

        if (m.WorkflowId == Guid.Empty)
        {
            throw new JsonException("stop announcement carries an empty workflow id");
        }

        using (_logger.BeginScope(ExecutionLogScope.BuildState(
                   m.WorkflowId, Guid.Empty, Guid.Empty, Guid.Empty, Guid.Empty)))
        {
            // Verify before acting. The API can process a stop and then a start, so by the time this stop
            // is handled L2 may already hold the re-written workflow — and unscheduling first would halt a
            // workflow L2 says is live until the start behind this message in the queue is processed.
            // L2 is the source of truth; if it still holds the workflow, the correct action is none.
            if (await _reader.ExistsAsync(m.WorkflowId, ct).ConfigureAwait(false))
            {
                _logger.LogInformation("stop announced but the workflow is still projected — ignoring");
                return;
            }

            if (_store.TryGet(m.WorkflowId, out var entry))
            {
                await _scheduler.UnscheduleAsync(entry.JobId, ct).ConfigureAwait(false);
                _store.Remove(m.WorkflowId);
            }
        }
    }
}
