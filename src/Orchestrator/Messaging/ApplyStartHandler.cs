using System.Text.Json;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Orchestrator.L1;

namespace Orchestrator.Messaging;

/// <summary>
/// Applies an <see cref="OrchestrationStarted"/> announcement.
/// <para>
/// <b>An announcement is an announcement, not a payload.</b> It carries a workflow id and nothing
/// else; this handler re-reads L2 through <see cref="WorkflowActivator"/> rather than trusting
/// anything the message itself claims about the workflow's shape. Where a message and L2 disagree, L2
/// wins — and the only way to make that true is to never look at the message for anything but the id.
/// </para>
/// <para>
/// <b>Deserialize, open a scope, call the activator — nothing else.</b>
/// <see cref="WorkflowActivator.ActivateAsync"/> already owns the case where L2 no longer holds the
/// workflow (a stop can clean L2 after this announcement was published; the activator returns and
/// does nothing), the null-cron case, and teardown-then-apply idempotency across a redelivered
/// announcement. Repeating any of that here would be a second copy of a decision that must not drift
/// from the one hydration also calls through the same method.
/// </para>
/// </summary>
internal sealed class ApplyStartHandler : IQueueMessageHandler
{
    private readonly WorkflowActivator _activator;
    private readonly ILogger<ApplyStartHandler> _logger;

    public ApplyStartHandler(WorkflowActivator activator, ILogger<ApplyStartHandler> logger)
    {
        _activator = activator ?? throw new ArgumentNullException(nameof(activator));
        _logger    = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string MessageType => MessageTypes.OrchestrationStarted;

    public async Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)
    {
        // Above the deserialization boundary. A body that will not parse, or one naming no workflow,
        // carries nothing retrying could fix, so it throws and the consumer parks it.
        var m = JsonSerializer.Deserialize<OrchestrationStarted>(body.Span, MessagingJson.Options)
                ?? throw new JsonException("start announcement deserialized to null");

        if (m.WorkflowId == Guid.Empty)
        {
            throw new JsonException("start announcement carries an empty workflow id");
        }

        using (_logger.BeginScope(ExecutionLogScope.BuildScope(
                   Guid.Empty, m.WorkflowId, Guid.Empty, Guid.Empty, Guid.Empty)))
        {
            await _activator.ActivateAsync(m.WorkflowId, ct).ConfigureAwait(false);
        }
    }
}
