namespace Processor.Analyst.Model;

/// <summary>
/// What a dispatch actually spent at the model, counted at the one seam every caller shares.
/// <para>
/// <b>It exists because a failed dispatch still costs money.</b> A dispatch is not retried in
/// process — a failure reschedules and the whole gate runs again from cold — so the interesting
/// number is not what a successful analysis costs but what each ATTEMPT costs, including the ones
/// that end in "the model backend could not be reached" halfway through a rehearsal. Before this,
/// that spend left no trace anywhere: <c>BudgetLedger</c> counts tokens to enforce a ceiling, keeps
/// the total private, and is discarded when a run ends.
/// </para>
/// <para>
/// Cumulative and process-wide by design. The per-dispatch figure is a delta between two snapshots,
/// which is what lets the total be reported from a <c>finally</c> without threading a counter
/// through the gate, the rehearsal and the loop.
/// </para>
/// </summary>
internal sealed class TokenMeter
{
    private long _calls;
    private long _input;
    private long _output;

    /// <summary>One reading. Subtract two to get what happened in between.</summary>
    internal readonly record struct Reading(long Calls, long Input, long Output)
    {
        internal long Total => Input + Output;

        public static Reading operator -(Reading a, Reading b)
            => new(a.Calls - b.Calls, a.Input - b.Input, a.Output - b.Output);

        public override string ToString()
            => $"{Calls} call(s), {Input} in + {Output} out = {Total} tokens";
    }

    internal Reading Snapshot() => new(
        Interlocked.Read(ref _calls),
        Interlocked.Read(ref _input),
        Interlocked.Read(ref _output));

    /// <summary>
    /// Records one completed model call. A call that threw records nothing, because a request that
    /// never came back was never billed for output — its cost is invisible here and at the endpoint.
    /// </summary>
    internal void Record(int input, int output)
    {
        Interlocked.Increment(ref _calls);
        Interlocked.Add(ref _input, input);
        Interlocked.Add(ref _output, output);
    }
}

/// <summary>
/// Counts every model call, whoever makes it.
/// <para>
/// <b>Wrapping the interface rather than instrumenting the callers is the point.</b> The judge's
/// ballots, the rehearsal's two investigations and the real analysis all reach the backend through
/// <see cref="IAnalystModel"/>, so one decorator sees all three and none of them had to change to be
/// counted. It also cannot be bypassed by a future caller that forgets to report its usage.
/// </para>
/// </summary>
internal sealed class MeteredAnalystModel(IAnalystModel inner, TokenMeter meter) : IAnalystModel
{
    public async Task<ModelReply> SendAsync(
        string system,
        IReadOnlyList<ModelTurn> transcript,
        IReadOnlyList<ToolSpec> tools,
        CancellationToken ct)
    {
        var reply = await inner.SendAsync(system, transcript, tools, ct).ConfigureAwait(false);

        meter.Record(reply.InputTokens, reply.OutputTokens);

        return reply;
    }
}
