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
/// leave <see cref="WorkflowL1Store.TryGetIncludingStopped"/> empty, and finding nothing there is
/// success.
/// </para>
/// <para>
/// <b>The stop unschedules but does not delete.</b> Tearing the L1 entry out settled the control plane
/// instantly and broke the data plane for the length of one round trip: every step still running when
/// the stop landed came back to <see cref="StepOutcomeHandler"/>, found no workflow in L1, and was
/// parked. The job is still torn down here — a stopped workflow dispatches nothing from this moment —
/// and the entry is marked instead, so those in-flight steps resolve and their run drains.
/// <see cref="L1ReapService"/> drops the mark once nothing can still be in flight.
/// </para>
/// </summary>
internal sealed class ApplyStopHandler : IQueueMessageHandler
{
    private readonly L2WorkflowReader _reader;
    private readonly WorkflowL1Store _store;
    private readonly IWorkflowScheduler _scheduler;
    private readonly TimeProvider _clock;
    private readonly ILogger<ApplyStopHandler> _logger;

    public ApplyStopHandler(
        L2WorkflowReader reader,
        WorkflowL1Store store,
        IWorkflowScheduler scheduler,
        TimeProvider clock,
        ILogger<ApplyStopHandler> logger)
    {
        _reader    = reader ?? throw new ArgumentNullException(nameof(reader));
        _store     = store ?? throw new ArgumentNullException(nameof(store));
        _scheduler = scheduler ?? throw new ArgumentNullException(nameof(scheduler));
        _clock     = clock ?? throw new ArgumentNullException(nameof(clock));
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

        using (_logger.BeginScope(ExecutionLogScope.BuildScope(
                   Guid.Empty, m.WorkflowId, Guid.Empty, Guid.Empty, Guid.Empty)))
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

            // Including stopped: a redelivered stop has to find the entry its predecessor marked, or
            // it would read as a workflow this replica never held and say so — the one reading that is
            // certainly wrong.
            if (_store.TryGetIncludingStopped(m.WorkflowId, out var entry))
            {
                // An entry already marked has had both halves done to it, and neither is worth
                // repeating. The unschedule would be a second DeleteJob against a job that is already
                // gone, and the mark is deliberately not refreshed — see MarkDeleted: refreshing would
                // push the reap out by a full grace period per duplicate, so a stop redelivered on a
                // loop would never be collected at all.
                if (entry.DeletedAt is not null)
                {
                    _logger.LogInformation("stop applied; the workflow was already marked stopped");
                }
                else
                {
                    // Unschedule strictly first. This is what makes the stop take effect now rather
                    // than at the reap: the mark only keeps the definition resolvable for outcomes
                    // already in flight, and the job is what would otherwise keep dispatching new work.
                    await _scheduler.UnscheduleAsync(entry.JobId, ct).ConfigureAwait(false);

                    // False here would mean a concurrent delivery marked it between the read above and
                    // this call. Nothing more to do in that case — the other delivery logged it — and
                    // the CAS inside MarkDeleted is what makes that safe rather than a lost update.
                    if (_store.MarkDeleted(m.WorkflowId, _clock.GetUtcNow()))
                    {
                        // The counterpart to the activator's own line, and the only record that this
                        // replica stopped dispatching a workflow. Without it a stop is visible on the
                        // API side and nowhere else: the fires simply cease, which is
                        // indistinguishable from a replica that never got the announcement at all.
                        _logger.LogInformation(
                            "unscheduled the workflow's job and marked it stopped; steps still in "
                          + "flight will resolve until it is reaped");
                    }
                }
            }
            else
            {
                // Not a fault, and worth a record precisely because it is not. A redelivered stop, or
                // one for a workflow this replica never activated, lands here — and reading that as a
                // missing announcement is the mistake this line exists to prevent.
                _logger.LogInformation("stop applied; this replica was not holding the workflow");
            }
        }
    }
}
