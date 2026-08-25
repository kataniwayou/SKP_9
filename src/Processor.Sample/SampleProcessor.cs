using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Microsoft.Extensions.Logging;

namespace Processor.Sample;

/// <summary>
/// The worked example: read the config, read the data, send one branch. Everything else — envelope
/// ids, retries, the projection store, the result to the orchestrator — belongs to the framework.
/// </summary>
public sealed class SampleProcessor(ILogger<SampleProcessor> logger) : BaseProcessor<SampleConfig>
{
    protected override async Task ProcessAsync(
        byte[] data, SampleConfig? config, Guid executionId, CancellationToken ct)
    {
        // Null when the step's payload was empty or whitespace — the author picks the default.
        var baseNumber = config?.Number ?? 0;
        var label      = config?.Label;

        // An author's own record, and it needs nothing from the framework to be useful: MEL scope
        // providers are shared across the logger factory, so the scope ProcessDispatchHandler opened
        // around this call rides this line too. Correlation, workflow, step, processor, entry and
        // execution ids all land on it without being named in the template — which is what makes an
        // author's diagnostics part of the run's trace rather than a stream beside it. Injecting a
        // plain ILogger<T> is the whole of the wiring; the base class deliberately hands out no
        // logger of its own.
        //
        // CONFIG, not data. A step's payload is authored alongside the workflow and is safe to
        // render; the `data` parameter is runtime content and stays out of every template in this
        // system, here as much as in the framework.
        logger.LogInformation("config gives label {Label} and number {Number}", label, baseNumber);

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
        // Fail, reported: a StepOutcome of Failed, then ack. The text does not travel — the outcome
        // carries no message field — so this string is logged by the framework and found by joining on
        // the ids, which is also what keeps a framework exception's payload fragments off the wire.
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
        // Sending and returning silently both reclaim this step's input key. Either exception leaves
        // it in place — which is why the outcome those two send names that key, so the orchestrator
        // reclaims what this step could not.

        // The entry step has no upstream number to add to, so it seeds one. 100 is arbitrary and
        // deliberately far from any step's own contribution: every value downstream is that origin
        // plus one hop's baseNumber per step, which makes the number a running count of the path
        // travelled rather than an opaque total. With every assignment carrying number 1, the
        // terminal step of a seven-step path reports 107 and the L2 traversal is readable off the
        // logs alone. The sentinel executionId is the test for "am I the entry step" — the same
        // one the branch lineage below turns on, and truer than data.Length, which is also empty
        // for a downstream step whose predecessor sent nothing.
        var processed = executionId == Guid.Empty ? 100 : incoming;
        processed += baseNumber;

        // A deliberate, narrow exception to the rule the config line above states, and the only one
        // in this file. Downstream, `processed` IS derived from `data` — so this template renders
        // runtime content, which the framework never does and a real processor should not copy. It is
        // defensible only because this sample's payload is a synthetic hop counter authored by the
        // workflow rather than anything a caller supplied: there is nothing here to leak. A processor
        // carrying real content logs the SHAPE of its result — a count, a length, an outcome — and
        // never the content, and joins on the ids for the rest.
        //
        // What it buys is the traversal itself. The line rides the dispatch scope, so ordering one
        // correlation id by timestamp reads the value climbing 101, 102 ... 107 across the graph, and
        // a hop that never ran is a gap in that sequence rather than an absence someone has to notice.
        logger.LogInformation("step {Label} produced {Processed}", label, processed);

        var outgoing = JsonSerializer.SerializeToUtf8Bytes(
            new { number = processed, label }, ProcessorConfig.SerializerOptions);

        // An entry step opens a lineage; a downstream step reuses the inbound one so the lineage
        // holds. The new id is random, so a redelivered dispatch opens a second lineage rather than
        // reopening this one — the same replay cost the branch ids carry, and the reason this method
        // is written to tolerate running twice on one input.
        var branchExecutionId = executionId == Guid.Empty ? NewExecutionId() : executionId;

        try
        {
            await SendToPostAsync(outgoing, branchExecutionId, ct);
        }
        catch (PostSendException)
        {
            // A detection point, not a handler: with a fan-out, this is where an author learns which
            // branch was lost. Then it MUST propagate.
            //
            // Bare `throw;` is load-bearing. It preserves the type, so the framework returns the whole
            // dispatch to the queue and replays every branch. Wrapping it, or throwing something new,
            // falls through to the general catch — which reports the step failed and acknowledges the
            // message, recording a business outcome that never happened while the work is silently
            // lost. The replay re-sends the branches that did land, under fresh ids; that is the
            // accepted cost of a transient here, and it is why this transform stays side-effect free.
            throw;
        }
    }
}
