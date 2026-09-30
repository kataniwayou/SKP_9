using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Messaging;

/// <summary>
/// Takes a workflow out of the live set and announces it. Nothing is deleted: the store, the caches
/// and the names stay, so a start can restore the workflow and outcomes still in flight resolve.
/// <para>
/// <b>Remove, then announce — the order is the correctness.</b> Every replica's stop handler ignores a
/// stop while the id is still live (a later start may have overtaken it). Announcing first would let a
/// replica read the id as live and ignore the stop for good.
/// </para>
/// </summary>
internal sealed class StopOrchestrationHandler : IQueueMessageHandler
{
    private readonly L2LiveSet _live;
    private readonly IQueueFanoutPublisher _publisher;
    private readonly ILogger<StopOrchestrationHandler> _logger;

    public StopOrchestrationHandler(
        L2LiveSet live, IQueueFanoutPublisher publisher, ILogger<StopOrchestrationHandler> logger)
    {
        _live      = live ?? throw new ArgumentNullException(nameof(live));
        _publisher = publisher ?? throw new ArgumentNullException(nameof(publisher));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.StopOrchestration;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        var message = JsonSerializer.Deserialize<StopOrchestration>(body.Span, MessagingJson.Options)
                      ?? throw new JsonException("stop message deserialized to null");

        if (message.WorkflowId == Guid.Empty)
        {
            // Not a workflow that happens to be absent — a message that names no workflow at all.
            // No retry can supply one, so it is parked rather than requeued.
            throw new JsonException("stop message carries an empty workflow id");
        }

        _logger.LogInformation("removing workflow {WorkflowId} from the live set", message.WorkflowId);

        await _live.RemoveAsync(message.WorkflowId).ConfigureAwait(false);

        // A failure here escapes as a transient send fault, so the delivery is requeued and the handler
        // runs again: the removal is idempotent and the replicas learn about the stop on the retry.
        await _publisher.PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStopped,
            new OrchestrationStopped(message.WorkflowId), ct).ConfigureAwait(false);
    }
}
