using Confluent.Kafka;

namespace Processor.PathImporter.Kafka;

/// <summary>
/// Splits a Kafka fault into "this will fail the same way forever" and "try again next dispatch".
/// <para>
/// <b>Deterministic is the allow-list, and the default is transient — the inverse of
/// <c>SendFaultClassifier</c>.</b> There, an unrecognised fault is left raw so the dispatch parks
/// where a human can look, because misreading a deterministic fault as transient would requeue it
/// forever. Here the cost of each mistake is reversed: an unrecognised consume fault that is really
/// transient would fail a step that had nothing wrong with it, while one that is really deterministic
/// costs a partial batch and a retry that a human sees in the <c>Faulted</c> counts. So this default
/// is transient. It is not an oversight and it must not be "corrected" to match the other classifier.
/// </para>
/// </summary>
public static class KafkaFaultClassifier
{
    /// <summary>
    /// True when the fault will recur identically on the next dispatch, so the step should be
    /// reported failed rather than retried.
    /// </summary>
    public static bool IsDeterministic(Error error)
    {
        ArgumentNullException.ThrowIfNull(error);

        // Fatal first, and independent of the code: librdkafka raises it for client states nothing
        // downstream can recover from, whatever error happens to be reported alongside.
        if (error.IsFatal)
        {
            return true;
        }

        return error.Code switch
        {
            // The topic is not there, or we may not read it. Both are workflow authoring faults:
            // the payload names something the broker will not give us, and it will not start.
            ErrorCode.UnknownTopicOrPart          => true,
            ErrorCode.Local_UnknownTopic          => true,
            ErrorCode.TopicAuthorizationFailed    => true,
            ErrorCode.GroupAuthorizationFailed    => true,
            ErrorCode.ClusterAuthorizationFailed  => true,
            ErrorCode.SaslAuthenticationFailed    => true,

            // The client was built wrong. A retry builds it identically.
            ErrorCode.InvalidConfig               => true,
            ErrorCode.Local_InvalidArg            => true,

            // Transport, timeouts, elections, rebalances and everything unrecognised.
            _                                     => false,
        };
    }
}
