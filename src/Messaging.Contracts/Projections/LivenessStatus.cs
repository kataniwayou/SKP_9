namespace Messaging.Contracts.Projections;

/// <summary>
/// Single source of truth for the liveness status value. The processor writes it and every reader
/// consumes this one const, so they cannot desynchronize. Used by
/// <see cref="LivenessProjection"/>'s and <see cref="ProcessorLivenessEntry"/>'s status field.
/// </summary>
public static class LivenessStatus
{
    public const string Healthy = "Healthy";
    public const string Unhealthy = "Unhealthy";
}
