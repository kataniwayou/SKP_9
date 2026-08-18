using System.Text.Json;
using BaseApi.Core.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration.Messaging;

/// <summary>
/// Projects a workflow definition into the store. The only component that writes a workflow root.
/// <para>
/// <b>Clean, then write, unconditionally.</b> There is no check for whether the workflow is already
/// projected: a start is a statement about what the stored graph should be, not a request to create
/// something new, so it applies whether or not something is there. Running it twice with the same
/// definition leaves the same state, which is what lets the message be redelivered freely — after a
/// failure part-way through, after a broker redelivery, or after the gate reopens.
/// </para>
/// <para>
/// <b>The clean is not an optimisation and cannot be skipped.</b> The write only replaces the keys the
/// new definition names, so a graph that has lost steps would leave the old ones behind — present,
/// unreferenced by the new root, and picked up by the next walk as though they belonged.
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
    private readonly L2Cleanup _cleanup;
    private readonly L2ProjectionWriter _writer;
    private readonly ILogger<StartOrchestrationHandler> _logger;

    public StartOrchestrationHandler(
        L2Cleanup cleanup, L2ProjectionWriter writer, ILogger<StartOrchestrationHandler> logger)
    {
        _cleanup = cleanup ?? throw new ArgumentNullException(nameof(cleanup));
        _writer  = writer ?? throw new ArgumentNullException(nameof(writer));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
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

        await _cleanup.RemoveAsync(workflow.WorkflowId, ct).ConfigureAwait(false);
        await _writer.WriteAsync(workflow, ct).ConfigureAwait(false);
    }
}
