using BaseProcessor.Core.Configuration;

namespace Processor.EmsExporter;

/// <summary>
/// The step payload, flat: two scalars and no nesting, the same shape as <c>KafkaExporterConfig</c>
/// with the topic replaced by a queue. The framework binds it case-insensitively and ignores unknown
/// properties, so <c>{"queue":"skp.exports","deliveryTimeoutSeconds":30}</c> binds.
/// <para>
/// <b>There is no server URL and no credential here</b>, for the reason <c>KafkaExporterConfig</c>
/// gives about the broker list: the EMS server is org infrastructure and the credential that
/// authenticates to it must not sit in plaintext <c>jsonb</c>. Both arrive from configuration as
/// <c>Ems__ServerUrl</c>, <c>Ems__Username</c> and <c>Ems__Password</c>. See
/// <see cref="Ems.EmsServerOptions"/>.
/// </para>
/// <para>
/// <b>A queue, never a topic.</b> A topic publish succeeds with no subscriber listening, which would
/// report Completed for a message nobody received. Topics are out of scope until something needs one.
/// </para>
/// </summary>
public sealed record EmsExporterConfig(
    string Queue,
    int DeliveryTimeoutSeconds) : ProcessorConfig;
