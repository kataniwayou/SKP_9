using Messaging.Transport;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The two timestamps that ride a message, and the ambient that carries the second one across a
/// handler.
/// <para>
/// <b>Why timestamps on the wire at all.</b> There is no trace context anywhere in this codebase —
/// no <c>ActivitySource</c>, no <c>traceparent</c>, no propagator — so end-to-end time cannot be
/// read off traces. And the obvious in-process stopwatch cannot work either:
/// <c>orchestrator-result</c> is a shared competing-consumer queue, so the outcome of a step can be
/// consumed by a different replica than the one that dispatched it. The measurement has to travel
/// with the message.
/// </para>
/// <para>
/// <b>Two headers, two questions.</b> <c>x-skp-sent-ms</c> is stamped fresh on every publish and
/// answers how long THIS hop waited in the broker. <c>x-skp-origin-ms</c> is stamped once when a
/// step begins and then propagated unchanged through every message that step causes, so when the
/// orchestrator finally consumes the step's outcome the difference is the whole door-to-door time.
/// </para>
/// </summary>
public sealed class MessageClockTests : IDisposable
{
    public MessageClockTests() => MessageClock.BeginChain();

    public void Dispose() => MessageClock.BeginChain();

    [Fact]
    public void WithNoChainInScopeTheOriginIsNow()
    {
        // A message published outside any delivery -- a cron fire, an API call -- starts its own
        // chain rather than inheriting a stale one.
        var before = MessageClock.NowMilliseconds();

        var origin = MessageClock.OriginForSend();

        Assert.InRange(origin, before, MessageClock.NowMilliseconds());
    }

    [Fact]
    public void AnAdoptedOriginIsWhatTheNextSendStamps()
    {
        // The propagation that makes door-to-door possible: a handler running inside a delivery
        // publishes messages carrying the ORIGINAL step's origin, not the moment of the publish.
        MessageClock.Adopt(1_000L);

        Assert.Equal(1_000L, MessageClock.OriginForSend());
    }

    [Fact]
    public void BeginChainDiscardsAnAdoptedOrigin()
    {
        // What makes this STEP latency rather than WORKFLOW latency. The orchestrator dispatching
        // the next step is inside the previous step's delivery, so without an explicit reset the
        // origin would ride on and every later step would report the cumulative run time.
        MessageClock.Adopt(1_000L);

        MessageClock.BeginChain();

        Assert.NotEqual(1_000L, MessageClock.OriginForSend());
    }

    [Fact]
    public void AdoptingNothingLeavesTheChainAtNow()
    {
        // A delivery with no origin header -- published by an older build, or by the API, whose
        // queue side emits no metrics at all -- must not poison the chain with a null that reads
        // as epoch zero.
        MessageClock.Adopt(null);

        Assert.InRange(MessageClock.OriginForSend(),
            MessageClock.NowMilliseconds() - 1_000, MessageClock.NowMilliseconds() + 1_000);
    }

    [Fact]
    public void AStampedHeaderReadsBackAsTheSameValue()
    {
        var headers = new Dictionary<string, object?>();

        MessageClock.Stamp(headers, MessageClock.SentHeader, 1_234_567L);

        Assert.Equal(1_234_567L, MessageClock.ReadHeader(headers, MessageClock.SentHeader));
    }

    [Fact]
    public void AMissingHeaderReadsAsNullRatherThanZero()
    {
        // The rule that keeps a rollout from flooding the histogram with false zeros. A message
        // published by a build without this instrument carries no header, and "no measurement" and
        // "took no time" must not render the same.
        Assert.Null(MessageClock.ReadHeader(new Dictionary<string, object?>(), MessageClock.SentHeader));
        Assert.Null(MessageClock.ReadHeader(null, MessageClock.SentHeader));
    }

    [Fact]
    public void AHeaderOfTheWrongShapeReadsAsNull()
    {
        // Never throws on the delivery path. A malformed header is somebody else's message, not a
        // reason to park work -- and the AMQP client hands strings back as byte[], so "unexpected
        // type" is a case that genuinely occurs rather than a defensive flourish.
        var headers = new Dictionary<string, object?> { [MessageClock.SentHeader] = "not-a-number" };

        Assert.Null(MessageClock.ReadHeader(headers, MessageClock.SentHeader));
    }

    [Fact]
    public void AnIntegerHeaderIsAcceptedAsWellAsALong()
    {
        // AMQP field tables are self-describing and a small value can arrive as a 32-bit int even
        // though a long was written. Reading only `long` would silently drop those.
        var headers = new Dictionary<string, object?> { [MessageClock.SentHeader] = 42 };

        Assert.Equal(42L, MessageClock.ReadHeader(headers, MessageClock.SentHeader));
    }

    [Fact]
    public void ElapsedNeverGoesNegative()
    {
        // These timestamps are taken on DIFFERENT PROCESSES, so NTP skew can put the receiver's
        // clock behind the sender's. A negative latency is not a measurement; clamping puts skew
        // in a visible pile at zero instead of poisoning the quantiles.
        Assert.Equal(0d, MessageClock.ElapsedSeconds(MessageClock.NowMilliseconds() + 5_000));
    }

    [Fact]
    public void ElapsedIsReportedInSeconds()
    {
        // The unit every other duration instrument here uses, and the one the shared bucket ladder
        // is expressed in.
        Assert.Equal(2.5d, MessageClock.ElapsedSeconds(MessageClock.NowMilliseconds() - 2_500), 1);
    }
}
