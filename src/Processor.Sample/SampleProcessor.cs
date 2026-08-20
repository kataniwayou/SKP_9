using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;

namespace Processor.Sample;

/// <summary>
/// The worked example: read the config, read the data, send one branch. Everything else — envelope
/// ids, retries, the projection store, the result to the orchestrator — belongs to the framework.
/// </summary>
public sealed class SampleProcessor : BaseProcessor<SampleConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, SampleConfig? config, Guid executionId, CancellationToken ct)
    {
        // Null when the step's payload was empty or whitespace — the author picks the default.
        var baseNumber = config?.Number ?? 0;
        var label      = config?.Label;

        // A source step arrives with no input, because its EntryId was the Guid.Empty sentinel and the
        // framework skipped the read. Anything missing or malformed here throws into the framework's
        // general catch and becomes a failed step with a sanitized message.
        var incoming = 0;
        if (data.Length > 0)
        {
            using var doc = JsonDocument.Parse(data);
            incoming = doc.RootElement.GetProperty("number").GetInt32();
        }

        // ---- The three deliberate terminals, none of which reach the post queue ----
        //
        // Fail, reported: StepFailed carrying this exact text, then ack. Author-authored messages go
        // on the wire verbatim; a framework-caught exception's message never does.
        //     if (incoming < 0) throw new FailedException("input number must not be negative");
        //
        // Drop, announced: ends the branch and tells the orchestrator why, so a successor gated on a
        // cancelled predecessor can react.
        //     if (incoming == 0) throw new CancelledException("nothing to process");
        //
        // Drop, silent: just return. The branch ends and the orchestrator hears nothing at all, which
        // is what a sink or a filter wants.
        //     if (incoming == 0) return;
        //
        // Sending and returning silently both reclaim this step's input key; CancelledException does
        // not, and with no TTL it stays leaked until the orchestrator reclaims it.

        var processed = JsonSerializer.SerializeToUtf8Bytes(
            new { number = incoming + baseNumber, label }, ProcessorConfig.SerializerOptions);

        // An entry step opens a lineage; a downstream step reuses the inbound one so the lineage
        // holds. NewExecutionId is derived rather than random, so a redelivered dispatch reopens the
        // same lineage instead of a second one.
        var branchExecutionId = executionId == Guid.Empty ? NewExecutionId() : executionId;

        try
        {
            await SendToPostAsync(processed, branchExecutionId, ct);
        }
        catch (PostSendException)
        {
            // A detection point, not a handler: with a fan-out, this is where an author learns which
            // branch was lost. Then it MUST propagate.
            //
            // Bare `throw;` is load-bearing. It preserves the type, so the framework returns the whole
            // dispatch to the queue and replays every branch under the same derived ids. Wrapping it,
            // or throwing something new, falls through to the general catch — which reports the step
            // failed and acknowledges the message, recording a business outcome that never happened
            // while the work is silently lost.
            throw;
        }
    }
}
