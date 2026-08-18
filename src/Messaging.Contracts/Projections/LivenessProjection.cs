using System.Text.Json.Serialization;

namespace Messaging.Contracts.Projections;

/// <summary>
/// L2 liveness sub-document nested inside the workflow root projection.
/// The <c>[property: ...]</c> attribute target is load-bearing: on a positional record a bare
/// <c>[JsonPropertyName]</c> binds to the constructor parameter, which the serializer ignores.
/// </summary>
public sealed record LivenessProjection(
    [property: JsonPropertyName("timestamp")] DateTime Timestamp,
    [property: JsonPropertyName("interval")]  int Interval,
    [property: JsonPropertyName("status")]    string Status);
