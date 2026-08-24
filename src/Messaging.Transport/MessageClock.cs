namespace Messaging.Transport;

/// <summary>
/// The two timestamps that ride a pipeline message, and the ambient that carries the second one
/// across a handler.
/// <para>
/// <b>Why timestamps on the wire at all.</b> There is no trace context anywhere in this codebase —
/// no <c>ActivitySource</c>, no <c>traceparent</c>, no propagator — so end-to-end time cannot be
/// read off traces. And the obvious in-process stopwatch cannot work either:
/// <c>orchestrator-result</c> is a shared competing-consumer queue, so the outcome of a step is
/// routinely consumed by a different replica than the one that dispatched it. Nothing held in one
/// process spans that. The measurement has to travel with the message.
/// </para>
/// <para>
/// <b>Two headers, because there are two questions.</b>
/// </para>
/// <list type="bullet">
/// <item><description><c>x-skp-sent-ms</c> — stamped fresh on every publish. The consumer's
/// difference is how long THIS hop sat in the broker, which is the term the existing produce and
/// process durations do not contain.</description></item>
/// <item><description><c>x-skp-origin-ms</c> — stamped once, when a step begins, then propagated
/// unchanged through every message that step causes. When the orchestrator finally consumes the
/// step's outcome, the difference is the whole door-to-door time.</description></item>
/// </list>
/// <para>
/// <b>The ambient is what makes propagation work without touching a single contract.</b>
/// <c>IQueueMessageHandler</c> receives a body and nothing else — no properties, no headers — so a
/// handler cannot see what it arrived with and cannot copy it forward. Threading it through would
/// mean changing that interface and every handler, or adding a field to three message records and
/// keeping them in step. An <see cref="AsyncLocal{T}"/> set by the consumer before it invokes the
/// handler flows into everything the handler does, including its sends, and nothing else has to
/// know this exists.
/// </para>
/// <para>
/// <b>Why the chain is reset at dispatch rather than never.</b> A step's outcome is handled by the
/// orchestrator, which dispatches the NEXT step from inside that delivery — so an origin that was
/// only ever propagated would ride from the first step to the last, and every step after the first
/// would report the cumulative run time under a name that says step. <c>BeginChain</c> is called
/// where a step is dispatched, which is the one place that knows a new step is starting.
/// </para>
/// <para>
/// <b>Clock skew is the honest limit.</b> The two ends of every measurement here are stamped on
/// DIFFERENT PROCESSES. On this single-node cluster that is nil; across nodes NTP leaves
/// milliseconds to tens of milliseconds, which is irrelevant to a measurement whose interesting
/// range is hundreds of milliseconds to minutes and fatal to one that claims to resolve a 24ms hop.
/// The bucket ladder starts at 10ms for that reason, and <see cref="ElapsedSeconds"/> clamps rather
/// than reporting a negative — a clock running backwards shows up as a visible pile at zero instead
/// of poisoning the quantiles.
/// </para>
/// </summary>
public static class MessageClock
{
    /// <summary>When this message was published. Fresh on every hop.</summary>
    public const string SentHeader = "x-skp-sent-ms";

    /// <summary>When the step that caused this message began. Propagated, never re-stamped.</summary>
    public const string OriginHeader = "x-skp-origin-ms";

    // Set by the consumer for the duration of one delivery, read by the sender on any publish that
    // delivery makes. AsyncLocal rather than a field because deliveries run concurrently.
    private static readonly AsyncLocal<long?> ChainOrigin = new();

    /// <summary>Unix milliseconds. One place, so the two ends of a measurement cannot disagree.</summary>
    public static long NowMilliseconds() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>
    /// The origin an outgoing message should carry: the one this delivery arrived with, or now if
    /// this publish starts a chain of its own — a cron fire, or an API call.
    /// </summary>
    public static long OriginForSend() => ChainOrigin.Value ?? NowMilliseconds();

    /// <summary>
    /// Take the origin this delivery arrived with. Null — an older build's message, or the API's,
    /// whose queue side emits no metrics at all — starts a fresh chain rather than propagating a
    /// value that would read as epoch zero.
    /// </summary>
    public static void Adopt(long? originMs) => ChainOrigin.Value = originMs;

    /// <summary>
    /// Declare that what follows begins a new step, so the next publish stamps its own origin.
    /// Called where a step is dispatched — the one place that knows.
    /// </summary>
    public static void BeginChain() => ChainOrigin.Value = null;

    /// <summary>Write a millisecond timestamp onto an outgoing header table.</summary>
    public static void Stamp(IDictionary<string, object?> headers, string key, long value)
    {
        ArgumentNullException.ThrowIfNull(headers);
        headers[key] = value;
    }

    /// <summary>
    /// Read a millisecond timestamp off a delivery's header table, or null if it is absent or not a
    /// number.
    /// <para>
    /// <b>Absent must not read as zero</b>, which is why this returns a nullable rather than a
    /// default. A message published by a build without this instrument carries no header, and
    /// during a rollout there are always some: recording those as an elapsed time since the epoch —
    /// or as zero — would bury the real distribution under a spike that means nothing.
    /// </para>
    /// <para>
    /// <b>Never throws.</b> This runs on the delivery path, where an exception parks the message. A
    /// header of the wrong shape is somebody else's problem, not a reason to refuse work. AMQP field
    /// tables are self-describing and a value written as a long can arrive as an int, so both are
    /// accepted.
    /// </para>
    /// </summary>
    public static long? ReadHeader(IDictionary<string, object?>? headers, string key)
    {
        if (headers is null || !headers.TryGetValue(key, out var raw))
        {
            return null;
        }

        return raw switch
        {
            long l => l,
            int i => i,
            short s => s,
            byte b => b,
            _ => null,
        };
    }

    /// <summary>
    /// Seconds between <paramref name="thenMs"/> and now, never negative.
    /// <para>
    /// Clamped because the two ends are stamped on different processes: NTP skew can put the
    /// receiver behind the sender, and a negative latency is not a measurement. Skew then shows as a
    /// pile at zero, which is visible, rather than as negative observations, which a histogram
    /// cannot represent anyway.
    /// </para>
    /// </summary>
    public static double ElapsedSeconds(long thenMs) =>
        Math.Max(0d, (NowMilliseconds() - thenMs) / 1000d);
}
