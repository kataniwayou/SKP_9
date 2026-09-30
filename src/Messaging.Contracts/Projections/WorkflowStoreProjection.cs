using System.Text.Json.Serialization;

namespace Messaging.Contracts.Projections;

/// <summary>
/// The <c>store</c> field of <c>skp:wf:{id}</c>: the flattened L1 structure a start validated and
/// wrote. The orchestrator builds its L1 entry from this one value — there are no per-step keys to
/// read, so there is no torn projection to survive.
/// </summary>
public sealed record WorkflowStoreProjection(
    [property: JsonPropertyName("entryStepIds")] List<Guid> EntryStepIds,
    [property: JsonPropertyName("cron")]         string? Cron,
    [property: JsonPropertyName("steps")]        List<StepL1> Steps);
