using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Messaging;

/// <summary>
/// Removes a workflow's projection from the store.
/// <para>
/// <b>A workflow that is not projected is a success, not a failure.</b> The message asks for an end
/// state rather than for an action, and that end state already holds — so a repeat, a redelivery, or a
/// stop for something that was never started all complete quietly. Treating an absent root as an error
/// would make the second of two identical stops fail, and park a message whose work was already done.
/// </para>
/// <para>
/// It shares its cleanup with the start path, which runs the same removal before writing. One
/// implementation rather than two means the walk that discovers step keys cannot drift between the
/// path that deletes a graph and the path that replaces one.
/// </para>
/// </summary>
internal sealed class StopOrchestrationHandler : IQueueMessageHandler
{
    private readonly L2Cleanup _cleanup;
    private readonly IQueueFanoutPublisher _publisher;
    private readonly ILogger<StopOrchestrationHandler> _logger;

    public StopOrchestrationHandler(
        L2Cleanup cleanup, IQueueFanoutPublisher publisher, ILogger<StopOrchestrationHandler> logger)
    {
        _cleanup   = cleanup ?? throw new ArgumentNullException(nameof(cleanup));
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

        _logger.LogInformation("removing projection for workflow {WorkflowId}", message.WorkflowId);

        await _cleanup.RemoveAsync(message.WorkflowId, ct).ConfigureAwait(false);

        // The announcement goes out only now, because only now is the removal committed. A replica
        // reading L2 on an announcement published any earlier could still find the projection that is
        // about to be removed, and would have no way to tell that from a stale read.
        //
        // A failure here escapes as a transient send fault, so the delivery is requeued and the whole
        // handler runs again — the clean is unconditional and idempotent by design, so the repeat is
        // safe, and the replicas learn about the removal on the retry.
        await _publisher.PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStopped,
            new OrchestrationStopped(message.WorkflowId), ct).ConfigureAwait(false);
    }
}
