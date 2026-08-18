using System.Text.Json.Serialization;

namespace Messaging.Contracts.Projections;

/// <summary>
/// Reader-consumable L2 per-step projection for the <c>{prefix}{workflowId}:{stepId}</c> key, so a
/// consumer that references only this leaf can deserialize step values.
/// <para>
/// EntryCondition is typed <c>int</c> rather than the writer's enum. No string-enum converter is
/// registered anywhere, so the enum serializes as its underlying int and the two records stay
/// byte-identical on the wire. The <c>[property: ...]</c> attribute targets are load-bearing: on a
/// positional record a bare attribute binds to the constructor parameter, which the serializer
/// ignores.
/// </para>
/// </summary>
public sealed record StepProjection(
    [property: JsonPropertyName("entryCondition")] int EntryCondition,
    [property: JsonPropertyName("processorId")]    Guid ProcessorId,
    [property: JsonPropertyName("payload")]        string Payload,
    [property: JsonPropertyName("nextStepIds")]    List<Guid> NextStepIds);
