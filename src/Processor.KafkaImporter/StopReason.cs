namespace Processor.KafkaImporter;

/// <summary>
/// Why the loop stopped. It exists because a bare <c>12/100</c> has three causes and an operator
/// cannot tell them apart: the batch finished, the topic ran dry, or the thirteenth record faulted.
/// </summary>
public enum StopReason
{
    /// <summary>Consumed the full <c>MessageCount</c>. Every offset committed.</summary>
    Completed,

    /// <summary>
    /// The topic is empty. Unambiguous only because the topic has one partition and the deployment
    /// one replica — a consumer reads only what is assigned to it, so at any other scale this would
    /// be a drained assignment reported as a drained topic. See §6 of the design.
    /// </summary>
    Drained,

    /// <summary>
    /// A transient fault. Offsets committed up to the last good record and nothing beyond, so the
    /// next dispatch resumes there. Not a business failure: the step succeeds with a partial count.
    /// </summary>
    Faulted,
}
