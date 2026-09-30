using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Messaging;

/// <summary>
/// Projects a workflow definition into L2 and marks it live. The only component that writes a workflow store.
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

    public StartOrchestrationHandler(
        L2ProjectionWriter writer, L2LiveSet live, IQueueFanoutPublisher publisher,
        ILogger<StartOrchestrationHandler> logger)
    {
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

        _logger.LogInformation(
            "projecting workflow {WorkflowId} with {StepCount} step(s)",
            workflow.WorkflowId, workflow.Steps?.Count ?? 0);

        await _writer.WriteAsync(workflow, ct).ConfigureAwait(false);

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
}
