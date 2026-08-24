using Messaging.Transport;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Reads how deep this process's dead-letter queues are, on a loop, and publishes it as a level.
/// <para>
/// The loop itself lives in <see cref="QueueStatsProbe"/> and is shared with
/// <see cref="QueueDepthProbe"/> — see that class for why a passive declare is the only way to ask
/// this question here, why a channel is created per pass, and why a failure to read is logged once
/// and swallowed. This subclass is only the queue list's meaning and where the number goes.
/// </para>
/// <para>
/// <b>Slower than any pipeline loop, on purpose.</b> A dead-letter queue changes only when something
/// is refused, which is rare and never urgent to the second. What matters is that the number is
/// still there tomorrow, not that it arrived within a scrape — which is the opposite of the
/// trade-off <see cref="QueueDepthProbe"/> makes.
/// </para>
/// </summary>
public sealed class DeadLetterDepthProbe : QueueStatsProbe
{
    public DeadLetterDepthProbe(
        RabbitMqConnection connection,
        IReadOnlyList<string> queues,
        TimeSpan interval,
        ILogger<DeadLetterDepthProbe> logger)
        : base(connection, queues, interval, logger)
    {
    }

    protected override string Purpose => "dead-letter depth";

    /// <summary>
    /// Only the message count is published. A dead-letter queue has no consumer by design — that is
    /// what makes a message parked there permanent — so its consumer count is always zero and would
    /// be a series carrying no information.
    /// </summary>
    protected override void Report(string queue, QueueDeclareOk ok) =>
        DeadLetterDepthMetrics.Report(queue, (long)ok.MessageCount);
}
