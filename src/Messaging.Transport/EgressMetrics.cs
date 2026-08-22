using System.Diagnostics;
using System.Diagnostics.Metrics;
using RabbitMQ.Client.Exceptions;

namespace Messaging.Transport;

/// <summary>The egress meter's name, public so the console host can register it. See <see cref="EgressMetrics"/>.</summary>
public static class EgressMeter
{
    public const string Name = "Messaging.Transport";
}

/// <summary>
/// Pipeline metrics for the egress half: one measurement per message handed to the broker, on both
/// send primitives, with the broker's confirmation inside the measured window.
/// <para>
/// <b>It wraps the primitives, not <c>SendTransientAsync</c>.</b> The entry-step dispatch in
/// <c>WorkflowFireJob</c> calls <see cref="IQueueSender.SendAsync{T}"/> raw and then SWALLOWS the
/// failure, so instrumenting the extension would leave the one path whose failures are otherwise
/// invisible with no metric at all. The processor's identity bootstrap and startup queries call it
/// raw too.
/// </para>
/// <para>
/// <b>Nothing here alters control flow.</b> <see cref="Classify"/> only reads an exception, and
/// <see cref="MeasureAsync"/> rethrows the original untouched — every catch filter downstream, and
/// <c>DeliveryClassifier</c> above them, turns on the exception's type.
/// </para>
/// </summary>
internal static class EgressMetrics
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// constant rather than a literal in two places, because a typo produces no error and no
    /// metrics.
    /// </summary>
    internal const string MeterName = EgressMeter.Name;

    /// <summary>Addressed to a queue through the default exchange — <see cref="QueueSender"/>.</summary>
    internal const string RouteQueue = "queue";

    /// <summary>Addressed to a named exchange — <see cref="QueueFanoutPublisher"/>.</summary>
    internal const string RouteFanout = "fanout";

    private static readonly Meter Meter = new(MeterName);

    private static readonly Counter<long> Produced = Meter.CreateCounter<long>(
        "pipeline.messages.produced",
        unit: "{message}",
        description: "Messages handed to the broker, by route, destination, type and outcome.");

    private static readonly Histogram<double> Duration = Meter.CreateHistogram<double>(
        "pipeline.produce.duration",
        unit: "s",
        description: "Time from the start of a send until the broker confirmed or refused it.");

    /// <summary>
    /// The outcome attribute for a completed send. Null means it returned normally.
    /// <para>
    /// <b>Routing is tested before transport, and the order is load-bearing.</b>
    /// <see cref="SendFaultClassifier.IsTransport"/> returns true for
    /// <see cref="UnroutablePublishException"/> explicitly, and for <see cref="PublishException"/>
    /// implicitly because it matches the whole <c>RabbitMQ.Client</c> namespace. Asking it first
    /// would report every undeclared queue as a broker blip — and "declare the queue" and "wait for
    /// the broker" are opposite remedies.
    /// </para>
    /// </summary>
    internal static string Classify(Exception? ex) => ex switch
    {
        null                                => "accepted",
        UnroutablePublishException          => "unroutable",
        PublishException { IsReturn: true } => "unroutable",
        _ when SendFaultClassifier.IsTransport(ex) => "transient",
        _                                   => "refused",
    };

    /// <summary>
    /// Runs one send and records exactly one measurement on each instrument, whichever way it ends.
    /// <para>
    /// The caller's serialization is deliberately outside the measured window and the publish
    /// gate's wait is deliberately inside it: the wait is latency the caller genuinely experiences,
    /// and both primitives serialise every send behind one channel.
    /// </para>
    /// </summary>
    internal static async Task MeasureAsync(
        string route, string destination, string type, Func<Task> send)
    {
        var started = Stopwatch.GetTimestamp();

        try
        {
            await send().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Record(route, destination, type, Classify(ex), started);
            throw;
        }

        Record(route, destination, type, Classify(null), started);
    }

    private static void Record(
        string route, string destination, string type, string outcome, long started)
    {
        // TagList is a struct with inline storage for up to eight tags, so this allocates nothing
        // on a path that runs once per message.
        var tags = new TagList
        {
            { "route", route },
            { "destination", destination },
            { "type", type },
            { "outcome", outcome },
        };

        // The host's process-wide tag, if it installed one: role=leader|follower on the
        // orchestrator, absent on every other host. Added to the shared TagList so the counter and
        // the histogram cannot disagree about which role the send belonged to.
        PipelineAmbientTag.AppendTo(ref tags);

        Produced.Add(1, tags);
        Duration.Record(Stopwatch.GetElapsedTime(started).TotalSeconds, tags);
    }
}
