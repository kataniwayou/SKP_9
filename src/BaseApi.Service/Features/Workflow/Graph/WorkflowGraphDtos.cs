using System.Text.Json;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// The body of <c>PUT /workflows/{id}/graph</c>. Ids for a new workflow and new steps are generated
/// by the client, so the request can wire a new step to another new step before either exists.
/// </summary>
/// <param name="Workflow">The workflow fields, with the <c>UpdatedAt</c> the client loaded (null when creating).</param>
/// <param name="Steps">Only the new or changed steps; an untouched step is not sent.</param>
/// <param name="Assignments">At most one intent per step: a payload to set, or null to remove.</param>
/// <param name="SchemaEdits">Processor slot edits: a new definition, or null to clear the slot.</param>
/// <param name="Layout">The canvas layout; null leaves the stored layout unchanged.</param>
public sealed record GraphSaveRequest(
    GraphWorkflowDto Workflow,
    List<GraphStepDto>? Steps,
    List<GraphAssignmentIntent>? Assignments,
    List<GraphSchemaEdit>? SchemaEdits,
    JsonElement? Layout);

/// <summary>The workflow's own fields. Assignment ids are absent: the server derives them from the intents.</summary>
public sealed record GraphWorkflowDto(
    string Name,
    string Version,
    string? Description,
    string? CronExpression,
    DateTime? UpdatedAt,
    List<Guid> EntryStepIds,
    List<Guid>? CacheIds);

/// <summary>A new or changed step. <c>UpdatedAt</c> is null for a new step and the loaded value for a changed one.</summary>
public sealed record GraphStepDto(
    Guid Id,
    DateTime? UpdatedAt,
    string Name,
    string Version,
    string? Description,
    Guid ProcessorId,
    List<Guid>? NextStepIds,
    StepEntryCondition EntryCondition);

/// <summary>Set (<c>Payload</c> non-null) or remove (<c>Payload</c> null) this workflow's assignment for one step.</summary>
public sealed record GraphAssignmentIntent(Guid StepId, string? Payload);

/// <summary>
/// Replace one processor schema slot. <c>Slot</c> is <c>input</c>, <c>output</c> or <c>config</c>.
/// A non-null <c>Definition</c> always becomes a new schema row, because a referenced schema's
/// definition is frozen; null clears the slot.
/// </summary>
public sealed record GraphSchemaEdit(Guid ProcessorId, string Slot, string? Definition);

/// <summary>
/// A workflow's graph as the editor loads it: the workflow, every step reachable from its entry
/// steps, their processors and schemas, the workflow's assignments and caches, and its layout.
/// Parked steps (placed but unwired) are not reachable, so they are not here; the editor reads their
/// ids from the layout and fetches them through <c>GET /steps/{id}</c>.
/// </summary>
public sealed record WorkflowGraphDto(
    WorkflowReadDto Workflow,
    List<StepReadDto> Steps,
    List<ProcessorReadDto> Processors,
    List<SchemaReadDto> Schemas,
    List<AssignmentReadDto> Assignments,
    List<CacheReadDto> Caches,
    JsonElement? Layout);

/// <summary>The workflow's new <c>UpdatedAt</c> after a layout save, for the editor's next graph save.</summary>
public sealed record LayoutSavedDto(DateTime UpdatedAt);
