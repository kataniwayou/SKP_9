namespace Messaging.Contracts.Projections;

/// <summary>
/// Single source of truth for the per-schema liveness summary outcome (STATE-02 / D-02).
/// Mirrors the LivenessStatus / L2ProjectionKeys / OrchestratorQueues static-const SoT shape —
/// one const both the (Phase-60) writer and (Phase-61) reader consume so they cannot desync.
/// Consumed by LivenessSummary's fields and by ProcessorLivenessEntry.Create's invariant.
/// </summary>
public static class SchemaOutcome
{
    public const string Success = "SUCCESS";
    public const string Fail = "FAIL";
}
