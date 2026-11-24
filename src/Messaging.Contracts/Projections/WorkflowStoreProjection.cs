using System.Text.Json.Serialization;

namespace Messaging.Contracts.Projections;

/// <summary>
/// The <c>store</c> field of <c>skp:wf:{id}</c>: the flattened L1 structure a start validated and
/// wrote. The orchestrator builds its L1 entry from this one value — there are no per-step keys to
/// read, so there is no torn projection to survive.
/// <para>
/// <b>There is no workflow cron.</b> The schedule is <see cref="EntryCrons"/> alone: an entry step not
/// listed there is unscheduled. A store written while workflows still had a cron holds a top-level
/// <c>cron</c> field; it is not mapped, so it is ignored on read and schedules nothing.
/// </para>
/// </summary>
public sealed record WorkflowStoreProjection(
    [property: JsonPropertyName("entryStepIds")] List<Guid> EntryStepIds,
    [property: JsonPropertyName("steps")]        List<StepL1> Steps,
    [property: JsonPropertyName("entryCrons")]   Dictionary<Guid, string>? EntryCrons = null);
