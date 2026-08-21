namespace Messaging.Contracts;

/// <summary>
/// Single source of truth for the <c>type</c> discriminator carried in the AMQP
/// <c>BasicProperties.Type</c> header, which is how a consumer decides what a body deserializes to.
/// <para>
/// <b>Why a header and not a wrapper record:</b> the discriminator has to be readable without
/// deserializing the body, because a body that fails to parse must still be classifiable — an
/// unknown or absent type is a deterministic fault that parks on the first try, and that decision is
/// made before any parse is attempted. A wrapper would invert that ordering.
/// </para>
/// <para>
/// These are <b>wire values</b>. Renaming one is a breaking change to every producer and consumer not
/// redeployed in the same step, so they are deliberately short literals rather than <c>nameof</c>
/// expressions — a type rename must not silently become a protocol change.
/// </para>
/// </summary>
public static class MessageTypes
{
    /// <summary>Body is a <see cref="Messaging.Contracts.StartOrchestration"/>.</summary>
    public const string StartOrchestration = "start-orchestration";

    /// <summary>Body is a <see cref="Messaging.Contracts.StopOrchestration"/>.</summary>
    public const string StopOrchestration = "stop-orchestration";

    /// <summary>Request body is a <see cref="Messaging.Contracts.GetProcessorBySourceHash"/>.</summary>
    public const string GetProcessorBySourceHash = "get-processor-by-source-hash";

    /// <summary>Reply body is a <see cref="Messaging.Contracts.ProcessorIdentityFound"/>.</summary>
    public const string ProcessorIdentityFound = "processor-identity-found";

    /// <summary>Reply body is a <see cref="Messaging.Contracts.ProcessorIdentityNotFound"/>.</summary>
    public const string ProcessorIdentityNotFound = "processor-identity-not-found";

    /// <summary>Request body is a <see cref="Messaging.Contracts.GetSchemaDefinition"/>.</summary>
    public const string GetSchemaDefinition = "get-schema-definition";

    /// <summary>Reply body is a <see cref="Messaging.Contracts.SchemaDefinitionFound"/>.</summary>
    public const string SchemaDefinitionFound = "schema-definition-found";

    /// <summary>Reply body is a <see cref="Messaging.Contracts.SchemaDefinitionNotFound"/>.</summary>
    public const string SchemaDefinitionNotFound = "schema-definition-not-found";

    /// <summary>Reply body is a <see cref="Messaging.Contracts.MalformedRequest"/>.</summary>
    public const string MalformedRequest = "malformed-request";

    /// <summary>Body is a <see cref="Messaging.Contracts.ProcessDispatch"/>.</summary>
    public const string ProcessDispatch = "process-dispatch";

    /// <summary>Body is a <see cref="Messaging.Contracts.ProcessedData"/>.</summary>
    public const string ProcessedData = "processed-data";

    /// <summary>
    /// Body is a <see cref="Messaging.Contracts.StepOutcome"/> — one type for all three terminals,
    /// which is why the discriminator rides the body rather than this header. A header-level split
    /// would put the orchestrator's advancement decision in the consumer's handler-resolution table,
    /// where it cannot be compared against a successor's entry condition without being mapped back.
    /// </summary>
    public const string StepOutcome = "step-outcome";

    /// <summary>Body is a <see cref="Messaging.Contracts.NextStepHandoff"/>.</summary>
    public const string NextStepHandoff = "next-step-handoff";

    /// <summary>Announcement: the API has projected a workflow into L2.</summary>
    public const string OrchestrationStarted = "orchestration-started";

    /// <summary>Announcement: the API has removed a workflow from L2.</summary>
    public const string OrchestrationStopped = "orchestration-stopped";
}
